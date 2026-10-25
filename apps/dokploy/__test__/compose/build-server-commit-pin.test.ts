import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7282: a compose with a build server is fetched twice, once on the serving
// host (where the compose guards check it) and once on the build server. The
// build server must build exactly the commit the serving host checked: a push
// in between would otherwise build a compose file and .env nobody checked.

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	execAsync: vi.fn(),
	deploymentStatus: vi.fn(),
	findServerById: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	loginDockerRegistry: vi.fn(),
	cloneGitRepository: vi.fn(),
	cloneGithubRepository: vi.fn(),
	getCreateComposeFileCommand: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
	assertComposeVolumesBound: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: mocks.execAsyncRemote,
	execAsync: mocks.execAsync,
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: {
				findFirst: (...args: unknown[]) => mocks.deploymentStatus(...args),
			},
		},
	},
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));
vi.mock("@dokploy/server/utils/cluster/upload", () => ({
	loginDockerRegistry: mocks.loginDockerRegistry,
	getRegistryTag: (
		registry: { registryUrl: string; username: string },
		image: string,
	) => `${registry.registryUrl}/${registry.username}/${image}`,
}));
vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue("echo write-compose;"),
}));
vi.mock("@dokploy/server/utils/providers/git", () => ({
	cloneGitRepository: mocks.cloneGitRepository,
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: mocks.cloneGithubRepository,
}));
vi.mock("@dokploy/server/utils/providers/gitlab", () => ({
	cloneGitlabRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/gitea", () => ({
	cloneGiteaRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/bitbucket", () => ({
	cloneBitbucketRepository: vi.fn(),
}));
vi.mock("@dokploy/server/utils/providers/raw", () => ({
	getCreateComposeFileCommand: mocks.getCreateComposeFileCommand,
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
}));
vi.mock("@dokploy/server/services/compose-volume-binding", () => ({
	assertComposeVolumesBound: mocks.assertComposeVolumesBound,
}));

import {
	prepareComposeBuildServerDeploy,
	readServingHostCommitOutput,
} from "@dokploy/server/services/compose-build-server";
import { REUSABLE_CLONE_ANSWER } from "@dokploy/server/utils/builders/compose-remote-build";

const CHECKED = "0123456789abcdef0123456789abcdef01234567";
const PUSHED = "fedcba9876543210fedcba9876543210fedcba98";

const compose = {
	appName: "my-app",
	composeId: "c1",
	sourceType: "git",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: "prod-1",
	env: "",
	mounts: [],
	domains: [],
	createEnvFile: false,
	buildServerId: "build-1",
	buildRegistryId: "reg-1",
	server: { name: "prod-1" },
	environment: { project: { env: "" }, env: "" },
} as any;

const configJson = JSON.stringify({
	name: "my-app",
	services: { web: { build: { context: "." } } },
});

const isCommitRead = (command: string) =>
	command.includes(
		"rev-parse --verify -q HEAD\\^\\{commit\\} 2>/dev/null || true",
	);
const isProbe = (command: string) => command.includes(REUSABLE_CLONE_ANSWER);

/**
 * What each host answers: the serving host's checkout, the build server's
 * checkout after its clone, and whether the build server's probe finds a
 * reusable checkout.
 */
let serving: string;
let built: string;
let reusable: boolean;

const answer = (serverId: string | null, command: string) => {
	if (isProbe(command)) {
		return reusable && command.includes(built) ? REUSABLE_CLONE_ANSWER : "";
	}
	if (isCommitRead(command)) {
		return serverId === "build-1" ? `${built}\n` : `${serving}\n`;
	}
	return command.includes("config --format json") ? configJson : "";
};

const callsOn = (serverId: string) =>
	mocks.execAsyncRemote.mock.calls
		.filter((call) => call[0] === serverId)
		.map((call) => call[1] as string);

// A refused build ends like a failed one: the serving host's previous release
// is put back, and it is never told about (or made to pull) any image.
const expectOnlyTheRestore = (runStep: ReturnType<typeof vi.fn>) => {
	expect(runStep).toHaveBeenCalledTimes(1);
	for (const [command] of runStep.mock.calls) {
		expect(String(command)).toContain("Restoring previous working deployment");
		expect(String(command)).not.toContain("pull_policy");
		expect(String(command)).not.toContain("base64 -d");
	}
};

const deploy = (overrides: Record<string, unknown> = {}) => {
	const runStep = vi.fn().mockResolvedValue(undefined);
	const run = prepareComposeBuildServerDeploy({
		entity: compose,
		deployment: { logPath: "/tmp/log", deploymentId: "dep1" },
		runStep,
		// What the deploy path read right after the serving host's fetch, and
		// the patch rows it applied (see build-server-pin-deploy.test.ts).
		servingCommitOutput: `${serving}
`,
		patches: [],
		...overrides,
	});
	return { run, runStep };
};

beforeEach(() => {
	vi.clearAllMocks();
	serving = CHECKED;
	built = CHECKED;
	reusable = false;
	mocks.findServerById.mockResolvedValue({
		serverId: "build-1",
		name: "builder",
		ipAddress: "10.0.0.9",
		serverType: "build",
		organizationId: "org-1",
	});
	mocks.findRegistryByIdWithCredentials.mockResolvedValue({
		registryId: "reg-1",
		registryName: "main",
		registryUrl: "reg.example.com",
		username: "acme",
		organizationId: "org-1",
	});
	mocks.loginDockerRegistry.mockResolvedValue(undefined);
	mocks.cloneGitRepository.mockResolvedValue("echo clone;");
	mocks.cloneGithubRepository.mockResolvedValue("echo clone-github;");
	mocks.getCreateComposeFileCommand.mockResolvedValue("echo write-raw;");
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
	mocks.assertComposeVolumesBound.mockResolvedValue(undefined);
	mocks.deploymentStatus.mockResolvedValue({ status: "running" });
	mocks.execAsyncRemote.mockImplementation(
		async (serverId: string, command: string) => ({
			stdout: answer(serverId, command),
			stderr: "",
		}),
	);
	mocks.execAsync.mockImplementation(async (command: string) => ({
		stdout: answer(null, command),
		stderr: "",
	}));
});

describe("build server pinned to the serving host's commit", () => {
	it("clones the serving host's commit on the build server, without reading it late", async () => {
		const { run } = deploy();
		await expect(run).resolves.toMatchObject({
			images: [expect.objectContaining({ service: "web" })],
		});

		// The commit came from the deploy path's early read; prepare never
		// reads the serving host itself (that would be after its patches).
		expect(callsOn("prod-1").filter(isCommitRead)).toEqual([]);
		expect(mocks.execAsync).not.toHaveBeenCalled();

		// The build server's clone is told which commit to end on.
		expect(mocks.cloneGitRepository).toHaveBeenCalledTimes(1);
		expect(mocks.cloneGitRepository).toHaveBeenCalledWith(
			expect.objectContaining({
				serverId: "build-1",
				type: "compose",
				pinCommit: CHECKED,
			}),
		);

		// Read first, then clone, then check what the clone ended on, and only
		// then resolve the configuration and build.
		const order = mocks.execAsyncRemote.mock.calls.map(
			(call) => `${call[0]}:${call[1]}`,
		);
		const clone = order.findIndex((c) => c.includes("echo clone;"));
		const buildRead = order.findIndex(
			(c) => c.startsWith("build-1:") && isCommitRead(c),
		);
		const config = order.findIndex((c) => c.includes("config --format json"));
		expect(clone).toBeGreaterThanOrEqual(0);
		expect(clone).toBeLessThan(buildRead);
		expect(buildRead).toBeLessThan(config);
	});

	it("the early read runs on the serving host, locally for the Dokploy host", async () => {
		await expect(readServingHostCommitOutput(compose)).resolves.toBe(
			`${CHECKED}
`,
		);
		const remote = callsOn("prod-1").filter(isCommitRead);
		expect(remote).toHaveLength(1);
		expect(remote[0]).toMatch(/compose[\\/]+my-app[\\/]+code/);

		await expect(
			readServingHostCommitOutput({ ...compose, serverId: null }),
		).resolves.toBe(`${CHECKED}
`);
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(isCommitRead(mocks.execAsync.mock.calls[0]?.[0])).toBe(true);
	});

	// A read that could not run is not "not a checkout".
	it("names a read that could not run on the serving host", async () => {
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("ssh: timed out"));
		const output = await readServingHostCommitOutput(compose);
		const { run } = deploy({ servingCommitOutput: output });
		await expect(run).rejects.toThrow(
			/the read could not run on the serving host \(connection or command failure\)/,
		);
		await run.catch((error: Error) => {
			expect(error.message).not.toContain("ssh: timed out");
		});
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
	});

	it("pins every git provider, a preview's head ref included", async () => {
		const { run } = deploy({
			entity: {
				...compose,
				sourceType: "github",
				headRef: "refs/pull/7/head",
			},
			cancellable: false,
			applyPatches: false,
		});
		await run;
		expect(mocks.cloneGithubRepository).toHaveBeenCalledWith(
			expect.objectContaining({
				headRef: "refs/pull/7/head",
				pinCommit: CHECKED,
			}),
		);
		// A preview keeps its plain (not cancelable) calls.
		for (const call of mocks.execAsyncRemote.mock.calls) {
			expect(call[3]).toBeUndefined();
		}
	});

	it("refuses to build when the build server ends on another commit", async () => {
		// The branch moved and the clone did not end on the checked commit.
		built = PUSHED;
		const { run, runStep } = deploy();
		await expect(run).rejects.toThrow(
			`The build server's checkout is commit ${PUSHED}, not commit ${CHECKED} that the serving host checked`,
		);
		const commands = callsOn("build-1").join("\n");
		expect(commands).not.toContain("config --format json");
		expect(commands).not.toMatch(/ build 2>&1/);
		expect(commands).not.toContain("docker push");
		expect(mocks.loginDockerRegistry).not.toHaveBeenCalled();
		// The serving host is put back to its previous release, never told
		// about any image.
		expectOnlyTheRestore(runStep);
	});

	it("refuses to build when the build server's checkout has no commit", async () => {
		built = "";
		const { run } = deploy();
		await expect(run).rejects.toThrow(
			`The build server's checkout is no commit, not commit ${CHECKED}`,
		);
		expect(callsOn("build-1").join("\n")).not.toContain("config --format json");
	});

	it.each([
		["nothing", ""],
		["no full commit id", "abc123"],
		["something that is not a commit", `${CHECKED.slice(0, 39)};id`],
	])(
		"refuses before touching the build server when the serving host prints %s",
		async (_label, stdout) => {
			serving = stdout;
			const { run, runStep } = deploy();
			await expect(run).rejects.toThrow(
				/Could not read the commit checked out on the serving host/,
			);
			expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
			expect(callsOn("build-1")).toEqual([]);
			expectOnlyTheRestore(runStep);
		},
	);

	it("launches the build server's commit check cancelable, like every step", async () => {
		const { run } = deploy();
		await run;
		const check = mocks.execAsyncRemote.mock.calls.find(
			(call) => call[0] === "build-1" && isCommitRead(call[1]),
		);
		expect(check?.[3]).toMatchObject({
			cancelable: expect.objectContaining({ deploymentId: "dep1" }),
		});
	});

	it("stops at a cancel that lands before anything runs on the build server", async () => {
		mocks.deploymentStatus.mockResolvedValue({ status: "cancelled" });
		const { run } = deploy();
		await expect(run).rejects.toMatchObject({ deploymentCancelled: true });
		expect(callsOn("build-1")).toEqual([]);
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
	});

	it("patches still apply after the pin, before the commit check", async () => {
		mocks.generateApplyPatchesCommand.mockResolvedValue("echo patch;");
		const { run } = deploy();
		await run;
		const commands = callsOn("build-1");
		const clone = commands.findIndex((c) => c.includes("echo clone;"));
		const patch = commands.findIndex((c) => c.includes("echo patch;"));
		const check = commands.findIndex(isCommitRead);
		expect(clone).toBeLessThan(patch);
		expect(patch).toBeLessThan(check);
		expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledWith(
			expect.objectContaining({ serverId: "build-1" }),
			expect.anything(),
		);
	});
});

describe("what the deploy path read right after the fetch", () => {
	const rows = [
		{
			patchId: "p1",
			filePath: "docker-compose.yml",
			content: "services: {}\n",
			type: "update",
			enabled: true,
		},
	];

	it("pins the commit read after the fetch, without reading the serving host again", async () => {
		// What the serving host holds now is not what is built: the commit
		// read right after the fetch is.
		serving = PUSHED;
		const { run } = deploy({ servingCommitOutput: `${CHECKED}\n` });
		await run;
		expect(callsOn("prod-1").filter(isCommitRead)).toEqual([]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.cloneGitRepository).toHaveBeenCalledWith(
			expect.objectContaining({ pinCommit: CHECKED }),
		);
	});

	it("refuses an empty early read rather than reading again", async () => {
		const { run } = deploy({ servingCommitOutput: "" });
		await expect(run).rejects.toThrow(
			/Could not read the commit checked out on the serving host \(the code directory is not a git checkout of its own\)/,
		);
		expect(callsOn("prod-1").filter(isCommitRead)).toEqual([]);
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
	});

	it("says why a SHA-256 repository cannot be pinned", async () => {
		const { run } = deploy({ servingCommitOutput: `${"a".repeat(64)}\n` });
		await expect(run).rejects.toThrow(/SHA-256 object format/);
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
	});

	it("applies the serving host's patch rows on the build server, not a second read", async () => {
		mocks.generateApplyPatchesCommand.mockResolvedValue("echo patch;");
		const { run } = deploy({ patches: rows });
		await run;
		expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledTimes(1);
		const [options] = mocks.generateApplyPatchesCommand.mock.calls[0] ?? [];
		expect(options).toMatchObject({ serverId: "build-1" });
		expect(options.patches).toBe(rows);
	});

	// A caller that did not read early is refused, never served by a late
	// read or a second read of the patch rows.
	it("refuses a caller that passes no early commit read", async () => {
		const { run, runStep } = deploy({ servingCommitOutput: undefined });
		await expect(run).rejects.toThrow(/was not read right after its fetch/);
		expect(callsOn("prod-1").filter(isCommitRead)).toEqual([]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(callsOn("build-1")).toEqual([]);
		expectOnlyTheRestore(runStep);
	});

	it("refuses a caller that passes no patch rows when patches apply", async () => {
		const { run } = deploy({ patches: undefined });
		await expect(run).rejects.toThrow(
			/patches the serving host applied were not passed/,
		);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(callsOn("build-1")).toEqual([]);
	});

	it("needs no patch rows when no patches apply (a preview), nor a commit for a raw compose", async () => {
		await deploy({ patches: undefined, applyPatches: false }).run;
		await deploy({
			entity: { ...compose, sourceType: "raw" },
			servingCommitOutput: undefined,
			patches: undefined,
			applyPatches: false,
		}).run;
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
	});
});

describe("rebuild (reuseClone)", () => {
	it("reuses a finished checkout of the serving host's commit", async () => {
		reusable = true;
		const { run } = deploy({ reuseClone: true });
		await run;
		const probe = callsOn("build-1").find(isProbe);
		expect(probe).toContain(CHECKED);
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
		// And still checks it before building.
		expect(callsOn("build-1").filter(isCommitRead)).toHaveLength(1);
	});

	it("clones again, pinned, when the build server holds another commit", async () => {
		// The last build-server checkout is older than what the serving host
		// has (a deploy that failed on the build server, or one that built on
		// the serving host): the probe only accepts the serving host's commit.
		reusable = true;
		serving = PUSHED;
		built = CHECKED;
		mocks.cloneGitRepository.mockImplementation(async () => {
			built = PUSHED;
			return "echo clone;";
		});
		const { run } = deploy({ reuseClone: true });
		await run;
		const probe = callsOn("build-1").find(isProbe);
		expect(probe).toContain(PUSHED);
		expect(mocks.cloneGitRepository).toHaveBeenCalledWith(
			expect.objectContaining({ pinCommit: PUSHED }),
		);
	});
});

describe("the compose checks on the build server's own files (T-7960)", () => {
	it("checks the build server's checkout after its commit check, before anything is written or built", async () => {
		let before: string[] = [];
		mocks.assertComposeVolumesBound.mockImplementation(async () => {
			before = callsOn("build-1");
		});
		const { run } = deploy({ patches: [] });
		await expect(run).resolves.toBeDefined();

		expect(mocks.assertComposeVolumesBound).toHaveBeenCalledTimes(1);
		expect(mocks.assertComposeVolumesBound).toHaveBeenCalledWith(
			expect.objectContaining({
				appName: "my-app",
				composeId: "c1",
				serverId: "build-1",
			}),
		);
		// After the clone and the commit check, before the compose file and
		// .env are written and before the configuration is resolved.
		expect(before.some((c) => c.includes("echo clone;"))).toBe(true);
		expect(before.some(isCommitRead)).toBe(true);
		expect(before.some((c) => c.includes("echo write-compose;"))).toBe(false);
		expect(before.some((c) => c.includes("config --format json"))).toBe(false);
	});

	it("a refusal there builds and pushes nothing, and puts the previous release back", async () => {
		mocks.assertComposeVolumesBound.mockRejectedValue(
			new Error("Compose refused: a build context outside the compose."),
		);
		const { run, runStep } = deploy();
		await expect(run).rejects.toThrow(
			"Compose refused: a build context outside the compose.",
		);
		const onBuildServer = callsOn("build-1").join("\n");
		expect(onBuildServer).not.toContain("echo write-compose;");
		expect(onBuildServer).not.toContain("config --format json");
		expect(onBuildServer).not.toContain("docker push");
		expect(mocks.loginDockerRegistry).not.toHaveBeenCalled();
		expectOnlyTheRestore(runStep);
	});

	it("checks a reused checkout on a rebuild too", async () => {
		reusable = true;
		const { run } = deploy({ reuseClone: true });
		await expect(run).resolves.toBeDefined();
		expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
		expect(mocks.assertComposeVolumesBound).toHaveBeenCalledWith(
			expect.objectContaining({ serverId: "build-1" }),
		);
	});
});

describe("raw composes", () => {
	it("have no checkout: no commit is read or pinned, both hosts write the row's file", async () => {
		const { run } = deploy({
			entity: { ...compose, sourceType: "raw" },
			reuseClone: true,
		});
		await expect(run).resolves.toBeDefined();
		const all = mocks.execAsyncRemote.mock.calls.map((c) => c[1] as string);
		expect(all.some(isCommitRead)).toBe(false);
		expect(all.some(isProbe)).toBe(false);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(all.join("\n")).toContain("echo write-raw;");
		// Its file is the row the serving host checked.
		expect(mocks.assertComposeVolumesBound).not.toHaveBeenCalled();
	});
});
