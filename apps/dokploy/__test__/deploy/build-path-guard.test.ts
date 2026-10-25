import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The build settings name places in the checkout, and the checkout is the
// repository's: the script checks on the build host, after the clone, that
// each place resolves inside the code directory (T-8282).

// Each case starts a few shells, which is slow on Windows.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({ localBase: { path: "" } }));

vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual, ...actual.posix, default: actual.posix };
});
vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: (isServer = false) =>
			isServer
				? actual.paths(true)
				: { ...actual.paths(true), APPLICATIONS_PATH: mocks.localBase.path },
	};
});
vi.mock("@dokploy/server/utils/docker/staging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/staging")
	>()),
	stageFiles: vi.fn(),
}));
vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async (entity: unknown) => entity,
}));

import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { getBuildCommand } from "@dokploy/server/utils/builders";
import { getBuildPathGuardCommand } from "@dokploy/server/utils/builders/build-path-guard";

const createApplication = (overrides: Record<string, unknown> = {}) =>
	({
		appName: "guard-app",
		buildType: "dockerfile",
		sourceType: "git",
		customGitBuildPath: "/",
		dockerfile: "Dockerfile",
		dockerContextPath: null,
		publishDirectory: null,
		createEnvFile: false,
		isStaticSpa: false,
		railpackVersion: "0.15.4",
		env: null,
		buildArgs: null,
		buildSecrets: null,
		cleanCache: false,
		serverId: null,
		buildServerId: null,
		registry: null,
		buildRegistry: null,
		rollbackRegistry: null,
		environment: { env: "", project: { env: "" } },
		...overrides,
	}) as unknown as ApplicationNested;

// `tmp` is the form the shell gets, `tmpNative` the one node's fs takes. They
// are the same except on Windows, where Git Bash resolves a link to its
// `/c/...` form: the paths handed to the shell use that form too. The temp
// directory is not used there, as Git Bash mounts it at `/tmp`.
const shellPath = (nativePath: string) =>
	process.platform === "win32"
		? nativePath.replace(
				/^([A-Za-z]):/,
				(_, drive: string) => `/${drive.toLowerCase()}`,
			)
		: nativePath;
const native = (shellForm: string) =>
	process.platform === "win32"
		? shellForm.replace(
				/^\/([a-z])\//,
				(_, drive: string) => `${drive.toUpperCase()}:/`,
			)
		: shellForm;
const tempBase = () =>
	(process.platform === "win32" ? process.cwd() : tmpdir()).replaceAll(
		"\\",
		"/",
	);

let tmpNative = "";
let tmp = "";
const code = () => `${tmp}/applications/guard-app/code`;
const outside = () => `${tmp}/outside`;
beforeEach(() => {
	if (tmpNative) rmSync(tmpNative, { recursive: true, force: true });
	tmpNative = mkdtempSync(`${tempBase()}/.dokploy-guard-`).replaceAll(
		"\\",
		"/",
	);
	tmp = shellPath(tmpNative);
	mocks.localBase.path = `${tmp}/applications`;
	mkdirSync(native(`${code()}/apps/web`), { recursive: true });
	mkdirSync(native(outside()), { recursive: true });
	writeFileSync(native(`${code()}/Dockerfile`), "FROM scratch\n");
});
afterAll(() => {
	if (tmpNative) rmSync(tmpNative, { recursive: true, force: true });
});

/** A link in the checkout to a directory outside it, as a clone checks it out. */
const linkOutside = (name: string, target = outside()) => {
	// A junction on Windows (no privilege needed), a symlink on other systems.
	symlinkSync(native(target), native(`${code()}/${name}`), "junction");
};

const shells = ["bash", "sh"].filter(
	(shell) => spawnSync(shell, ["-c", "true"]).status === 0,
);
// The shell has to see the link as one, and resolve it to the same form as
// the directory it points at.
const linksWork = (() => {
	if (shells.length === 0) return false;
	const probeNative = mkdtempSync(
		`${tempBase()}/.dokploy-guard-probe-`,
	).replaceAll("\\", "/");
	try {
		mkdirSync(`${probeNative}/target`);
		symlinkSync(`${probeNative}/target`, `${probeNative}/link`, "junction");
		const probe = shellPath(probeNative);
		const result = spawnSync(
			shells[0] as string,
			[
				"-c",
				'[ -L "$1/link" ] && [ "$(realpath -m -- "$1/link")" = "$(realpath -m -- "$1")/target" ]',
				"sh",
				probe,
			],
			{ encoding: "utf8" },
		);
		return result.status === 0;
	} catch {
		return false;
	} finally {
		rmSync(probeNative, { recursive: true, force: true });
	}
})();
const itWithLinks = linksWork ? it : it.skip;

// `prelude` runs first, e.g. to hide a tool from the guard.
const runGuard = (application: ApplicationNested, cleanup = "", prelude = "") =>
	shells.map((shell) => ({
		shell,
		result: spawnSync(
			shell,
			[
				"-c",
				`${prelude}\n${getBuildPathGuardCommand(application, cleanup)}\necho GUARD_PASSED`,
			],
			{ encoding: "utf8", cwd: tmpNative },
		),
	}));

const expectAllowed = (application: ApplicationNested, prelude = "") => {
	for (const { shell, result } of runGuard(application, "", prelude)) {
		expect(result.status, `${shell}: ${result.stderr}`).toBe(0);
		expect(result.stdout, shell).toContain("GUARD_PASSED");
	}
};

const expectRefused = (
	application: ApplicationNested,
	label: string,
	prelude = "",
) => {
	for (const { shell, result } of runGuard(application, "", prelude)) {
		expect(result.status, shell).toBe(1);
		expect(result.stdout, shell).not.toContain("GUARD_PASSED");
		expect(result.stderr, shell).toContain(
			`Build refused: ${label} is not inside the repository`,
		);
	}
};

describe("build path guard in a real shell", () => {
	itWithLinks("allows ordinary directories and files of the checkout", () => {
		expectAllowed(createApplication());
		expectAllowed(createApplication({ dockerContextPath: "apps/web" }));
		expectAllowed(
			createApplication({
				buildType: "nixpacks",
				customGitBuildPath: "apps/web",
			}),
		);
		// A publish directory the build has not made yet.
		expectAllowed(
			createApplication({ buildType: "nixpacks", publishDirectory: "dist" }),
		);
		// A link that stays inside the checkout.
		linkOutside("web-link", `${code()}/apps/web`);
		expectAllowed(createApplication({ dockerContextPath: "web-link" }));
	});

	itWithLinks(
		"refuses a Docker context that resolves outside the code directory",
		() => {
			linkOutside("ctx");
			expectRefused(
				createApplication({ dockerContextPath: "ctx" }),
				"the Docker context path",
			);
			expectRefused(
				createApplication({ dockerContextPath: "ctx/sub" }),
				"the Docker context path",
			);
		},
	);

	itWithLinks(
		"refuses a build path that resolves outside the code directory",
		() => {
			linkOutside("app");
			for (const buildType of [
				"nixpacks",
				"heroku_buildpacks",
				"paketo_buildpacks",
				"railpack",
				"static",
			]) {
				expectRefused(
					createApplication({ buildType, customGitBuildPath: "app" }),
					"the build path",
				);
			}
		},
	);

	itWithLinks(
		"refuses a Dockerfile in a directory outside the code directory",
		() => {
			linkOutside("docker");
			writeFileSync(`${native(outside())}/Dockerfile`, "FROM scratch\n");
			expectRefused(
				createApplication({ dockerfile: "docker/Dockerfile" }),
				"the Dockerfile path",
			);
		},
	);

	itWithLinks(
		"refuses a publish directory that resolves outside the code directory",
		() => {
			linkOutside("dist");
			expectRefused(
				createApplication({ buildType: "nixpacks", publishDirectory: "dist" }),
				"the publish directory",
			);
			expectRefused(
				createApplication({
					buildType: "nixpacks",
					publishDirectory: "dist/site",
				}),
				"the publish directory",
			);
		},
	);

	itWithLinks(
		"refuses a file the build writes that resolves outside the code directory",
		() => {
			linkOutside(".env");
			expectRefused(
				createApplication({ createEnvFile: true }),
				"the .env file",
			);
		},
	);

	itWithLinks("runs the cleanup before a refusal exits", () => {
		linkOutside("ctx");
		const staged = "applications/guard-app/.dokploy-stage-x";
		writeFileSync(`${tmpNative}/${staged}`, "A='1'\n");
		for (const { result } of runGuard(
			createApplication({ dockerContextPath: "ctx" }),
			`rm -f '${tmp}/${staged}';`,
		)) {
			expect(result.status).toBe(1);
		}
		expect(existsSync(`${tmpNative}/${staged}`)).toBe(false);
	});
});

// Hosts whose `realpath` has no `-m` (busybox) use the `readlink -f` branch.
const WITHOUT_REALPATH = "realpath() { return 1; }";
const WITHOUT_EITHER = "realpath() { return 1; }\nreadlink() { return 1; }";

describe("build path guard on a host without realpath -m", () => {
	itWithLinks("allows places that do not exist yet, however deep", () => {
		expectAllowed(createApplication(), WITHOUT_REALPATH);
		for (const publishDirectory of ["dist", "build/web", "out/site/static"]) {
			expectAllowed(
				createApplication({ buildType: "nixpacks", publishDirectory }),
				WITHOUT_REALPATH,
			);
		}
		expectAllowed(
			createApplication({
				buildType: "nixpacks",
				customGitBuildPath: "apps/web",
				publishDirectory: "build/web",
			}),
			WITHOUT_REALPATH,
		);
		expectAllowed(
			createApplication({ buildType: "railpack" }),
			WITHOUT_REALPATH,
		);
	});

	itWithLinks("refuses places that resolve outside the code directory", () => {
		linkOutside("ctx");
		expectRefused(
			createApplication({ dockerContextPath: "ctx" }),
			"the Docker context path",
			WITHOUT_REALPATH,
		);
		linkOutside("dist");
		expectRefused(
			createApplication({
				buildType: "nixpacks",
				publishDirectory: "dist/a/b",
			}),
			"the publish directory",
			WITHOUT_REALPATH,
		);
	});

	itWithLinks("refuses the build when neither tool works", () => {
		for (const { shell, result } of runGuard(
			createApplication(),
			"",
			WITHOUT_EITHER,
		)) {
			expect(result.status, shell).toBe(1);
			expect(result.stdout, shell).not.toContain("GUARD_PASSED");
			expect(result.stderr, shell).toContain(
				"neither realpath -m nor readlink -f",
			);
		}
	});
});

describe("build path guard in the build command", () => {
	it("comes before every build step, for every build type", async () => {
		for (const buildType of [
			"dockerfile",
			"nixpacks",
			"heroku_buildpacks",
			"paketo_buildpacks",
			"railpack",
			"static",
		]) {
			const command = await getBuildCommand(
				createApplication({ buildType, publishDirectory: "dist" }),
				null,
				{ deploymentId: "dep-guard" },
			);
			const guardAt = command.indexOf("__dokploy_inside ");
			expect(guardAt, buildType).toBeGreaterThan(-1);
			for (const step of [
				"docker ",
				"nixpacks ",
				"pack ",
				"railpack ",
				"mkdir -p",
			]) {
				const at = command.indexOf(step, command.indexOf("fi\n"));
				if (at !== -1)
					expect(at, `${buildType} ${step}`).toBeGreaterThan(guardAt);
			}
		}
	});

	it("checks the build server's checkout when the build runs there", async () => {
		const command = await getBuildCommand(
			createApplication({
				buildServerId: "build-1",
				customGitBuildPath: "apps/web",
			}),
			"build-1",
			{ deploymentId: "dep-guard-remote" },
		);
		expect(command).toContain(
			"__dokploy_inside /etc/dokploy/applications/guard-app/code /etc/dokploy/applications/guard-app/code/apps/web ",
		);
	});

	it("is not added for an application that deploys an image", async () => {
		const command = await getBuildCommand(
			createApplication({ sourceType: "docker" }),
			null,
		);
		expect(command).not.toContain("__dokploy_inside");
	});
});
