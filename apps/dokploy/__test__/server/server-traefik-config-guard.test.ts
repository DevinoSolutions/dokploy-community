import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createServerTraefikConfig,
	getDefaultServerTraefikConfig,
} from "@dokploy/server";
import { afterEach, describe, expect, it } from "vitest";

// Fork checks on top of upstream #5764 (T-7820): repairing a Swarm worker's
// traefik.yml only restarts the existing container (same image, no pull, no
// recreate), and every write stays inside the traefik directory.

const WORKER = "active false";

const sandboxes: string[] = [];

afterEach(() => {
	for (const dir of sandboxes.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Symbolic links need privileges on Windows; the CI runners have them.
const canLink = (() => {
	const probe = mkdtempSync(path.join(tmpdir(), "dokploy-link-probe-"));
	try {
		symlinkSync(probe, path.join(probe, "l"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

const setUp = () => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-traefik-guard-"));
	sandboxes.push(dir);
	const binDir = path.join(dir, "bin");
	const dockerLog = path.join(dir, "docker.log");
	const traefikDir = path.join(dir, "traefik");
	const outside = path.join(dir, "outside");
	mkdirSync(binDir);
	mkdirSync(path.join(traefikDir, "dynamic"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(
		path.join(binDir, "docker"),
		`#!/bin/sh
echo "$*" >> "${dockerLog}"
if [ "$1" = "info" ]; then echo "${WORKER}"; fi
exit 0
`,
	);
	chmodSync(path.join(binDir, "docker"), 0o755);
	const run = () =>
		execFileSync(
			"bash",
			["-c", `set -e; SUDO_CMD=""; ${createServerTraefikConfig(traefikDir)}`],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
			},
		);
	const dockerCalls = () =>
		existsSync(dockerLog)
			? readFileSync(dockerLog, "utf8").trim().split("\n")
			: [];
	return {
		traefikDir,
		outside,
		configPath: path.join(traefikDir, "traefik.yml"),
		run,
		dockerCalls,
	};
};

const managerConfig = () => `${getDefaultServerTraefikConfig()}\n`;

describe("Swarm worker Traefik repair (fork guard)", () => {
	it("only restarts the existing container: no pull, no recreate", () => {
		const { configPath, run, dockerCalls } = setUp();
		writeFileSync(configPath, managerConfig());

		run();

		const calls = dockerCalls().filter((call) => !call.startsWith("info"));
		expect(calls).toEqual([
			"inspect dokploy-traefik",
			"restart dokploy-traefik",
		]);
	});

	it("keeps its lock file inside the traefik directory", () => {
		const { traefikDir, configPath, run } = setUp();
		writeFileSync(configPath, managerConfig());

		run();

		expect(existsSync(path.join(traefikDir, ".traefik-config.lock"))).toBe(
			true,
		);
	});

	it.skipIf(!canLink)(
		"writes a new backup instead of writing through an old linked one",
		() => {
			const { configPath, outside, run } = setUp();
			const original = managerConfig();
			writeFileSync(configPath, original);
			const elsewhere = path.join(outside, "file");
			writeFileSync(elsewhere, "unchanged\n");
			symlinkSync(elsewhere, `${configPath}.bak`, "file");

			run();

			expect(readFileSync(elsewhere, "utf8")).toBe("unchanged\n");
			expect(lstatSync(`${configPath}.bak`).isSymbolicLink()).toBe(false);
			expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
		},
	);

	it.skipIf(!canLink)("leaves a linked traefik.yml alone and warns", () => {
		const { configPath, outside, run, dockerCalls } = setUp();
		const elsewhere = path.join(outside, "traefik.yml");
		writeFileSync(elsewhere, managerConfig());
		symlinkSync(elsewhere, configPath, "file");

		const output = run();

		expect(output).toContain("is a symbolic link, so it is not rewritten");
		expect(readFileSync(elsewhere, "utf8")).toBe(managerConfig());
		expect(existsSync(`${configPath}.bak`)).toBe(false);
		expect(dockerCalls().some((call) => call.startsWith("restart"))).toBe(
			false,
		);
	});
});
