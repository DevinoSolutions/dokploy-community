import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The `-f` override files of a custom command are evaluated by the
// restricted-compose audit (T-7455). Like the compose file (T-7857), a file
// that is, or goes through, a link out of the checkout is not read, so its
// text cannot reach the findings or the deployment log (T-8413).

// Each real-shell case starts a few shells, which is slow on Windows.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	appendLogLine: vi.fn().mockResolvedValue(undefined),
	evaluateComposePolicy: vi.fn(),
	base: { local: "", remote: "" },
}));

vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual, ...actual.posix, default: actual.posix };
});
vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: (isServer = false) => ({
			...actual.paths(true),
			COMPOSE_PATH: isServer ? mocks.base.remote : mocks.base.local,
		}),
	};
});
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return { ...actual, appendLogLine: mocks.appendLogLine };
});
vi.mock("@dokploy/server/utils/compose-policy/evaluate", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/compose-policy/evaluate")
	>("@dokploy/server/utils/compose-policy/evaluate");
	mocks.evaluateComposePolicy.mockImplementation(actual.evaluateComposePolicy);
	return { ...actual, evaluateComposePolicy: mocks.evaluateComposePolicy };
});
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { db } from "@dokploy/server/db";
import { runComposePolicyAudit } from "@dokploy/server/services/compose-policy-audit";
import { COMPOSE_FILE_LINK_MARKER } from "@dokploy/server/utils/compose-file-guard";
import {
	boundedSh,
	boundedShellAvailable,
	makeTempDir,
} from "./helpers/bounded-shell";

const APP = "audit-link-app";
const SPEC = "services:\n  web:\n    image: nginx\n";
const OVERRIDE = "services:\n  web:\n    privileged: true\n";
const OUTSIDE_TEXT =
	"services:\n  web:\n    privileged: true\n    image: leaked-host-file\n";

const shells = boundedShellAvailable ? ["sh"] : [];
const tempBase = () =>
	(process.platform === "win32" ? process.cwd() : tmpdir()).replaceAll(
		"\\",
		"/",
	);
// The same directory as a POSIX shell names it (`/c/...` for Git Bash).
const shellPath = (path: string) =>
	process.platform === "win32"
		? path.replace(
				/^([A-Za-z]):/,
				(_, drive: string) => `/${drive.toLowerCase()}`,
			)
		: path;

// The links have to be real: a file link needs a privilege on Windows, and Git
// Bash does not always see it as one. The cases below run where both work
// (Linux, macOS), and are skipped elsewhere.
const linksWork = (() => {
	if (shells.length === 0) return false;
	const probe = makeTempDir(`${tempBase()}/.dokploy-link-probe-`).replaceAll(
		"\\",
		"/",
	);
	try {
		mkdirSync(`${probe}/dir`);
		writeFileSync(`${probe}/dir/file`, "x");
		symlinkSync(`${probe}/dir/file`, `${probe}/file-link`, "file");
		symlinkSync(`${probe}/dir`, `${probe}/dir-link`, "junction");
		const result = boundedSh(
			[
				"-c",
				'[ -L "$1/file-link" ] && [ -L "$1/dir-link" ] && [ "$(cd -P "$1/dir-link" && pwd -P)" = "$(cd -P "$1/dir" && pwd -P)" ]',
				"sh",
				probe,
			],
			{ encoding: "utf8" },
		);
		return result.status === 0;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();
const itWithLinks = it.skipIf(!linksWork);

// A FIFO has to be a real one: the cases run where `mkfifo` makes a file the
// shell sees as a pipe (Git Bash does; Node on Windows does not see it as one,
// so the local read is tested on Linux and macOS only).
const fifosWork = (() => {
	if (shells.length === 0) return false;
	const probe = makeTempDir(`${tempBase()}/.dokploy-fifo-probe-`).replaceAll(
		"\\",
		"/",
	);
	try {
		return (
			spawnSync("mkfifo", [`${probe}/fifo`]).status === 0 &&
			boundedSh(["-c", '[ -p "$1/fifo" ]', "sh", probe], { encoding: "utf8" })
				.status === 0
		);
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();
const itWithFifos = (remote: boolean) =>
	it.skipIf(!fifosWork || (!remote && process.platform === "win32"));

let tmp = "";
const code = () => `${tmp}/compose/${APP}/code`;
const outside = () => `${tmp}/outside`;

// A file link is relative, as a checkout brings it; a directory link
// (a junction on Windows) has to be absolute.
const link = (target: string, name: string, type: "file" | "junction") => {
	const place = `${code()}/${name}`;
	symlinkSync(
		type === "file" ? relative(dirname(place), target) : target,
		place,
		type,
	);
};

// A remote host that is the local shell.
const runInShell = async (_serverId: string, command: string) => {
	// A read that blocks (a FIFO) must fail the test, not hang it.
	const result = boundedSh(["-c", command], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status !== 0) {
		throw new Error(`exit ${result.status}: ${result.stderr}`);
	}
	return { stdout: result.stdout, stderr: result.stderr };
};

// A host that answers the reads with `read` and the resolution of the paths
// against the own directory (T-7845) for real, with the local shell.
const answerReads = (read: string) =>
	mocks.execAsyncRemote.mockImplementation(
		async (serverId: string, command: string) =>
			command.includes("__dokploy_verdict")
				? runInShell(serverId, command)
				: { stdout: read, stderr: "" },
	);

// The guarded read of an override file, which is not the resolution command.
const readCommand = () =>
	(mocks.execAsyncRemote.mock.calls as [string, string][])
		.map(([, command]) => command)
		.find((command) => !command.includes("__dokploy_verdict")) as string;

const entity = (file: string, serverId: string | null) =>
	({
		composeId: "compose-1",
		appName: APP,
		composeType: "docker-compose",
		composePath: "./docker-compose.yml",
		composeFile: SPEC,
		sourceType: "raw",
		serverId,
		command: `compose -p ${APP} -f docker-compose.yml -f ${file} up -d`,
		domains: [],
		environment: { project: { organizationId: "org-1" } },
	}) as unknown as Parameters<typeof runComposePolicyAudit>[0];

const deployment = { deploymentId: "dep-1", logPath: "/var/log/dep-1.log" };

// What the audit handed the evaluation, and what it wrote to the log.
const audit = async (file: string, serverId: string | null) => {
	await runComposePolicyAudit(entity(file, serverId), deployment);
	expect(mocks.evaluateComposePolicy).toHaveBeenCalledTimes(1);
	const [{ overrides }] = mocks.evaluateComposePolicy.mock.calls[0] as [
		{ overrides: string[] },
	];
	const log = mocks.appendLogLine.mock.calls
		.map((call) => String(call[2]))
		.join("\n");
	return { overrides, log };
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsyncRemote.mockImplementation(runInShell);
	mocks.appendLogLine.mockResolvedValue(undefined);
	vi.mocked(db.query.organization.findFirst).mockResolvedValue({
		restrictedComposeAudit: true,
		restrictedComposeAuditExclusions: [],
	} as never);
	vi.mocked(db.insert).mockImplementation((() => ({
		values: vi.fn().mockResolvedValue(undefined),
	})) as never);
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = makeTempDir(`${tempBase()}/.dokploy-audit-`).replaceAll("\\", "/");
	mocks.base.local = `${tmp}/compose`;
	mocks.base.remote = `${shellPath(tmp)}/compose`;
	mkdirSync(`${code()}/deploy`, { recursive: true });
	mkdirSync(outside(), { recursive: true });
	writeFileSync(`${outside()}/override.yml`, OUTSIDE_TEXT);
});
afterAll(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("an override file read by the audit on a remote host", () => {
	it("goes through the guarded read, and a link out is not evaluated", async () => {
		answerReads(COMPOSE_FILE_LINK_MARKER);
		const { overrides, log } = await audit("override.yml", "srv-1");
		const command = readCommand();
		expect(command).toContain(
			`__dokploy_inside ${mocks.base.remote}/${APP}/code ${mocks.base.remote}/${APP}/code/override.yml`,
		);
		// The files directory of the compose is the second place.
		expect(command).toContain(
			`__dokploy_inside ${mocks.base.remote}/${APP}/files ${mocks.base.remote}/${APP}/code/override.yml`,
		);
		// The size cap of the compose file read applies to it too, and only a
		// regular file is read.
		expect(command).toContain(
			`[ -f ${mocks.base.remote}/${APP}/code/override.yml ] && head -c 524289`,
		);
		expect(overrides).toEqual([]);
		expect(log).not.toContain(COMPOSE_FILE_LINK_MARKER);
	});

	it("still evaluates an ordinary override file", async () => {
		answerReads(OVERRIDE);
		const { overrides, log } = await audit("override.yml", "srv-1");
		expect(overrides).toEqual([OVERRIDE]);
		expect(log).toContain("rule=host-privilege");
	});
});

describe.each([
	["a remote host", "srv-1"],
	["this host", null],
] as const)("on %s, with real links", (_name, serverId) => {
	itWithLinks(
		"does not evaluate an override file that is a link out",
		async () => {
			link(`${outside()}/override.yml`, "override.yml", "file");
			const { overrides, log } = await audit("override.yml", serverId);
			expect(overrides).toEqual([]);
			expect(log).not.toContain("leaked-host-file");
		},
	);

	itWithLinks(
		"does not evaluate an override file in a directory that links out",
		async () => {
			rmSync(`${code()}/deploy`, { recursive: true, force: true });
			link(outside(), "deploy", "junction");
			const { overrides } = await audit("deploy/override.yml", serverId);
			expect(overrides).toEqual([]);
		},
	);

	itWithLinks(
		"evaluates an override file, and a link to a file of the checkout",
		async () => {
			writeFileSync(`${code()}/real.yml`, OVERRIDE);
			link(`${code()}/real.yml`, "override.yml", "file");
			expect((await audit("real.yml", serverId)).overrides).toEqual([OVERRIDE]);
			vi.clearAllMocks();
			expect((await audit("override.yml", serverId)).overrides).toEqual([
				OVERRIDE,
			]);
		},
	);

	it("evaluates an override file of the files directory of the compose", async () => {
		// Where Dokploy writes the file mounts, reached as `../files/...`.
		mkdirSync(`${code()}/../files`, { recursive: true });
		writeFileSync(`${code()}/../files/override.yml`, OVERRIDE);
		expect((await audit("../files/override.yml", serverId)).overrides).toEqual([
			OVERRIDE,
		]);
	});

	itWithLinks(
		"does not evaluate an override file of the files directory that is a link out",
		async () => {
			mkdirSync(`${code()}/../files`, { recursive: true });
			const place = `${code()}/../files/override.yml`;
			symlinkSync(
				relative(dirname(place), `${outside()}/override.yml`),
				place,
				"file",
			);
			const { overrides, log } = await audit("../files/override.yml", serverId);
			expect(overrides).toEqual([]);
			expect(log).not.toContain("leaked-host-file");
		},
	);

	it("does not evaluate an override file in the project directory, beside code/ and files/", async () => {
		writeFileSync(`${code()}/../override.yml`, OVERRIDE);
		expect((await audit("../override.yml", serverId)).overrides).toEqual([]);
	});

	it("does not evaluate an existing file when the code directory is not there", async () => {
		// The remote guard needs the directory to exist; this host agrees.
		writeFileSync(`${code()}/../override.yml`, OVERRIDE);
		rmSync(code(), { recursive: true, force: true });
		expect((await audit("../override.yml", serverId)).overrides).toEqual([]);
	});

	// T-7845: the audit applies the own-directory check of the deploy before it
	// reads, skips what is outside, and says so in the log.
	describe("a file outside the compose's own directory", () => {
		const OTHER = "other-app";
		const otherOverride = () => `${tmp}/compose/${OTHER}/code/override.yml`;
		const skipped =
			/\[restricted-compose audit\] skipped: 1 override file\(s\)/;

		beforeEach(() => {
			mkdirSync(`${tmp}/compose/${OTHER}/code`, { recursive: true });
			writeFileSync(otherOverride(), OUTSIDE_TEXT);
		});

		it("is skipped, and the log says so", async () => {
			const { overrides, log } = await audit(
				`../../${OTHER}/code/override.yml`,
				serverId,
			);
			expect(overrides).toEqual([]);
			expect(log).toMatch(skipped);
			expect(log).toContain("deployment=dep-1");
			// Nothing of it, not even its name, reaches the log.
			expect(log).not.toContain("leaked-host-file");
			expect(log).not.toContain(OTHER);
			// The shell host is only asked for what is inside.
			expect(
				mocks.execAsyncRemote.mock.calls.some(
					([, command]) =>
						String(command).includes(`${OTHER}/code/override.yml`) &&
						!String(command).includes("__dokploy_verdict"),
				),
			).toBe(false);
		});

		it("is skipped when it is an absolute path of another compose", async () => {
			const absolute = `${(serverId ? mocks.base.remote : mocks.base.local).replace(/^[A-Za-z]:/, "")}/${OTHER}/code/override.yml`;
			const { overrides, log } = await audit(absolute, serverId);
			expect(overrides).toEqual([]);
			expect(log).toMatch(skipped);
		});

		itWithLinks("is skipped behind a link of the checkout", async () => {
			link(`${tmp}/compose/${OTHER}/code`, "elsewhere", "junction");
			const { overrides, log } = await audit(
				"elsewhere/override.yml",
				serverId,
			);
			expect(overrides).toEqual([]);
			expect(log).toMatch(skipped);
			expect(log).not.toContain("leaked-host-file");
		});

		it("does not stop the files that are inside from being read", async () => {
			writeFileSync(`${code()}/real.yml`, OVERRIDE);
			await runComposePolicyAudit(
				{
					...entity("real.yml", serverId),
					command: `compose -p ${APP} -f docker-compose.yml -f ../../${OTHER}/code/override.yml -f real.yml up -d`,
				} as never,
				deployment,
			);
			const [{ overrides }] = mocks.evaluateComposePolicy.mock.calls[0] as [
				{ overrides: string[] },
			];
			expect(overrides).toEqual([OVERRIDE]);
			expect(
				mocks.appendLogLine.mock.calls
					.map((call) => String(call[2]))
					.join("\n"),
			).toMatch(skipped);
		});

		it("is not mentioned when every file is inside", async () => {
			writeFileSync(`${code()}/real.yml`, OVERRIDE);
			const { overrides, log } = await audit("real.yml", serverId);
			expect(overrides).toEqual([OVERRIDE]);
			expect(log).not.toContain("skipped");
		});
	});

	itWithFifos(!!serverId)(
		"does not wait on an override file that is a FIFO",
		async () => {
			expect(spawnSync("mkfifo", [`${code()}/override.yml`]).status).toBe(0);
			const started = Date.now();
			expect((await audit("override.yml", serverId)).overrides).toEqual([]);
			// Not read at all, rather than given up on after a time limit.
			expect(Date.now() - started).toBeLessThan(5000);
		},
	);
});
