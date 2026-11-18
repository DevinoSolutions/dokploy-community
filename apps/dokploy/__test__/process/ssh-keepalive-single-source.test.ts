import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// T-12705: a build server under load (load 25) answered SSH pings too slowly
// for a 10 s x 3 keepalive and failed a production deploy with "SSH connection
// error: Keepalive timeout". Every ssh2 connection the fork opens now takes the
// same tolerant setting from one constant, so the numbers cannot drift apart
// again (there were two: 15 s x 8 on the log stream, 10 s x 3 everywhere else,
// and none at all on the setup, validate, audit, terminal, log and SFTP paths).

const repoRoot = resolve(__dirname, "../../../..");
const SOURCE_ROOTS = [
	join(repoRoot, "packages/server/src"),
	join(repoRoot, "apps/dokploy/server"),
	join(repoRoot, "apps/dokploy/pages"),
	join(repoRoot, "apps/dokploy/lib"),
	join(repoRoot, "apps/dokploy/utils"),
];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "__test__"]);
const SHARED = join(
	repoRoot,
	"packages/server/src/utils/process/ssh-keepalive.ts",
);

const sourceFiles = (dir: string): string[] => {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.flatMap((name) => {
		if (SKIP_DIRS.has(name)) return [];
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [path] : [];
	});
};

const files = SOURCE_ROOTS.flatMap(sourceFiles).map((path) => ({
	path,
	name: relative(repoRoot, path).split(sep).join("/"),
	text: readFileSync(path, "utf8"),
}));

describe("one SSH keepalive for every ssh2 connection", () => {
	it("is 15 s x 8 (about 2 minutes of silence before a host is treated as dead)", async () => {
		const { SSH_KEEPALIVE } = await import(
			"@dokploy/server/utils/process/ssh-keepalive"
		);
		expect(SSH_KEEPALIVE).toEqual({
			keepaliveInterval: 15_000,
			keepaliveCountMax: 8,
		});
	});

	it("is still exported from execAsync, as the same object", async () => {
		const shared = await import("@dokploy/server/utils/process/ssh-keepalive");
		const exec = await import("@dokploy/server/utils/process/execAsync");
		expect(exec.SSH_KEEPALIVE).toBe(shared.SSH_KEEPALIVE);
		expect("sshKeepalive" in exec).toBe(false);
	});

	it("scans the source tree (guards against an empty glob)", () => {
		expect(files.length).toBeGreaterThan(200);
		expect(files.some((file) => file.path === SHARED)).toBe(true);
	});

	it("defines the keepalive numbers in exactly one file", () => {
		const defining = files
			.filter((file) => /keepalive(Interval|CountMax)\s*[:=]/i.test(file.text))
			.map((file) => file.name);
		expect(defining).toEqual([
			"packages/server/src/utils/process/ssh-keepalive.ts",
		]);
	});

	it("gives every file that opens an ssh2 connection the shared constant", () => {
		const connecting = files.filter(
			(file) =>
				/from ["']ssh2["']/.test(file.text) &&
				/new Client\(/.test(file.text) &&
				/\.connect\(/.test(file.text),
		);
		// Setup, validate, audit, terminal x2, deployment log, container terminal,
		// container logs, SFTP upload, remote exec and the remote log stream.
		expect(connecting.map((file) => file.name).sort()).toEqual(
			[
				"apps/dokploy/server/wss/docker-container-logs.ts",
				"apps/dokploy/server/wss/docker-container-terminal.ts",
				"apps/dokploy/server/wss/listen-deployment.ts",
				"apps/dokploy/server/wss/terminal.ts",
				"packages/server/src/setup/server-audit.ts",
				"packages/server/src/setup/server-setup.ts",
				"packages/server/src/setup/server-validate.ts",
				"packages/server/src/utils/builders/drop.ts",
				"packages/server/src/utils/process/execAsync.ts",
				"packages/server/src/utils/process/remoteStream.ts",
			].sort(),
		);
		const without = connecting
			.filter((file) => !/\bSSH_KEEPALIVE\b/.test(file.text))
			.map((file) => file.name);
		expect(without).toEqual([]);
	});

	it("gives every connect call of those files the constant, not just the file", () => {
		const offenders: string[] = [];
		for (const file of files) {
			if (
				!/from ["']ssh2["']/.test(file.text) ||
				!/new Client\(/.test(file.text)
			)
				continue;
			// connect( ... ) argument blocks: a literal object must spread the constant,
			// and a named config (terminal.ts) must be built with it.
			const connectCalls = [
				...file.text.matchAll(/\.connect\(\s*\{([\s\S]*?)\}\s*\)/g),
			];
			for (const call of connectCalls) {
				if (!/\.\.\.SSH_KEEPALIVE/.test(call[1] ?? ""))
					offenders.push(file.name);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("gives the Docker API over SSH (dockerode) the constant too", () => {
		const sshDockerode = files.filter((file) =>
			/protocol:\s*["']ssh["']/.test(file.text),
		);
		expect(sshDockerode.map((file) => file.name)).toEqual([
			"packages/server/src/utils/servers/remote-docker.ts",
		]);
		for (const file of sshDockerode) {
			expect(file.text).toMatch(/\.\.\.SSH_KEEPALIVE/);
		}
	});
});
