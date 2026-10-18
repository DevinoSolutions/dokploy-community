import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	beginReleaseCancel,
	registerRemoteBuild,
	takeReleaseCancel,
} from "@dokploy/server/utils/process/remote-build-registry";

const isKill = (command: unknown) => String(command).includes("kill -s TERM");

const killsOn = (serverId: string) =>
	mocks.execAsyncRemote.mock.calls
		.filter((call) => call[0] === serverId && isKill(call[1]))
		.map((call) => String(call[1]));

const decodedLogLines = () =>
	[...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1]))]
		.filter((command) => command.includes("base64 -d"))
		.map((command) =>
			Buffer.from(
				command.match(/echo "([^"]+)"/)?.[1] ?? "",
				"base64",
			).toString("utf8"),
		)
		.join("\n");

/** Build server answer, release host answer. */
const answers = (build: string, release: string) => {
	mocks.execAsyncRemote.mockImplementation(
		async (serverId: string, command: string) => {
			if (!isKill(command)) return { stdout: "", stderr: "" };
			return {
				stdout: `${serverId === "build-1" ? build : release}\n`,
				stderr: "",
			};
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
		expect(release.pidFile).toBe(
			"/etc/dokploy/logs/.build-pids/dep-1_release.pid",
		);
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

/** A release step of dep-1 that this process is waiting on, like a live deploy. */
let releaseWaiting: (() => void) | undefined;
const startWaitingOnRelease = () => {
	releaseWaiting = registerRemoteBuild(getReleaseCancelKey("dep-1"), () => {});
};
afterEach(() => {
	releaseWaiting?.();
	releaseWaiting = undefined;
});

describe("cancelBuildServerDeployment with a release host", () => {
	beforeEach(startWaitingOnRelease);

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
			genericStopNeeded: false,
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
					stdout:
						isKill(command) && serverId === "serving-1" ? "KILLED\n" : "NONE\n",
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
		const unregister = registerRemoteBuild(
			getReleaseCancelKey("dep-1"),
			() => {},
		);

		const outcome = await cancelBuildServerDeployment(target);
		unregister();

		expect(kills).toBe(2);
		expect(killsOn("build-1")).toHaveLength(1);
		expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
	}, 15000);

	it("does not call it stopped when the release command is running but left no pid file", async () => {
		answers("NONE", "NONE");
		const unregister = registerRemoteBuild(
			getReleaseCancelKey("dep-1"),
			() => {},
		);

		const outcome = await cancelBuildServerDeployment(target);
		unregister();

		expect(outcome).toMatchObject({ status: "cancelled", result: "NONE" });
		const warning = (outcome as any).warning as string;
		expect(warning).toContain("release step");
		expect(warning).toContain("pid file was not found");
		expect(decodedLogLines()).toContain("pid file was not found");
	}, 15000);

	it("sends nothing to the serving host when no release step is running", async () => {
		releaseWaiting?.();
		releaseWaiting = undefined;

		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toMatchObject({ status: "cancelled", result: "NONE" });
		expect((outcome as any).warning).toBeUndefined();
		expect(killsOn("serving-1")).toHaveLength(0);
		expect(
			mocks.execAsyncRemote.mock.calls
				.filter((call) => call[0] === "serving-1")
				.every((call) => String(call[1]).includes("base64 -d")),
		).toBe(true);
		expect(decodedLogLines()).toContain("No build was running");
	});

	it("still cancels, with a warning, when the serving host is unreachable", async () => {
		const unregister = registerRemoteBuild(
			getReleaseCancelKey("dep-1"),
			() => {},
		);
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string, command: string) => {
				if (serverId === "serving-1" && isKill(command)) {
					throw new Error("connect ETIMEDOUT");
				}
				return { stdout: isKill(command) ? "NONE\n" : "", stderr: "" };
			},
		);

		const outcome = await cancelBuildServerDeployment(target);
		unregister();

		expect(outcome.status).toBe("cancelled");
		const warning = (outcome as any).warning as string;
		expect(warning).toContain("Could not reach the serving host");
		expect(warning).toContain("ETIMEDOUT");
		expect(mocks.updateSets.some((set) => set.errorMessage)).toBe(true);
	});

	it("asks the release kill to report a hard kill, and warns when SIGKILL was needed", async () => {
		answers("NONE", "KILLED_HARD");

		const outcome = await cancelBuildServerDeployment(target);

		expect(killsOn("serving-1")[0]).toContain("echo KILLED_HARD");
		// The build's own kill never reports it.
		expect(killsOn("build-1")[0]).not.toContain("KILLED_HARD");
		expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
		const warning = (outcome as any).warning as string;
		expect(warning).toContain("was killed");
		expect(warning).toContain("may still be running on its own");
		expect(decodedLogLines()).toContain("was killed");
		expect(mocks.updateSets.some((set) => set.errorMessage === warning)).toBe(
			true,
		);
	});

	it("records for the deploy side whether the step had to be SIGKILLed", async () => {
		const key = getReleaseCancelKey("dep-1");

		answers("NONE", "KILLED_HARD");
		await cancelBuildServerDeployment(target);
		expect(await takeReleaseCancel(key, 10)).toEqual({ hardKilled: true });

		answers("NONE", "KILLED");
		await cancelBuildServerDeployment(target);
		expect(await takeReleaseCancel(key, 10)).toEqual({ hardKilled: false });
	});

	it("a release step that stopped on SIGTERM has no warning", async () => {
		answers("NONE", "KILLED");

		const outcome = await cancelBuildServerDeployment(target);

		expect((outcome as any).warning).toBeUndefined();
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
	beforeEach(startWaitingOnRelease);

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

describe("a compose that builds on its serving host (no build server)", () => {
	const target = {
		deploymentId: "dep-1",
		logPath: "/etc/dokploy/logs/app/app-1.log",
		logServerId: "serving-1" as string | null,
		buildServerId: null,
		releaseHost: { serverId: "serving-1" as string | null },
	};

	it("signals only the release step, on the serving host, and never contacts a build server", async () => {
		startWaitingOnRelease();

		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toEqual({
			status: "cancelled",
			result: "KILLED",
			warning: undefined,
			genericStopNeeded: false,
		});
		const kills = mocks.execAsyncRemote.mock.calls
			.filter((call) => isKill(call[1]))
			.map((call) => [call[0], String(call[1])]);
		expect(kills).toHaveLength(1);
		expect(kills[0]?.[0]).toBe("serving-1");
		expect(kills[0]?.[1]).toContain("id='dep-1.release'");
		expect(kills[0]?.[1]).toContain(`-lt ${RELEASE_KILL_GRACE_SECONDS}`);
		const log = decodedLogLines();
		expect(log).toContain("Stopping the rolling replace on the serving host");
		expect(log).toContain("release step was stopped");
		expect(log).not.toContain("build server");
	});

	it("signals the Dokploy host itself when the compose has no server", async () => {
		startWaitingOnRelease();

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
		expect(local[0]).toContain(".build-pids/dep-1_release.pid");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("drops the wait for the release command after the kill answered", async () => {
		const order: string[] = [];
		mocks.execAsyncRemote.mockImplementation(async (_s: string, c: string) => {
			if (isKill(c)) order.push("kill");
			return { stdout: isKill(c) ? "KILLED\n" : "", stderr: "" };
		});
		const drop = registerRemoteBuild(getReleaseCancelKey("dep-1"), () => {
			order.push("abort");
		});

		await cancelBuildServerDeployment(target);
		drop();

		expect(order).toEqual(["kill", "abort"]);
	});

	it("reports the generic stop as needed when the release step could not be signalled", async () => {
		startWaitingOnRelease();
		answers("NONE", "NONE");

		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toMatchObject({
			status: "cancelled",
			genericStopNeeded: true,
		});
		expect((outcome as any).warning).toContain("pid file was not found");
	});

	it.each(["UNVERIFIED", "FAILED"])(
		"reports the generic stop as needed on %s",
		async (answer) => {
			startWaitingOnRelease();
			answers("NONE", answer);

			const outcome = await cancelBuildServerDeployment(target);

			expect(outcome).toMatchObject({ genericStopNeeded: true });
		},
	);

	it("a release step that was stopped (even by SIGKILL) needs no generic stop", async () => {
		startWaitingOnRelease();
		answers("NONE", "KILLED_HARD");

		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toMatchObject({ genericStopNeeded: false });
	});

	it("says so when no release step was running", async () => {
		const outcome = await cancelBuildServerDeployment(target);

		expect(outcome).toMatchObject({ status: "cancelled", result: "NONE" });
		expect(decodedLogLines()).toContain("No release step was running");
		expect(
			mocks.execAsyncRemote.mock.calls.filter((call) => isKill(call[1])),
		).toHaveLength(0);
	});

	it("warns when the release step had to be killed", async () => {
		startWaitingOnRelease();
		answers("NONE", "KILLED_HARD");

		const outcome = await cancelBuildServerDeployment(target);

		expect((outcome as any).warning).toContain("was killed");
	});

	describe("the entry points", () => {
		beforeEach(() => {
			mocks.composeFindFirst.mockResolvedValue({
				buildServerId: null,
				serverId: "serving-1",
			});
		});

		it("compose.killBuild's cancel stops a rolling replace that is running", async () => {
			startWaitingOnRelease();
			mocks.deploymentsFindMany.mockResolvedValue([
				{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
			]);

			const outcome = await cancelBuildServerDeploymentsForService({
				type: "compose",
				composeId: "c1",
			});

			expect(outcome).toMatchObject({ usesBuildServer: false, cancelled: 1 });
			expect(killsOn("serving-1")).toHaveLength(1);
		});

		it("counts a release step that could not be signalled as cancelled but not stopped", async () => {
			startWaitingOnRelease();
			answers("NONE", "NONE");
			mocks.deploymentsFindMany.mockResolvedValue([
				{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
			]);

			const outcome = await cancelBuildServerDeploymentsForService({
				type: "compose",
				composeId: "c1",
			});

			expect(outcome).toMatchObject({
				usesBuildServer: false,
				cancelled: 1,
				stopped: 0,
			});
		});

		it("leaves a deployment that is not in a rolling replace to the caller (cancelled 0, nothing claimed)", async () => {
			// Running, but this process is not waiting on a cancelable release step.
			mocks.deploymentsFindMany.mockResolvedValue([
				{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
			]);

			const outcome = await cancelBuildServerDeploymentsForService({
				type: "compose",
				composeId: "c1",
			});

			expect(outcome).toEqual({
				usesBuildServer: false,
				cancelled: 0,
				stopped: 0,
				warnings: [],
				deploymentIds: [],
			});
			expect(mocks.updateSets).toHaveLength(0);
			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expect(mocks.execAsync).not.toHaveBeenCalled();
		});

		it("deployment.killProcess' cancel stops a rolling replace that is running", async () => {
			startWaitingOnRelease();
			mocks.deploymentsFindFirst.mockResolvedValue({
				deploymentId: "dep-1",
				logPath: "/l/dep-1.log",
				composeId: "c1",
				applicationId: null,
				buildServerId: null,
			});

			const outcome = await cancelBuildServerDeploymentById("dep-1");

			expect(outcome).toMatchObject({ status: "cancelled", result: "KILLED" });
			expect(killsOn("serving-1")).toHaveLength(1);
		});

		describe("a compose with a rolling replace, before its release step exists (T-2721)", () => {
			const ROLLING = {
				enabled: true,
				services: ["web"],
				healthTimeoutSeconds: 60,
				drainSeconds: 0,
			};
			const rollingCompose = () =>
				mocks.composeFindFirst.mockResolvedValue({
					buildServerId: null,
					serverId: "serving-1",
					rollingReplace: ROLLING,
				});
			const runningRow = {
				deploymentId: "dep-1",
				logPath: "/l/dep-1.log",
				composeId: "c1",
				applicationId: null,
				buildServerId: null,
			};

			it("compose.killBuild's cancel claims the deployment while it is still cloning or patching", async () => {
				rollingCompose();
				mocks.deploymentsFindMany.mockResolvedValue([
					{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
				]);

				const outcome = await cancelBuildServerDeploymentsForService({
					type: "compose",
					composeId: "c1",
				});

				// Claimed (the deploy sees it at its next step) but not stopped: the
				// caller keeps its generic stop, which a plain `up` still needs.
				expect(outcome).toEqual({
					usesBuildServer: false,
					cancelled: 1,
					stopped: 0,
					warnings: [],
					deploymentIds: ["dep-1"],
				});
				expect(mocks.updateSets[0]).toMatchObject({ status: "cancelled" });
				expect(killsOn("serving-1")).toHaveLength(0);
				expect(decodedLogLines()).toContain(
					"A step already in progress (fetching the source, applying patches) is let finish",
				);
			});

			it("deployment.killProcess' cancel claims it too, and needs no generic stop", async () => {
				rollingCompose();
				mocks.deploymentsFindFirst.mockResolvedValue(runningRow);

				const outcome = await cancelBuildServerDeploymentById("dep-1");

				expect(outcome).toMatchObject({
					status: "cancelled",
					result: "NONE",
					genericStopNeeded: false,
				});
				expect(mocks.updateSets[0]).toMatchObject({ status: "cancelled" });
				expect(killsOn("serving-1")).toHaveLength(0);
			});

			it("a deployment that already ended is not claimed", async () => {
				rollingCompose();
				mocks.returning.mockResolvedValue([]);
				mocks.deploymentsFindFirst.mockResolvedValue(runningRow);

				await expect(cancelBuildServerDeploymentById("dep-1")).resolves.toEqual(
					{ status: "not-running" },
				);
				expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			});

			it("once the release step runs, the cancel still goes through the release launcher", async () => {
				rollingCompose();
				startWaitingOnRelease();
				mocks.deploymentsFindMany.mockResolvedValue([
					{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
				]);

				const outcome = await cancelBuildServerDeploymentsForService({
					type: "compose",
					composeId: "c1",
				});

				expect(outcome).toMatchObject({ cancelled: 1, stopped: 1 });
				expect(killsOn("serving-1")).toHaveLength(1);
			});

			it("a release step that could not be signalled still needs the generic stop", async () => {
				rollingCompose();
				startWaitingOnRelease();
				answers("NONE", "NONE");
				mocks.deploymentsFindFirst.mockResolvedValue(runningRow);

				const outcome = await cancelBuildServerDeploymentById("dep-1");

				expect(outcome).toMatchObject({
					status: "cancelled",
					genericStopNeeded: true,
				});
			});

			it("a build-server compose does not go through this path", async () => {
				mocks.composeFindFirst.mockResolvedValue({
					buildServerId: "build-1",
					serverId: "serving-1",
					rollingReplace: ROLLING,
				});
				mocks.deploymentsFindMany.mockResolvedValue([
					{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
				]);

				const outcome = await cancelBuildServerDeploymentsForService({
					type: "compose",
					composeId: "c1",
				});

				expect(outcome).toMatchObject({ usesBuildServer: true, cancelled: 1 });
				// The build server is asked first, as before.
				expect(
					mocks.execAsyncRemote.mock.calls.filter(
						(call) => call[0] === "build-1" && isKill(call[1]),
					),
				).toHaveLength(1);
			});

			it("a compose with the rolling replace switched off is left to the caller", async () => {
				mocks.composeFindFirst.mockResolvedValue({
					buildServerId: null,
					serverId: "serving-1",
					rollingReplace: { ...ROLLING, enabled: false },
				});
				mocks.deploymentsFindMany.mockResolvedValue([
					{ deploymentId: "dep-1", logPath: "/l/dep-1.log" },
				]);

				const outcome = await cancelBuildServerDeploymentsForService({
					type: "compose",
					composeId: "c1",
				});

				expect(outcome).toMatchObject({ cancelled: 0, stopped: 0 });
				expect(mocks.updateSets).toHaveLength(0);
				await expect(
					(async () => {
						mocks.deploymentsFindFirst.mockResolvedValue(runningRow);
						return cancelBuildServerDeploymentById("dep-1");
					})(),
				).resolves.toBeNull();
			});
		});

		it("deployment.killProcess keeps its pid kill for a compose deploy that is not in a rolling replace", async () => {
			mocks.deploymentsFindFirst.mockResolvedValue({
				deploymentId: "dep-1",
				logPath: "/l/dep-1.log",
				composeId: "c1",
				applicationId: null,
				buildServerId: null,
			});

			await expect(
				cancelBuildServerDeploymentById("dep-1"),
			).resolves.toBeNull();
			expect(mocks.updateSets).toHaveLength(0);
		});
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

		const [command, target, options] =
			mocks.execAsyncCancelable.mock.calls[0] ?? [];
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

	it.each([130, 137, 143])(
		"a script that ended with exit %i after a cancel is the cancellation, mid-release",
		async (exitCode) => {
			notCancelled();
			mocks.execAsyncRemote.mockImplementation(async () => {
				cancelled();
				throw new ExecError(
					`Remote command failed with exit code ${exitCode}`,
					{
						command: "x",
						exitCode,
					},
				);
			});

			const error = await runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			}).catch((e) => e);

			expect(error).toMatchObject({
				deploymentCancelled: true,
				duringRelease: true,
			});
		},
	);

	it.each([
		[130, false],
		[143, false],
		[137, true],
	])(
		"exit %i after a cancel: releaseKilled is %s",
		async (exitCode, releaseKilled) => {
			notCancelled();
			mocks.execAsyncRemote.mockImplementation(async () => {
				cancelled();
				throw new ExecError(
					`Remote command failed with exit code ${exitCode}`,
					{
						command: "x",
						exitCode,
					},
				);
			});

			const error = await runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			}).catch((e) => e);

			expect(error).toMatchObject({ duringRelease: true, releaseKilled });
		},
	);

	describe("whether the release step was killed, as the cancel side saw it", () => {
		const key = getReleaseCancelKey("dep-1");

		// Under a plain sh (no $SHELL, the Dokploy container) the launcher dies of
		// the TERM itself and reports 143 whether or not the step was SIGKILLed.
		const endsWith143 = (afterMs?: () => void) =>
			mocks.execAsyncRemote.mockImplementation(async () => {
				cancelled();
				afterMs?.();
				throw new ExecError("Remote command failed with exit code 143", {
					command: "x",
					exitCode: 143,
				});
			});

		const run = () =>
			runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			}).catch((e) => e);

		it("exit 143 and the cancel side saw a SIGKILL: releaseKilled, even when the outcome arrives after the command ended", async () => {
			notCancelled();
			const settle = beginReleaseCancel(key);
			endsWith143(() => {
				setTimeout(() => settle({ hardKilled: true }), 50);
			});

			const error = await run();

			expect(error).toMatchObject({ duringRelease: true, releaseKilled: true });
			expect(await takeReleaseCancel(key, 10)).toBeUndefined();
		});

		it("exit 143 and the step stopped on SIGTERM: not releaseKilled", async () => {
			notCancelled();
			const settle = beginReleaseCancel(key);
			endsWith143(() => {
				setTimeout(() => settle({ hardKilled: false }), 50);
			});

			const error = await run();

			expect(error).toMatchObject({
				duringRelease: true,
				releaseKilled: false,
			});
		});

		it("exit 143 with no cancel announced (a signal from elsewhere): not releaseKilled", async () => {
			notCancelled();
			endsWith143();

			const error = await run();

			expect(error).toMatchObject({
				duringRelease: true,
				releaseKilled: false,
			});
		});

		it("exit 137 is releaseKilled whatever the cancel side said", async () => {
			notCancelled();
			const settle = beginReleaseCancel(key);
			settle({ hardKilled: false });
			mocks.execAsyncRemote.mockImplementation(async () => {
				cancelled();
				throw new ExecError("Remote command failed with exit code 137", {
					command: "x",
					exitCode: 137,
				});
			});

			const error = await run();

			expect(error).toMatchObject({ releaseKilled: true });
			expect(await takeReleaseCancel(key, 10)).toBeUndefined();
		});

		it("does not leak an outcome when the release command ended on its own", async () => {
			notCancelled();
			beginReleaseCancel(key);
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

			await runReleaseScript({
				serverId: "serving-1",
				command: "echo release",
				deploymentId: "dep-1",
			});

			expect(await takeReleaseCancel(key, 10)).toBeUndefined();
		});

		it("stops waiting for a cancel that never reports", async () => {
			beginReleaseCancel(key);

			expect(await takeReleaseCancel(key, 20)).toBeUndefined();
			expect(await takeReleaseCancel(key, 20)).toBeUndefined();
		});
	});

	it("a dropped connection after a cancel is the cancellation too", async () => {
		notCancelled();
		mocks.execAsyncRemote.mockImplementation(async () => {
			cancelled();
			throw new ExecError("Remote build was cancelled: cancelled by user", {
				command: "x",
			});
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

	it("a script that failed on its own after a cancel whose signal did not land stays an error", async () => {
		notCancelled();
		const failure = new ExecError("Remote command failed with exit code 1", {
			command: "x",
			exitCode: 1,
		});
		mocks.execAsyncRemote.mockImplementation(async () => {
			cancelled();
			throw failure;
		});

		const error = await runReleaseScript({
			serverId: "serving-1",
			command: "echo release",
			deploymentId: "dep-1",
		}).catch((e) => e);

		expect(error).toBe(failure);
		expect(error).not.toMatchObject({ deploymentCancelled: true });
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
