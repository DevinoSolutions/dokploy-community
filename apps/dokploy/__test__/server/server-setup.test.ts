import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	defaultCommand,
	installRClone,
	reportDockerVersion,
	runRemoteInstaller,
} from "@dokploy/server";
import { describe, expect, it } from "vitest";

const resolveBin = (name: string) =>
	execSync(`command -v ${name}`, { encoding: "utf8" }).trim();

/**
 * Build a sandbox PATH so `command -v docker` only sees our fake docker
 * binary (or nothing), regardless of what the host has installed.
 */
const makeSandbox = (dockerShim?: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-server-setup-"));
	for (const tool of ["awk", "tr"]) {
		const shim = path.join(dir, tool);
		writeFileSync(shim, `#!/bin/sh\nexec ${resolveBin(tool)} "$@"\n`);
		chmodSync(shim, 0o755);
	}
	if (dockerShim) {
		const shim = path.join(dir, "docker");
		writeFileSync(shim, dockerShim);
		chmodSync(shim, 0o755);
	}
	return dir;
};

const runReport = (sandboxPath: string) => {
	const script = [
		"DOCKER_VERSION=28.5.0",
		reportDockerVersion(),
		'echo "$DOCKER_VERSION_REPORT"',
	].join("\n");
	return execFileSync(resolveBin("bash"), ["-c", script], {
		encoding: "utf8",
		env: { ...process.env, PATH: sandboxPath },
	})
		.trim()
		.split("\n")
		.pop();
};

describe("reportDockerVersion", () => {
	it("reports the engine version when docker and its daemon are available", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'	echo "Docker version 25.0.0, build aaaaaaa"',
				"	exit 0",
				"fi",
				'if [ "$1" = "version" ]; then',
				'	echo "29.4.3"',
				"	exit 0",
				"fi",
				"exit 1",
			].join("\n"),
		);
		expect(runReport(sandbox)).toBe("29.4.3 (already installed)");
	});

	it("falls back to the client version when the daemon is unreachable", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'	echo "Docker version 29.4.3, build 055a478"',
				"	exit 0",
				"fi",
				'echo "Cannot connect to the Docker daemon" >&2',
				"exit 1",
			].join("\n"),
		);
		expect(runReport(sandbox)).toBe("29.4.3 (already installed)");
	});

	it("reports the pinned version to be installed when docker is missing", () => {
		expect(runReport(makeSandbox())).toBe("28.5.0 (will be installed)");
	});
});

describe("defaultCommand", () => {
	it.each([false, true])(
		"prints the detected Docker version in the setup banner (isBuildServer=%s)",
		(isBuildServer) => {
			const script = defaultCommand(isBuildServer);
			expect(script).toContain(reportDockerVersion());
			expect(script).toContain(
				'echo "| Docker            | $DOCKER_VERSION_REPORT"',
			);
			expect(script).not.toContain(
				'echo "| Docker            | $DOCKER_VERSION"',
			);
		},
	);
});

describe("unsupported operating systems", () => {
	it("exit non-zero instead of reporting a successful setup", () => {
		const script = defaultCommand(false);
		const branches = script.match(
			/This script only supports[^\n]*\n\s*(exit[^\n]*)\n/g,
		);
		expect(branches).toHaveLength(2);
		for (const branch of branches ?? []) {
			expect(branch).toMatch(/\n\s*exit 1\n$/);
		}
	});
});

/** The part of the setup script between a step's opening `if` and its closing `fi`. */
const installerStep = (script: string, tool: string) => {
	const start = script.indexOf(`if command_exists ${tool}; then`);
	const end = script.indexOf("\n\tfi\n", start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return script.slice(start, end + "\n\tfi\n".length);
};

/**
 * Run an installer step with a fake curl that either fails or serves an
 * installer, so nothing is downloaded or installed. The served installer leaves
 * a marker, prints the version variables it sees and can be made to fail.
 */
const runInstaller = (
	step: string,
	curl: "fails" | "serves" | "serves-failing",
	{ sudoCmd = "" }: { sudoCmd?: string } = {},
) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-installer-"));
	const tmp = mkdtempSync(path.join(tmpdir(), "dokploy-installer-tmp-"));
	const marker = path.join(dir, "installer-ran");
	const fixture = path.join(dir, "installer.sh");
	const shim = path.join(dir, "curl");
	writeFileSync(
		fixture,
		[
			`echo ran > "${marker.replaceAll(path.sep, "/")}"`,
			'echo "versions: $NIXPACKS_VERSION $RAILPACK_VERSION"',
			curl === "serves-failing" ? "exit 7" : "",
			"",
		].join("\n"),
	);
	writeFileSync(
		shim,
		curl === "fails"
			? "#!/bin/sh\necho 'curl: (22) The requested URL returned error: 404' >&2\nexit 22\n"
			: [
					"#!/bin/sh",
					'while [ "$#" -gt 0 ]; do',
					'	if [ "$1" = "-o" ]; then OUT="$2"; fi',
					"	shift",
					"done",
					`cp "${fixture.replaceAll(path.sep, "/")}" "$OUT"`,
					"",
				].join("\n"),
	);
	chmodSync(shim, 0o755);
	const script = [
		"set -e",
		`SUDO_CMD=${sudoCmd}`,
		// The tool is never installed here, whatever the machine running the test has.
		"command_exists() { return 1; }",
		runRemoteInstaller,
		step,
		'echo "step finished"',
	].join("\n");
	const result = spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: [dir, process.env.PATH].join(path.delimiter),
			TMPDIR: tmp.replaceAll(path.sep, "/"),
		},
	});
	return {
		...result,
		installerRan: existsSync(marker),
		leftoverFiles: readdirSync(tmp),
	};
};

describe("installers downloaded by the setup script", () => {
	const script = defaultCommand(false);
	const steps = {
		RClone: installRClone(),
		Nixpacks: installerStep(script, "nixpacks"),
		Railpack: installerStep(script, "railpack"),
	};

	it("defines the download helper once and uses it for every installer", () => {
		expect(script.split("run_remote_installer() {")).toHaveLength(2);
		expect(runRemoteInstaller).toContain("curl -fsSL");
		expect(runRemoteInstaller).not.toMatch(/curl[^\n]*\|/);
		expect(runRemoteInstaller).not.toContain("bash -c");
		for (const step of Object.values(steps)) {
			expect(step).toContain("run_remote_installer");
			expect(step).not.toContain("curl");
		}
	});

	it.each(Object.entries(steps))(
		"%s fails the step when the download fails",
		(tool, step) => {
			const result = runInstaller(step, "fails");
			expect(result.status).toBe(1);
			expect(result.installerRan).toBe(false);
			expect(result.leftoverFiles).toEqual([]);
			expect(result.stdout).not.toContain("step finished");
			expect(result.stderr).toContain(
				`Failed to download the ${tool} installer`,
			);
		},
	);

	it.each(Object.entries(steps))(
		"%s runs the downloaded installer and removes the file",
		(_tool, step) => {
			const result = runInstaller(step, "serves");
			expect(result.installerRan).toBe(true);
			expect(result.leftoverFiles).toEqual([]);
			expect(result.stdout).toContain("step finished");
		},
	);

	it.each(Object.entries(steps))(
		"%s stops the setup and removes the file when the installer fails",
		(_tool, step) => {
			const result = runInstaller(step, "serves-failing");
			expect(result.status).toBe(7);
			expect(result.installerRan).toBe(true);
			expect(result.leftoverFiles).toEqual([]);
			expect(result.stdout).not.toContain("step finished");
		},
	);

	it("passes the pinned version to the installer when SUDO_CMD is empty", () => {
		expect(runInstaller(steps.Nixpacks, "serves").stdout).toContain(
			"versions: 1.41.0 ",
		);
		expect(runInstaller(steps.Railpack, "serves").stdout).toContain(
			"versions:  0.15.4",
		);
	});

	it.each([
		["Nixpacks", "versions: 1.41.0 "],
		["Railpack", "versions:  0.15.4"],
	] as const)(
		"%s pin reaches the installer through a sudo that drops exported variables",
		(tool, expected) => {
			// Stands in for sudo, which runs its command without the exported variables.
			const sudo =
				'sudo_stub() { env -u NIXPACKS_VERSION -u RAILPACK_VERSION "$@"; }';
			const result = runInstaller(`${sudo}\n${steps[tool]}`, "serves", {
				sudoCmd: "sudo_stub",
			});
			expect(result.stdout).toContain(expected);
		},
	);
});
