import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import { deployApplication } from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import { getBuildStartLine } from "@dokploy/server/services/deployment-heartbeat";
import { resolveDeploymentLogHost } from "@dokploy/server/services/deployment-log-host";
import * as builders from "@dokploy/server/utils/builders";
import * as hooks from "@dokploy/server/utils/docker/hooks";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import * as notifications from "@dokploy/server/utils/notifications/build-error";
import * as successNotifications from "@dokploy/server/utils/notifications/build-success";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import {
	createDeploymentWatchdog,
	type WatchdogDeps,
} from "../../server/queues/deployment-watchdog";
import type { InMemoryJob } from "../../server/queues/in-memory-queue";

/**
 * T-11843: the progress marks of an application deploy cover its build, not
 * its clone.
 *
 * The deploy script is one command: the clone comes first, then the line
 * of the build start (`getBuildStartLine`), then the build and the push. This runs the real deploy
 * flow and the real watchdog on one fake clock, against a host that behaves
 * like the shell script does (it appends to a log file), and checks both sides:
 * a push that is silent for 25 minutes is not failed, and a clone that goes
 * silent still is, at the idle limit.
 */

vi.mock("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn(() => chain),
			where: vi.fn(() => chain),
			returning: vi.fn().mockResolvedValue([{}] as any),
			from: vi.fn(() => chain),
			innerJoin: vi.fn(() => chain),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (v: any) => void) => {
				resolve([]);
			},
		} as any;
		return chain;
	};

	return {
		db: {
			select: vi.fn(() => createChainableMock()),
			insert: vi.fn(),
			update: vi.fn(() => createChainableMock()),
			delete: vi.fn(),
			query: {
				buildPolicySettings: {
					findFirst: vi.fn().mockResolvedValue(undefined),
				},
				applications: { findFirst: vi.fn() },
				// the status of the deployment row (deployment-cancel.ts)
				deployments: {
					findFirst: vi.fn().mockResolvedValue({ status: "running" }),
				},
				deployHook: { findFirst: vi.fn() },
				patch: { findMany: vi.fn().mockResolvedValue([]) },
				member: { findMany: vi.fn().mockResolvedValue([]) },
			},
		},
	};
});

vi.mock("@dokploy/server/services/application", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/application")
	>("@dokploy/server/services/application");
	return {
		...actual,
		findApplicationById: vi.fn(),
		updateApplicationStatus: vi.fn(),
	};
});

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return { ...actual, getGitCommitInfo: vi.fn() };
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders")
	>("@dokploy/server/utils/builders");
	return {
		...actual,
		mechanizeDockerContainer: vi.fn(),
		getBuildCommand: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/docker/hooks", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/hooks")
	>("@dokploy/server/utils/docker/hooks");
	return { ...actual, runDeployHook: vi.fn() };
});

vi.mock("@dokploy/server/utils/docker/utils", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/utils")
	>("@dokploy/server/utils/docker/utils");
	return { ...actual, waitForSwarmServiceStable: vi.fn() };
});

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/services/rollbacks", () => ({
	createRollback: vi.fn(),
}));

import { db } from "@dokploy/server/db";

const MIN = 60_000;
const START = Date.parse("2026-10-31T11:13:36.000Z");
const BUILD_SERVER = "build-server-id";
const APP_SERVER = "app-server-id";
const DEPLOYMENT_ID = "deployment-id";
const BUILD_START_LINE = getBuildStartLine(DEPLOYMENT_ID);
const LOG_PATH = "/etc/dokploy/logs/test-app/test-app.log";

const application = {
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "git" as const,
	customGitUrl: "https://github.com/Dokploy/examples.git",
	customGitBranch: "main",
	customGitSSHKeyId: null,
	buildType: "nixpacks" as const,
	buildPath: "/astro",
	env: "NODE_ENV=production",
	serverId: APP_SERVER,
	buildServerId: BUILD_SERVER,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	deployHooks: null,
	environment: {
		projectId: "project-id",
		env: "",
		name: "production",
		project: { name: "Test Project", organizationId: "org-id", env: "" },
	},
	domains: [],
};

const row = {
	deploymentId: DEPLOYMENT_ID,
	title: "Deploy",
	logPath: LOG_PATH,
	pid: null,
	serverId: APP_SERVER,
	buildServerId: BUILD_SERVER,
	applicationId: "test-app-id",
	composeId: null,
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
		applicationId: "test-app-id",
		titleLog: "t",
		descriptionLog: "",
		type: "deploy",
		applicationType: "application",
	},
} as unknown as InMemoryJob;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The host the log lives on. `append` is what the shell script and Dokploy's
 * own marks do to the file, `lastWrite` is its modification time.
 */
const makeHost = () => {
	let content = "";
	const host = {
		lastWrite: START,
		appends: [] as { serverId: string; text: string }[],
		greps: [] as string[],
		scripts: [] as string[],
		append(text: string) {
			content += text;
			host.lastWrite = Date.now();
		},
		/** `grep -x`: a line of the log that is exactly `text`. */
		hasLine(text: string) {
			return content.split("\n").includes(text);
		},
		content: () => content,
	};
	return host;
};

/** The progress marks among what Dokploy appended to the log. */
const marksOf = (host: { appends: { serverId: string; text: string }[] }) =>
	host.appends.filter((append) => append.text.includes("still running"));

const sweepEveryMinute = async (
	watchdog: { sweep: () => Promise<unknown> },
	minutes: number,
) => {
	for (let minute = 1; minute <= minutes; minute++) {
		await vi.advanceTimersByTimeAsync(MIN);
		await watchdog.sweep();
	}
};

describe("an application deploy on a build server (T-11843)", () => {
	let host: ReturnType<typeof makeHost>;
	let killScript: (reason: Error) => void;
	let stop: Mock<WatchdogDeps["stop"]>;
	let status: string;

	/**
	 * Stands in for the shell: runs the deploy script (the command that ends in
	 * `>> <log> 2>&1`) as the scenario says, and answers the two commands
	 * Dokploy itself sends to the log: the append of a mark and the look for the
	 * line of the build start.
	 */
	const installHost = (
		script: (command: string, scripts: string[]) => Promise<void>,
	) => {
		vi.mocked(execProcess.execAsyncRemote).mockImplementation((async (
			serverId: string,
			command: string,
		) => {
			if (command.includes("grep -cxF")) {
				host.greps.push(serverId);
				return {
					stdout: host.hasLine(BUILD_START_LINE) ? "1\n" : "0\n",
					stderr: "",
				};
			}
			const mark = command.match(/^echo "([A-Za-z0-9+/=]+)" \| base64 -d >> /);
			if (mark) {
				host.appends.push({
					serverId,
					text: Buffer.from(mark[1] as string, "base64").toString("utf8"),
				});
				host.append(Buffer.from(mark[1] as string, "base64").toString("utf8"));
				return { stdout: "", stderr: "" };
			}
			if (command.includes(`>> ${LOG_PATH} 2>&1`)) {
				host.scripts.push(command);
				// A kill of the process (the watchdog's stop) ends the script.
				await Promise.race([
					script(command, host.scripts),
					new Promise<never>((_, reject) => {
						killScript = reject;
					}),
				]);
			}
			return { stdout: "", stderr: "" };
		}) as any);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		host = makeHost();
		status = "running";

		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			application as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			application as any,
		);
		vi.mocked(db.query.deployHook.findFirst).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(db.query.deployments.findFirst).mockImplementation((async () => ({
			status,
		})) as any);
		vi.mocked(adminService.getDokployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		vi.mocked(deploymentService.createDeployment).mockResolvedValue({
			deploymentId: DEPLOYMENT_ID,
			logPath: LOG_PATH,
			serverId: APP_SERVER,
			buildServerId: BUILD_SERVER,
		} as any);
		vi.mocked(builders.getBuildCommand).mockResolvedValue("echo build;");
		vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
			{} as any,
		);
		vi.mocked(
			successNotifications.sendBuildSuccessNotifications,
		).mockResolvedValue(undefined as any);
		vi.mocked(notifications.sendBuildErrorNotifications).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
			message: "test commit",
			hash: "abc123",
		});
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
		vi.mocked(deploymentService.getDeploymentErrorMessage).mockResolvedValue(
			"error message",
		);
		vi.mocked(hooks.runDeployHook).mockResolvedValue(undefined as any);
		vi.mocked(dockerUtils.waitForSwarmServiceStable).mockResolvedValue({
			stable: true,
		} as any);
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);

		stop = vi.fn<WatchdogDeps["stop"]>(async () => {
			status = "error";
			killScript?.(new Error("the watchdog stopped the process"));
			return {
				method: "launcher" as const,
				notRunning: false,
				claimedCancelled: true,
			};
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const makeWatchdog = () => {
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
			readStatus: async () => status as "running",
			listRunning: async () => (status === "running" ? [row] : []),
			latestDeploys: async () => [],
			resolveService: async () => ({
				applicationId: "test-app-id",
				composeId: null,
			}),
			// The real probe: the age of the log file, on the host that holds it.
			readLogIdleMs: async () => {
				const idle = Date.now() - host.lastWrite;
				maxIdleMs = Math.max(maxIdleMs, idle);
				return idle;
			},
			logHost: async (watched) => resolveDeploymentLogHost(watched),
			appendLog: async () => {
				host.append("Watchdog: marked failed\n");
			},
			stop,
			markFailed: async () => "flipped",
			failServiceIfRunning: async () => {},
			loadContext: async () => null,
			notify: async () => {},
			recordAudit: async () => {},
		} satisfies WatchdogDeps);
		return { watchdog, maxIdle: () => maxIdleMs };
	};

	const args = {
		applicationId: "test-app-id",
		titleLog: "t",
		descriptionLog: "",
	};

	it("puts the line of the build start after the clone and before the build", async () => {
		installHost(async () => {});
		await deployApplication(args);

		expect(host.scripts).toHaveLength(1);
		// Only the shell's view of the script counts, not how it is quoted.
		const script = (host.scripts[0] as string).replaceAll("\\", "");
		const clone = script.indexOf("git clone");
		const marker = script.indexOf(BUILD_START_LINE);
		const build = script.indexOf("echo build;");
		expect(clone).toBeGreaterThan(-1);
		expect(marker).toBeGreaterThan(clone);
		expect(build).toBeGreaterThan(marker);
	});

	it("is not failed while the push is silent for longer than the idle limit", async () => {
		installHost(async (_command) => {
			// The clone prints, as git does.
			host.append("Cloning Repo\n");
			await sleep(2 * MIN);
			host.append("Cloned\n");
			// The script's own echo, then the build and a push with nothing printed
			// for 25 minutes.
			host.append(`\n${BUILD_START_LINE}\n`);
			host.append("#1 [web 1/2] RUN npm run build\n");
			await sleep(3 * MIN);
			host.append("The push refers to repository [reg.example.com/acme/app]\n");
			await sleep(25 * MIN);
			host.append("digest: sha256:abc size: 1234\n");
		});
		const { watchdog, maxIdle } = makeWatchdog();

		const deploy = deployApplication(args);
		await sweepEveryMinute(watchdog, 2 + 3 + 25 + 5);
		await deploy;

		expect(stop).not.toHaveBeenCalled();
		expect(maxIdle()).toBeLessThan(10 * MIN);
		expect(builders.mechanizeDockerContainer).toHaveBeenCalledTimes(1);

		// The marks went to the host the script runs on, which is the host the
		// watchdog reads the log from: the build server, not the serving host.
		const hostThatWatchdogReads = await resolveDeploymentLogHost(row);
		expect(marksOf(host).length).toBeGreaterThan(0);
		expect(hostThatWatchdogReads).toBe(BUILD_SERVER);
		expect(
			marksOf(host).every((a) => a.serverId === hostThatWatchdogReads),
		).toBe(true);
		expect(host.greps.every((id) => id === hostThatWatchdogReads)).toBe(true);
		expect(marksOf(host)[0]?.text).toContain("The build");
	});

	it("still fails a clone that goes silent, at the idle limit", async () => {
		installHost(async () => {
			host.append("Cloning Repo\n");
			// The git server stops answering: nothing more is printed, and the
			// script never gets to the line of the build start.
			await sleep(10 * 60 * MIN);
		});
		const { watchdog } = makeWatchdog();

		const deploy = deployApplication(args).catch((error) => error);
		let failedAtMinute = -1;
		for (let minute = 1; minute <= 40 && failedAtMinute < 0; minute++) {
			await vi.advanceTimersByTimeAsync(MIN);
			await watchdog.sweep();
			if (stop.mock.calls.length > 0) failedAtMinute = minute;
		}
		await deploy;

		expect(stop).toHaveBeenCalledTimes(1);
		// 20 minutes of silence, found by the sweep right after it, nowhere near
		// the 90 minute wall limit.
		expect(failedAtMinute).toBeGreaterThanOrEqual(20);
		expect(failedAtMinute).toBeLessThanOrEqual(22);
		// Dokploy wrote no mark while the clone hung.
		expect(marksOf(host)).toEqual([]);
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("does not take another deployment's line, or git output that quotes the line, for its own", async () => {
		installHost(async () => {
			// Two deployments of one app in the same second share a log file.
			host.append(`\n${getBuildStartLine("other-deployment-id")}\n`);
			// A git server can print what it likes after "remote: ".
			host.append(`remote: ${BUILD_START_LINE}\n`);
			await sleep(10 * 60 * MIN);
		});
		const { watchdog } = makeWatchdog();

		const deploy = deployApplication(args).catch((error) => error);
		let failedAtMinute = -1;
		for (let minute = 1; minute <= 40 && failedAtMinute < 0; minute++) {
			await vi.advanceTimersByTimeAsync(MIN);
			await watchdog.sweep();
			if (stop.mock.calls.length > 0) failedAtMinute = minute;
		}
		await deploy;

		// No mark was written, so the hung clone is failed at the idle limit.
		expect(marksOf(host)).toEqual([]);
		expect(failedAtMinute).toBeGreaterThanOrEqual(20);
		expect(failedAtMinute).toBeLessThanOrEqual(22);
	});

	it("writes no more marks once the deployment is no longer running", async () => {
		installHost(async () => {
			host.append(`\n${BUILD_START_LINE}\n`);
			// A step that goes on after the watchdog failed the deployment.
			await sleep(60 * MIN);
		});

		const deploy = deployApplication(args).catch((error) => error);
		await vi.advanceTimersByTimeAsync(12 * MIN);
		// The tick of minute 5 saw the line of the build start and marked at once,
		// the one of minute 10 marked again.
		expect(marksOf(host)).toHaveLength(2);
		status = "error";
		await vi.advanceTimersByTimeAsync(50 * MIN);
		await deploy;

		expect(marksOf(host)).toHaveLength(2);
	});
});
