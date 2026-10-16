import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cancelling a build-server compose while the release (the rolling replace) is
 * running on the serving host. The build server has nothing to kill by then, so
 * the cancel has to signal the release step where it runs: on the serving host,
 * or on the Dokploy host itself for a compose without a server.
 */

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	execAsyncCancelable: vi.fn(),
	appendFile: vi.fn(),
	returning: vi.fn(),
	updateSets: [] as any[],
	deploymentsFindFirst: vi.fn(),
	deploymentsFindMany: vi.fn(),
	composeFindFirst: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ appendFile: mocks.appendFile }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	execAsyncCancelable: mocks.execAsyncCancelable,
}));
vi.mock("@dokploy/server/db", () => {
	const update = vi.fn(() => ({
		set: (values: any) => {
			mocks.updateSets.push(values);
			const where = () => {
				const result: any = Promise.resolve([]);
				result.returning = mocks.returning;
				return result;
			};
			return { where };
		},
	}));
	return {
		db: {
			update,
			query: {
				deployments: {
					findFirst: mocks.deploymentsFindFirst,
					findMany: mocks.deploymentsFindMany,
				},
				compose: { findFirst: mocks.composeFindFirst },
				applications: { findFirst: vi.fn() },
			},
		},
	};
});

import {
	cancelBuildServerDeployment,
	cancelBuildServerDeploymentById,
	cancelBuildServerDeploymentsForService,
	DeploymentCancelledError,
	runReleaseScript,
} from "@dokploy/server/services/deployment-cancel";
import {
	getReleaseCancelKey,
	getReleaseCancelTarget,
	getRemoteBuildCancelTarget,
	RELEASE_KILL_GRACE_SECONDS,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import { registerRemoteBuild } from "@dokploy/server/utils/process/remote-build-registry";

const isKill = (command: unknown) => String(command).includes("kill -s TERM");

const killsOn = (serverId: string) =>
	mocks.execAsyncRemote.mock.calls
		.filter((call) => call[0] === serverId && isKill(call[1]))
		.map((call) => String(call[1]));

const decodedLogLines = () =>
	[...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1]))]
		.filter((command) => command.includes("base64 -d"))
		.map((command) =>
			Buffer.from(command.match(/echo "([^"]+)"/)?.[1] ?? "", "base64").toString(
				"utf8",
			),
		)
		.join("\n");

/** Build server answer, release host answer. */
const answers = (build: string, release: string) => {
	mocks.execAsyncRemote.mockImplementation(
		async (serverId: string, command: string) => {
			if (!isKill(command)) return { stdout: "", stderr: "" };
			return { stdout: `${serverId === "build-1" ? build : release}\n`, stderr: "" };
		},
	);
	mocks.execAsync.mockImplementation(async (command: string) =>
		isKill(command)
			? { stdout: `${release}\n`, stderr: "" }
			: { stdout: "", stderr: "" },
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateSets.length = 0;
	mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);
	mocks.execAsyncRemote.mockReset();
	mocks.execAsync.mockReset();
	answers("NONE", "KILLED");
});

describe("release cancel target", () => {
	it("has its own pid file and owner key, never the build's", () => {
		const build = getRemoteBuildCancelTarget("dep-1");
		const release = getReleaseCancelTarget("dep-1", true);

		expect(release.pidFile).not.toBe(build.pidFile);
		expect(release.deploymentId).toBe(getReleaseCancelKey("dep-1"));
		expect(release.deploymentId).not.toBe(build.deploymentId);
		expect(release.pidFile).toBe("/etc/dokploy/logs/.build-pids/dep-1_release.pid");
	});

	it("uses the layout of the host it runs on", () => {
		const remote = getReleaseCancelTarget("dep-1", true);
		const local = getReleaseCancelTarget("dep-1", false);

		expect(remote.pidFile.startsWith("/etc/dokploy/logs/")).toBe(true);
		expect(local.pidFile.endsWith("/logs/.build-pids/dep-1_release.pid")).toBe(
			true,
		);
	});
});

describe("cancelBuildServerDeployment with a release host", () => {
	const target = {
		deploymentId: "dep-1",
		logPath: "/etc/dokploy/logs/app/app-1.log",
		logServerId: "serving-1",
		buildServerId: "build-1",
		releaseHost: { serverId: "serving-1" as string | null },
	};

	it("signals the release step on the serving host when the build server has nothing to kill", async () => {
		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toEqual({
			status: "cancelled",
			result: "KILLED",
			warning: undefined,
		});
		const [kill] = killsOn("serving-1");
		expect(kill).toBeDefined();
		// Its own pid file and owner, with the longer grace for the trap.
		expect(kill).toContain("/etc/dokploy/logs/.build-pids/dep-1_release.pid");
		expect(kill).toContain("id='dep-1.release'");
		expect(kill).toContain(`-lt ${RELEASE_KILL_GRACE_SECONDS}`);
		// The build's own pid file is looked at on the build server only.
		expect(killsOn("build-1")).toHaveLength(1);
		expect(killsOn("build-1")[0]).toContain("dep-1.pid");
		expect(decodedLogLines()).toContain("release step was stopped");
	});

	it("does not touch the serving host when a build was just killed", async () => {
		answers("KILLED", "KILLED");

		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
		expect(killsOn("serving-1")).toHaveLength(0);
		expect(decodedLogLines()).toContain("Build stopped on the build server");
	});

	it("signals the Dokploy host itself when the compose has no server", async () => {
		const outcome = await cancelBuildServerDeployment({
			...target,
			logServerId: null,
			releaseHost: { serverId: null },
		});

		expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
		const local = mocks.execAsync.mock.calls
			.map((call) => String(call[0]))
			.filter(isKill);
		expect(local).toHaveLength(1);
		expect(local[0]).toContain("id='dep-1.release'");
		expect(local[0]).toContain(".build-pids/dep-1_release.pid");
		// And nothing was sent to a serving host that does not exist.
		expect(
			mocks.execAsyncRemote.mock.calls.filter((call) => call[0] !== "build-1"),
		).toHaveLength(0);
	});

	it("drops the wait for the release command only after the kill answered", async () => {
		const order: string[] = [];
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string, command: string) => {
				if (isKill(command)) order.push(`kill:${serverId}`);
				return {
					stdout: isKill(command) && serverId === "serving-1" ? "KILLED\n" : "NONE\n",
					stderr: "",
				};
			},
		);
		const releaseAbort = vi.fn(() => order.push("abort:release"));
		const dropRelease = registerRemoteBuild(
			getReleaseCancelKey("dep-1"),
			releaseAbort,
		);

		await cancelBuildServerDeployment(target);
		dropRelease();

		expect(order.slice(0, 2)).toEqual(["kill:build-1", "kill:serving-1"]);
		expect(releaseAbort).toHaveBeenCalledTimes(1);
		expect(order.indexOf("abort:release")).toBeGreaterThan(
			order.indexOf("kill:serving-1"),
		);
	});

	it("looks again while the release step is starting and has no pid file yet", async () => {
		let kills = 0;
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string, command: string) => {
				if (!isKill(command)) return { stdout: "", stderr: "" };
				if (serverId === "build-1") return { stdout: "NONE\n", stderr: "" };
				kills++;
				return { stdout: kills === 1 ? "NONE\n" : "KILLED\n", stderr: "" };
			},
		);
		// Registered under the release key: the build's own retry must not see it.
		const unregister = registerRemoteBuild(getReleaseCancelKey("dep-1"), () => {});

		const outcome = await cancelBuildServerDeployment(target);
		unregister();

		expect(kills).toBe(2);
		expect(killsOn("build-1")).toHaveLength(1);
		expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
	}, 15000);

	it("does not call it stopped when the release command is running but left no pid file", async () => {
		answers("NONE", "NONE");
		const unregister = registerRemoteBuild(getReleaseCancelKey("dep-1"), () => {});

		const outcome = await cancelBuildServerDeployment(target);
		unregister();

		expect(outcome).toMatchObject({ status: "cancelled", result: "NONE" });
		const warning = (outcome as any).warning as string;
		expect(warning).toContain("release step");
		expect(warning).toContain("pid file was not found");
		expect(decodedLogLines()).toContain("pid file was not found");
	}, 15000);

	it("still cancels, with a warning, when the serving host is unreachable", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string, command: string) => {
				if (serverId === "serving-1" && isKill(command)) {
					throw new Error("connect ETIMEDOUT");
				}
				return { stdout: isKill(command) ? "NONE\n" : "", stderr: "" };
			},
		);

		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome.status).toBe("cancelled");
		const warning = (outcome as any).warning as string;
		expect(warning).toContain("Could not reach the serving host");
		expect(warning).toContain("ETIMEDOUT");
		expect(mocks.updateSets.some((set) => set.errorMessage)).toBe(true);
	});

	it("warns when the release process survived SIGKILL", async () => {
		answers("NONE", "FAILED");

		const outcome = await cancelBuildServerDeployment(target);

		const warning = (outcome as any).warning as string;
		expect(warning).toContain("did not stop after SIGKILL");
	});

	it("a deployment without a release host (an application) never looks at one", async () => {
		const { releaseHost: _unused, ...application } = target;

		await cancelBuildServerDeployment(application);

		expect(killsOn("serving-1")).toHaveLength(0);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("the compose entry points pass the serving host", () => {
	it("compose.killBuild's cancel signals the release step on the compose's server", async () => {
		mocks.composeFindFirst.mockResolvedValue({
			buildServerId: "build-1",
			serverId: "serving-1",
		});
		mocks.deploymentsFindMany.mockResolvedValue([
			{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
		]);

		const outcome = await cancelBuildServerDeploymentsForService({
			type: "compose",
			composeId: "c1",
		});

		expect(outcome).toMatchObject({ usesBuildServer: true, cancelled: 1 });
		expect(killsOn("serving-1")).toHaveLength(1);
	});

	it("deployment.killProcess' cancel signals it on the Dokploy host for a compose without a server", async () => {
		mocks.deploymentsFindFirst.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: "/l/dep-1.log",
			composeId: "c1",
			applicationId: null,
			buildServerId: "build-1",
		});
		mocks.composeFindFirst.mockResolvedValue({
			buildServerId: "build-1",
			serverId: null,
		});

		const outcome = await cancelBuildServerDeploymentById("dep-1");

		expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
		expect(
			mocks.execAsync.mock.calls.map((call) => String(call[0])).filter(isKill),
		).toHaveLength(1);
	});
});

describe("runReleaseScript", () => {
	const notCancelled = () =>
		mocks.deploymentsFindFirst.mockResolvedValue({ status: "running" });
	const cancelled = () =>
		mocks.deploymentsFindFirst.mockResolvedValue({ status: "cancelled" });

	it("runs the script on the serving host as a cancelable command with the release target", async () => {
		notCancelled();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await runReleaseScript({
			serverId: "serving-1",
			command: "echo release",
			deploymentId: "dep-1",
		});

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [serverId, command, onData, options] =
			mocks.execAsyncRemote.mock.calls[0] ?? [];
		expect(serverId).toBe("serving-1");
		expect(command).toBe("echo release");
		expect(onData).toBeUndefined();
		expect(options.cancelable).toEqual(getReleaseCancelTarget("dep-1", true));
		expect(typeof options.beforeExec).toBe("function");
	});

	it("runs it on the Dokploy host, cancelable, when there is no serving host", async () => {
		notCancelled();
		mocks.execAsyncCancelable.mockResolvedValue({ stdout: "", stderr: "" });

		await runReleaseScript({
			serverId: null,
			command: "echo release",
			deploymentId: "dep-1",
		});

		const [command, target, options] = mocks.execAsyncCancelable.mock.calls[0] ?? [];
		expect(command).toBe("echo release");
		expect(target).toEqual(getReleaseCancelTarget("dep-1", false));
		expect(typeof options.beforeExec).toBe("function");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("does not start when the deployment was cancelled already", async () => {
		cancelled();

		await expect(
			runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			}),
		).rejects.toMatchObject({ deploymentCancelled: true });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("re-checks the cancel flag once registered, right before the command is sent", async () => {
		notCancelled();
		mocks.execAsyncRemote.mockImplementation(
			async (_s: string, _c: string, _d: unknown, options: any) => {
				cancelled();
				await options.beforeExec();
				return { stdout: "", stderr: "" };
			},
		);

		await expect(
			runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			}),
		).rejects.toMatchObject({ deploymentCancelled: true });
	});

	it("a signalled script after a cancel is the cancellation, and says it was mid-release", async () => {
		notCancelled();
		mocks.execAsyncRemote.mockImplementation(async () => {
			cancelled();
			throw new Error("Command failed with signal SIGTERM");
		});

		const error = await runReleaseScript({
			serverId: "serving-1",
			command: "echo release",
			deploymentId: "dep-1",
		}).catch((e) => e);

		expect(error).toBeInstanceOf(DeploymentCancelledError);
		expect(error).toMatchObject({
			deploymentCancelled: true,
			duringRelease: true,
		});
	});

	it("a failing script that nobody cancelled stays an ordinary failure", async () => {
		notCancelled();
		const failure = new Error("Rolling replace of web failed");
		mocks.execAsyncRemote.mockRejectedValue(failure);

		await expect(
			runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			}),
		).rejects.toBe(failure);
	});
});
