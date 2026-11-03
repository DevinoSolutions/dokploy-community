import { describe, expect, it, vi } from "vitest";

// The builders stage env files on the host that runs the build; these tests
// only read the generated command.
vi.mock("@dokploy/server/utils/docker/staging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/staging")
	>()),
	stageFiles: vi.fn(),
}));

import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { getNixpacksCommand } from "@dokploy/server/utils/builders/nixpacks";
import {
	getNixpacksTempEnvAssignment,
	getNixpacksTempSetupCommand,
	getNixpacksTempSweepCommand,
	NIXPACKS_TEMP_CLEANUP_FUNCTION,
	NIXPACKS_TEMP_MAX_AGE_MINUTES,
} from "@dokploy/server/utils/builders/nixpacks-temp";

const createMockApplication = (overrides = {}): ApplicationNested =>
	({
		appName: "test-app",
		buildType: "nixpacks" as const,
		env: null,
		buildArgs: null,
		buildSecrets: null,
		cleanCache: false,
		environment: {
			env: "",
			project: { env: "" },
		},
		...overrides,
	}) as unknown as ApplicationNested;

describe("nixpacks temp directory sweeper", () => {
	it("only looks at nixpacks.* directories directly under the temp dir", () => {
		const sweep = getNixpacksTempSweepCommand();
		expect(sweep).toContain('find "${TMPDIR:-/tmp}"');
		expect(sweep).toContain("-maxdepth 1");
		expect(sweep).toContain("-type d");
		expect(sweep).toContain("-name 'nixpacks.*'");
		expect(sweep).toContain("-exec rm -rf {} +");
	});

	it("removes directories older than a day, and never fails the build", () => {
		expect(NIXPACKS_TEMP_MAX_AGE_MINUTES).toBe(1440);
		const sweep = getNixpacksTempSweepCommand();
		expect(sweep).toContain("-mmin +1440");
		expect(sweep.endsWith("|| true;")).toBe(true);
	});

	it("is a single find over the temp dir and touches nothing else", () => {
		const sweep = getNixpacksTempSweepCommand();
		expect(sweep.match(/\bfind\b/g)).toHaveLength(1);
		expect(sweep.match(/\brm\b/g)).toHaveLength(1);
		expect(sweep).not.toMatch(/rm -rf\s+["$/]/);
	});
});

describe("nixpacks temp directory setup", () => {
	it("creates a nixpacks.* directory under the temp dir with mktemp", () => {
		const setup = getNixpacksTempSetupCommand();
		expect(setup).toContain('mktemp -d "${TMPDIR:-/tmp}/nixpacks.XXXXXXXX"');
	});

	it("removes it on EXIT and on the signals a cancel sends", () => {
		const setup = getNixpacksTempSetupCommand();
		expect(setup).toContain(`trap '${NIXPACKS_TEMP_CLEANUP_FUNCTION}' EXIT;`);
		expect(setup).toContain("trap 'exit 129' HUP;");
		expect(setup).toContain("trap 'exit 130' INT;");
		expect(setup).toContain("trap 'exit 143' TERM;");
	});

	it("only deletes a path that looks like the directory it made", () => {
		const setup = getNixpacksTempSetupCommand();
		expect(setup).toContain('case "$DOKPLOY_NIXPACKS_TMP" in */nixpacks.*)');
		expect(setup).toContain('rm -rf -- "$DOKPLOY_NIXPACKS_TMP"');
	});

	it("falls back to the normal temp dir when the directory cannot be made", () => {
		expect(getNixpacksTempSetupCommand()).toContain(
			'|| DOKPLOY_NIXPACKS_TMP="";',
		);
		expect(getNixpacksTempEnvAssignment()).toBe(
			'TMPDIR="${DOKPLOY_NIXPACKS_TMP:-${TMPDIR:-/tmp}}" ',
		);
	});
});

describe("getNixpacksCommand temp directory handling", () => {
	it("sweeps, sets up the directory, and only then starts nixpacks", async () => {
		const command = await getNixpacksCommand(createMockApplication());
		const sweep = command.indexOf(getNixpacksTempSweepCommand());
		const setup = command.indexOf(getNixpacksTempSetupCommand());
		const build = command.indexOf("nixpacks build");
		expect(sweep).toBeGreaterThanOrEqual(0);
		expect(setup).toBeGreaterThan(sweep);
		expect(build).toBeGreaterThan(setup);
	});

	it("runs nixpacks with the per-build directory as its TMPDIR", async () => {
		const command = await getNixpacksCommand(createMockApplication());
		expect(command).toContain(
			`${getNixpacksTempEnvAssignment()}nixpacks build`,
		);
	});

	it("cleans up right after the build, on success and on failure", async () => {
		const command = await getNixpacksCommand(createMockApplication());
		const failure = command.slice(
			command.indexOf("|| {"),
			command.indexOf("Nixpacks build failed"),
		);
		expect(failure).toContain(`${NIXPACKS_TEMP_CLEANUP_FUNCTION};`);
		const success = command.slice(
			command.indexOf("Nixpacks build failed"),
			command.indexOf("Nixpacks build completed"),
		);
		expect(success).toContain(`${NIXPACKS_TEMP_CLEANUP_FUNCTION};`);
	});

	it("keeps the temp directory handling when a publish directory adds the static stage", async () => {
		const command = await getNixpacksCommand(
			createMockApplication({ publishDirectory: "dist" }),
		);
		expect(command).toContain(getNixpacksTempSetupCommand());
		expect(command).toContain("--no-error-without-start");
	});

	it("does not put build variables or secrets into the temp handling", async () => {
		const command = await getNixpacksCommand(
			createMockApplication({ env: "API_TOKEN=hunter2" }),
		);
		const temp = [
			getNixpacksTempSweepCommand(),
			getNixpacksTempSetupCommand(),
			getNixpacksTempEnvAssignment(),
		].join("\n");
		expect(temp).not.toContain("hunter2");
		expect(command).not.toContain("hunter2");
	});
});
