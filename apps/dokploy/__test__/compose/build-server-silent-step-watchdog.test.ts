import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-11843: the watchdog killed compose deploys that build on a build server.
 *
 * The image push (and a quiet build step) of such a deploy can print nothing
 * for longer than the watchdog's idle limit, and the log file is untouched
 * meanwhile. The watchdog reads the log's modification time, so a healthy
 * deploy looked stuck and was stopped, then rolled back.
 *
 * This runs the real build-server stage and the real watchdog together on one
 * fake clock: the deployment log is whatever the stage appends to it, the
 * watchdog sweeps every minute like its interval does, and the push stays
 * silent for 25 minutes.
 */

const pin = vi.hoisted(() => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	const isCommitRead = (command: unknown) =>
		typeof command === "string" &&
		command.includes(
			"rev-parse --verify -q HEAD\\^\\{commit\\} 2>/dev/null || true",
		);
	return { sha, isCommitRead };
});

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	appendFile: vi.fn(),
	writeFileRemote: vi.fn(),
	findServerById: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	loginDockerRegistry: vi.fn(),
	cloneGitRepository: vi.fn(),
	getCreateComposeFileCommand: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
}));

// The progress marks stop once the deployment row is no longer `running`.
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: {
				findFirst: vi.fn().mockResolvedValue({ status: "running" }),
			},
		},
	},
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	appendFile: mocks.appendFile,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: (...args: unknown[]) =>
		pin.isCommitRead(args[1])
			? Promise.resolve({ stdout: `${pin.sha}\n`, stderr: "" })
			: mocks.execAsyncRemote(...args),
	writeFileRemote: mocks.writeFileRemote,
	execAsync: (command: unknown) =>
		pin.isCommitRead(command)
			? Promise.resolve({ stdout: `${pin.sha}\n`, stderr: "" })
			: undefined,
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
	cloneGithubRepository: vi.fn(),
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

import { prepareComposeBuildServerDeploy } from "@dokploy/server/services/compose-build-server";
import {
	createDeploymentWatchdog,
	type WatchdogDeps,
} from "../../server/queues/deployment-watchdog";
import type { InMemoryJob } from "../../server/queues/in-memory-queue";

const MIN = 60_000;
const START = Date.parse("2026-10-31T11:13:36.000Z");

/** Minutes of silence of the push: well past the 20 minute idle limit. */
const SILENT_PUSH_MIN = 25;
const BUILD_MIN = 3;

const compose = {
	appName: "snap",
	composeId: "comp-1",
	sourceType: "git",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	domains: [],
	createEnvFile: false,
	buildServerId: "build-1",
	buildRegistryId: "reg-1",
	server: { name: "prod-1" },
	environment: { project: { env: "" }, env: "" },
} as any;

const row = {
	deploymentId: "dep-1",
	title: "Deploy",
	logPath: "/etc/dokploy/logs/snap/snap.log",
	pid: null,
	serverId: null,
	buildServerId: null,
	applicationId: null,
	composeId: "comp-1",
	previewDeploymentId: null,
	startedAt: new Date(START).toISOString(),
	createdAt: new Date(START).toISOString(),
};

const job = {
	id: "job-1",
	journalId: "journal-1",
	name: "deployments",
	timestamp: START,
	processedOn: START,
	data: {
		composeId: "comp-1",
		titleLog: "t",
		descriptionLog: "",
		type: "deploy",
		applicationType: "compose",
	},
} as unknown as InMemoryJob;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a build-server compose whose push is silent for longer than the idle limit (T-11843)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
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
		mocks.generateApplyPatchesCommand.mockResolvedValue("");
		mocks.writeFileRemote.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is not failed by the watchdog: the log keeps moving while the push runs", async () => {
		// The deployment log is what the stage appends to it; its modification
		// time is the moment of the last append (the watchdog reads exactly that).
		let lastLogWrite = START;
		mocks.appendFile.mockImplementation(async () => {
			lastLogWrite = Date.now();
		});

		mocks.execAsyncRemote.mockImplementation(
			async (
				_serverId: string,
				command: string,
				onData?: (d: string) => void,
			) => {
				if (command.includes("config --format json")) {
					return {
						stdout: JSON.stringify({
							name: "snap",
							services: { web: { build: { context: "." } } },
						}),
						stderr: "",
					};
				}
				if (/ build 2>&1/.test(command) && !command.includes("docker push")) {
					onData?.("#1 [web 1/2] RUN npm run build\n");
					await sleep(BUILD_MIN * MIN);
					return { stdout: "", stderr: "" };
				}
				if (command.includes("docker push")) {
					// One large layer to a slow registry: nothing is printed until it is
					// through.
					onData?.(
						"The push refers to repository [reg.example.com/acme/snap-web]\n",
					);
					await sleep(SILENT_PUSH_MIN * MIN);
					onData?.("dpl-dep-1: digest: sha256:abc size: 1234\n");
					return { stdout: "", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			},
		);

		const stop = vi.fn(async () => ({
			method: "launcher" as const,
			notRunning: false,
			claimedCancelled: true,
		}));
		let maxIdleMs = 0;
		const watchdog = createDeploymentWatchdog({
			now: () => Date.now(),
			loadConfig: async () => ({
				enabled: true,
				idleMinutes: 20,
				maxMinutes: 90,
				exclusions: [],
			}),
			activeJobs: async () => [job],
			releaseJob: () => true,
			hasKeptGroupLock: () => false,
			dropKeptGroupLock: () => false,
			markDeploymentReleased: () => {},
			readStatus: async () => "running",
			listRunning: async () => [row],
			latestDeploys: async () => [],
			resolveService: async () => ({
				applicationId: null,
				composeId: "comp-1",
			}),
			// The real probe: the age of the log file.
			readLogIdleMs: async () => {
				const idle = Date.now() - lastLogWrite;
				maxIdleMs = Math.max(maxIdleMs, idle);
				return idle;
			},
			logHost: async () => null,
			appendLog: async () => {
				lastLogWrite = Date.now();
			},
			stop,
			markFailed: async () => "flipped",
			failServiceIfRunning: async () => {},
			loadContext: async () => null,
			notify: async () => {},
			recordAudit: async () => {},
		} satisfies WatchdogDeps);

		const runStep = vi.fn().mockResolvedValue(undefined);
		let result: Awaited<ReturnType<typeof prepareComposeBuildServerDeploy>>;
		const stage = prepareComposeBuildServerDeploy({
			entity: compose,
			deployment: { logPath: row.logPath, deploymentId: "dep-1" },
			runStep,
			servingCommitOutput: `${pin.sha}\n`,
			patches: [],
		}).then((value) => {
			result = value;
		});

		// The interval of the real watchdog: a sweep a minute, for the whole stage.
		for (let minute = 1; minute <= BUILD_MIN + SILENT_PUSH_MIN + 5; minute++) {
			await vi.advanceTimersByTimeAsync(MIN);
			await watchdog.sweep();
		}
		await stage;

		expect(stop).not.toHaveBeenCalled();
		// The log was never older than a few minutes, however long the push ran.
		expect(maxIdleMs).toBeLessThan(10 * MIN);
		expect(result!).toMatchObject({
			images: [{ service: "web" }],
		});
	});
});
