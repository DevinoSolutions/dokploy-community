import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deployment.killProcess` for a run of an application or compose schedule.
 *
 * The pid of such a run lives inside the service's container, so a plain
 * `kill -9 <pid>` on the host stops nothing, and the same pid can belong to an
 * unrelated process after a container restart. Those runs are stopped by the
 * `DOKPLOY_SCHEDULE_RUN=<deploymentId>` tag that `runCommand` gives their
 * process tree. The real `cancelScheduleRun` runs here; only the shell,
 * database and docker lookups are mocked.
 *
 * A cancelled run ends as `cancelled`, never `error`: the run is claimed
 * (`running` -> `cancelled`) before the kill is sent, so the run's own error
 * handling, which fires as soon as the kill lands, leaves it alone.
 */

const mocks = vi.hoisted(() => ({
	state: { cloud: false },
	findDeploymentById: vi.fn(),
	cancelBuildServerDeploymentById: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	claimScheduleRunCancel: vi.fn(),
	revertScheduleRunCancel: vi.fn(),
	endScheduleRunWithoutProcess: vi.fn(),
	findScheduleById: vi.fn(),
	getServiceContainer: vi.fn(),
	getComposeContainer: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	get IS_CLOUD() {
		return mocks.state.cloud;
	},
}));

// Who may cancel which kind of deployment is covered by
// deployment-schedule-org.test.ts and deployment-route-access.test.ts.
vi.mock("@dokploy/server/services/deployment-access", () => ({
	assertDeploymentAccess: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server/services/schedule", () => ({
	findScheduleById: mocks.findScheduleById,
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	getServiceContainer: mocks.getServiceContainer,
	getComposeContainer: mocks.getComposeContainer,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server", async () => {
	const {
		cancelHostScheduleRun,
		cancelScheduleRun,
		decideRunWithoutProcess,
		isMissingProcessError,
	} = await import("@dokploy/server/utils/schedules/cancel");
	const { getScheduleRunLaunch } = await import(
		"@dokploy/server/utils/schedules/launch"
	);
	return {
		get IS_CLOUD() {
			return mocks.state.cloud;
		},
		cancelHostScheduleRun,
		cancelScheduleRun,
		decideRunWithoutProcess,
		getScheduleRunLaunch,
		isMissingProcessError,
		STRANDED_LOG_LINE: "stranded-line",
		endScheduleRunWithoutProcess: mocks.endScheduleRunWithoutProcess,
		claimScheduleRunCancel: mocks.claimScheduleRunCancel,
		revertScheduleRunCancel: mocks.revertScheduleRunCancel,
		findDeploymentById: mocks.findDeploymentById,
		cancelBuildServerDeploymentById: mocks.cancelBuildServerDeploymentById,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
		updateDeploymentStatus: mocks.updateDeploymentStatus,
	};
});

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/cancel-audit", () => ({ auditCancel: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn() },
}));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "owner" },
};

const { SCHEDULE_KILL_SCRIPT, SCHEDULE_NONE_MARKER } = await import(
	"@dokploy/server/utils/schedules/container-run"
);
const {
	forgetScheduleRunLaunch,
	markScheduleRunChecking,
	markScheduleRunLaunched,
} = await import("@dokploy/server/utils/schedules/launch");
const { deploymentRouter } = await import("@/server/api/routers/deployment");
const caller = deploymentRouter.createCaller(
	ctx as Parameters<typeof deploymentRouter.createCaller>[0],
);

const deployment = (extra = {}) => ({
	deploymentId: "dep_1-A",
	applicationId: null,
	composeId: null,
	serverId: null,
	pid: "4242",
	status: "running",
	application: null,
	compose: null,
	schedule: {
		scheduleId: "sch-1",
		scheduleType: "application",
		serverId: null,
	},
	...extra,
});

const applicationSchedule = (serverId: string | null) => ({
	scheduleId: "sch-1",
	scheduleType: "application" as const,
	shellType: "sh",
	serviceName: null,
	serverId: null,
	compose: null,
	application: { appName: "my-app", serverId },
});

const composeSchedule = (serverId: string | null) => ({
	scheduleId: "sch-1",
	scheduleType: "compose" as const,
	shellType: "bash",
	serviceName: "web",
	serverId: null,
	application: null,
	compose: { appName: "my-compose", composeType: "docker-compose", serverId },
});

// The run is claimed before anything is killed and is never marked errored.
const expectCancelled = () => {
	expect(mocks.claimScheduleRunCancel).toHaveBeenCalledWith("dep_1-A");
	expect(mocks.revertScheduleRunCancel).not.toHaveBeenCalled();
	expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
	expect(mocks.audit).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ action: "cancel", resourceId: "dep_1-A" }),
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.state.cloud = false;
	mocks.cancelBuildServerDeploymentById.mockResolvedValue(null);
	mocks.claimScheduleRunCancel.mockResolvedValue("claim-1");
	mocks.revertScheduleRunCancel.mockResolvedValue(undefined);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
});

// What docker receives once the shell has unquoted the generated command.
const dockerArgs = (command: string) => {
	const result = spawnSync(
		"bash",
		[
			"-c",
			`docker() { printf '%s\\0' "$@"; }
${command}`,
		],
		{ encoding: "utf8" },
	);
	return result.stdout.split("\0").slice(0, -1);
};

describe("killProcess on an application schedule run", () => {
	it("kills inside the container on the application's server, by the run tag", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.getServiceContainer).toHaveBeenCalledWith("my-app", "srv-1");
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-1");
		expect(command).toMatch(/^docker exec cont-1 sh -c /);
		expect(command).toContain("DOKPLOY_SCHEDULE_RUN=");
		expect(command).toMatch(/ sh dep_1-A$/);
		expect(command).not.toContain("kill -9 4242");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("hands the kill script and the run id to the shell as separate arguments", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		expect(dockerArgs(command)).toEqual([
			"exec",
			"cont-1",
			"sh",
			"-c",
			SCHEDULE_KILL_SCRIPT,
			"sh",
			"dep_1-A",
		]);
	});

	it("kills through the local docker when the application runs on the Dokploy host", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule(null));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync.mock.calls[0]?.[0]).toMatch(
			/^docker exec cont-1 sh -c .* sh dep_1-A$/s,
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("never stops anything on Dokploy Cloud when there is no remote server", async () => {
		mocks.state.cloud = true;
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule(null));

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.getServiceContainer).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
		// Nothing was stopped, so the run is not left cancelled.
		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
	});

	it("still kills on the remote server on Dokploy Cloud", async () => {
		mocks.state.cloud = true;
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			expect.stringContaining("docker exec cont-1 sh -c"),
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("marks the run as cancelled without running anything when its container is gone", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue(null);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("claims the run as cancelled before the kill is sent", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(
			mocks.claimScheduleRunCancel.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.execAsyncRemote.mock.invocationCallOrder[0] as number);
	});

	it("restores the run and reports the error when the kill itself fails", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toThrow("ssh down");

		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("still reports the kill error when the run cannot be restored either", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		mocks.revertScheduleRunCancel.mockRejectedValue(new Error("db down"));
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toThrow("ssh down");

		consoleErrorSpy.mockRestore();
	});

	it("kills nothing when the run ended or was cancelled since it was read", async () => {
		mocks.findDeploymentById.mockResolvedValue(deployment());
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
		mocks.claimScheduleRunCancel.mockResolvedValue(null);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.revertScheduleRunCancel).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("still refuses a run that is not running", async () => {
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ status: "done", pid: null }),
		);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Deployment is not running",
		});

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		expect(mocks.claimScheduleRunCancel).not.toHaveBeenCalled();
	});

	it.each(["application", "compose"] as const)(
		"cancels a %s run whose pid is not recorded yet, by its tag",
		async (scheduleType) => {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({
					pid: null,
					schedule: {
						scheduleId: "sch-1",
						scheduleType,
						serverId: null,
					},
				}),
			);
			mocks.findScheduleById.mockResolvedValue(
				scheduleType === "application"
					? applicationSchedule("srv-1")
					: composeSchedule("srv-1"),
			);
			mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
			mocks.getComposeContainer.mockResolvedValue({ Id: "cont-1" });

			await caller.killProcess({ deploymentId: "dep_1-A" });

			expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
				"srv-1",
				expect.stringContaining("DOKPLOY_SCHEDULE_RUN="),
			);
			expect(mocks.execAsync).not.toHaveBeenCalled();
			expectCancelled();
		},
	);

	it("does not use, nor validate, the pid of a run that is stopped by its tag", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ pid: "1; reboot" }),
		);
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		for (const [, command] of mocks.execAsyncRemote.mock.calls) {
			expect(command).not.toContain("reboot");
		}
		expectCancelled();
	});

	it("keeps the pid validation for the runs that are killed by pid", async () => {
		for (const pid of ["1; reboot", "1", "0", "-9", "12 34"]) {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({
					pid,
					schedule: {
						scheduleId: "sch-1",
						scheduleType: "server",
						serverId: "srv-1",
					},
				}),
			);

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: "Deployment has an invalid process id",
			});
		}

		expect(mocks.claimScheduleRunCancel).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	describe("when the command has not been started yet, or is over", () => {
		const nothingFound = () =>
			mocks.execAsyncRemote.mockResolvedValue({
				stdout: `${SCHEDULE_NONE_MARKER}\n`,
				stderr: "",
			});

		beforeEach(() => {
			mocks.findDeploymentById.mockResolvedValue(deployment());
			mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
			mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
			nothingFound();
		});

		it("undoes the claim and asks to retry while the run is still going", async () => {
			mocks.revertScheduleRunCancel.mockResolvedValue(true);

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: "The run is still starting, try again in a moment",
			});

			expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
				"dep_1-A",
				"claim-1",
			);
			expect(mocks.audit).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		});

		it("succeeds when the run ended meanwhile, so its claim cannot be undone", async () => {
			mocks.revertScheduleRunCancel.mockResolvedValue(false);

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).resolves.toBeUndefined();

			expect(mocks.revertScheduleRunCancel).toHaveBeenCalledTimes(1);
			expect(mocks.audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ action: "cancel", resourceId: "dep_1-A" }),
			);
			expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		});

		it("does not undo anything when the kill found and stopped the run", async () => {
			mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

			await caller.killProcess({ deploymentId: "dep_1-A" });

			expectCancelled();
		});

		it("keeps a gone container as cancelled, with nothing to undo", async () => {
			mocks.getServiceContainer.mockResolvedValue(null);

			await caller.killProcess({ deploymentId: "dep_1-A" });

			expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
			expectCancelled();
		});

		it("does the same for a compose run on the Dokploy host", async () => {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({
					schedule: {
						scheduleId: "sch-1",
						scheduleType: "compose",
						serverId: null,
					},
				}),
			);
			mocks.findScheduleById.mockResolvedValue(composeSchedule(null));
			mocks.getComposeContainer.mockResolvedValue({ Id: "cont-2" });
			mocks.execAsync.mockResolvedValue({
				stdout: `${SCHEDULE_NONE_MARKER}\n`,
				stderr: "",
			});
			mocks.revertScheduleRunCancel.mockResolvedValue(true);

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).rejects.toMatchObject({
				message: "The run is still starting, try again in a moment",
			});
		});
	});

	it("refuses a deployment id that could reach a shell", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ deploymentId: "x'; reboot; '" }),
		);

		await expect(
			caller.killProcess({ deploymentId: "x" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("killProcess on a compose schedule run", () => {
	it("resolves the service container and kills in it on the compose's server, using the schedule's shell", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				schedule: {
					scheduleId: "sch-1",
					scheduleType: "compose",
					serverId: null,
				},
			}),
		);
		const schedule = composeSchedule("srv-2");
		mocks.findScheduleById.mockResolvedValue(schedule);
		mocks.getComposeContainer.mockResolvedValue({ Id: "cont-2" });

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.getComposeContainer).toHaveBeenCalledWith(
			schedule.compose,
			"web",
		);
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-2");
		expect(command).toMatch(/^docker exec cont-2 bash -c .* bash dep_1-A$/s);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expectCancelled();
	});
});

describe("killProcess on host-level schedule runs", () => {
	it.each(["server", "dokploy-server"])(
		"keeps the plain pid kill for a %s schedule",
		async (scheduleType) => {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({
					schedule: { scheduleId: "sch-1", scheduleType, serverId: "srv-1" },
				}),
			);

			await caller.killProcess({ deploymentId: "dep_1-A" });

			expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
				"srv-1",
				"kill -9 4242",
			);
			expect(mocks.findScheduleById).not.toHaveBeenCalled();
			expect(mocks.getServiceContainer).not.toHaveBeenCalled();
			expectCancelled();
		},
	);

	it("kills a dokploy-server run on the Dokploy host", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				schedule: {
					scheduleId: "sch-1",
					scheduleType: "dokploy-server",
					serverId: null,
				},
			}),
		);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsync).toHaveBeenCalledWith("kill -9 4242");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expectCancelled();
	});

	it.each(["server", "dokploy-server"])(
		"treats a %s run whose process already exited as cancelled, not as a failure",
		async (scheduleType) => {
			mocks.findDeploymentById.mockResolvedValue(
				deployment({
					schedule: { scheduleId: "sch-1", scheduleType, serverId: "srv-1" },
				}),
			);
			mocks.execAsyncRemote.mockRejectedValue(
				Object.assign(new Error("Remote command failed with exit code 1"), {
					stderr: "sh: 1: kill: No such process\n",
				}),
			);

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).resolves.toBeUndefined();

			expectCancelled();
		},
	);

	it("treats a vanished process on the Dokploy host the same way", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				schedule: {
					scheduleId: "sch-1",
					scheduleType: "dokploy-server",
					serverId: null,
				},
			}),
		);
		mocks.execAsync.mockRejectedValue(
			new Error(
				"Command execution failed: Command failed: kill -9 4242\n/bin/sh: kill: (4242) - No such process",
			),
		);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expectCancelled();
	});

	it("restores the run and reports any other failure of the pid kill", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				schedule: {
					scheduleId: "sch-1",
					scheduleType: "server",
					serverId: "srv-1",
				},
			}),
		);
		mocks.execAsyncRemote.mockRejectedValue(
			Object.assign(new Error("Remote command failed with exit code 1"), {
				stderr: "sh: 1: kill: Operation not permitted",
			}),
		);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toThrow("exit code 1");

		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("claims a host-level run before the kill is sent", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				schedule: {
					scheduleId: "sch-1",
					scheduleType: "server",
					serverId: "srv-1",
				},
			}),
		);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(
			mocks.claimScheduleRunCancel.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.execAsyncRemote.mock.invocationCallOrder[0] as number);
	});
});

describe("a server run that never printed its pid", () => {
	const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
	const LOG = "/etc/dokploy/schedules/s/s-run.log";
	const noPid = (
		scheduleType: string,
		serverId: string | null,
		extra: Record<string, unknown> = {},
	) =>
		deployment({
			pid: null,
			startedAt: ago(60_000),
			logPath: LOG,
			schedule: { scheduleId: "sch-1", scheduleType, serverId },
			...extra,
		});
	const found = () =>
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	const nothingFound = () => {
		const result = { stdout: `${SCHEDULE_NONE_MARKER}\n`, stderr: "" };
		mocks.execAsyncRemote.mockResolvedValue(result);
		mocks.execAsync.mockResolvedValue(result);
	};
	const launchedAgo = (ms: number) =>
		markScheduleRunLaunched("dep_1-A", Date.now() - ms);

	afterEach(() => {
		forgetScheduleRunLaunch("dep_1-A");
	});

	it("is stopped by its tag on its server, whatever its age, and cancelled", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { startedAt: ago(1_000) }),
		);
		found();

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [serverId, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(serverId).toBe("srv-1");
		expect(command).toMatch(/^sh -c /);
		// The kill script and the run id reach the shell as separate arguments.
		expect(dockerArgs(command.replace(/^sh /, "docker "))).toEqual([
			"-c",
			SCHEDULE_KILL_SCRIPT,
			"sh",
			"dep_1-A",
		]);
		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("is stopped by its tag on the Dokploy host for a dokploy-server run", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("dokploy-server", null, { serverId: null }),
		);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync.mock.calls[0]?.[0]).toContain("dep_1-A");
		expectCancelled();
	});

	it.each([
		["server", "srv-1"],
		["dokploy-server", null],
	])(
		"not launched yet (a slow ssh connect): a %s cancel stands for the launch point to stop, even long after the run started",
		async (scheduleType, serverId) => {
			mocks.findDeploymentById.mockResolvedValue(
				noPid(scheduleType, serverId, {
					serverId,
					startedAt: ago(5 * 60_000),
				}),
			);
			nothingFound();

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).resolves.toBeUndefined();

			expect(mocks.claimScheduleRunCancel).toHaveBeenCalledWith("dep_1-A");
			// The claim is kept, and the run is not ended behind its back: the
			// launch point sees the cancel and ends it.
			expect(mocks.revertScheduleRunCancel).not.toHaveBeenCalled();
			expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
			expect(mocks.audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ action: "cancel", resourceId: "dep_1-A" }),
			);
		},
	);

	it("launched moments ago: undoes the claim and asks to retry, the process may not exist yet", async () => {
		mocks.findDeploymentById.mockResolvedValue(noPid("server", "srv-1"));
		nothingFound();
		launchedAgo(3_000);
		mocks.revertScheduleRunCancel.mockResolvedValue(true);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "The run is still starting, try again in a moment",
		});

		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("at its last look at the cancel, however long that has taken: undoes the claim and asks to retry, never ends the run", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { startedAt: ago(5 * 60_000) }),
		);
		nothingFound();
		markScheduleRunChecking("dep_1-A");
		mocks.revertScheduleRunCancel.mockResolvedValue(true);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			message: "The run is still starting, try again in a moment",
		});

		// The claim is committed before the kill script and the record are read.
		expect(
			mocks.claimScheduleRunCancel.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.execAsyncRemote.mock.invocationCallOrder[0] as number);
		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
	});

	it("launched moments ago but already ended: the cancel succeeds", async () => {
		mocks.findDeploymentById.mockResolvedValue(noPid("server", "srv-1"));
		nothingFound();
		launchedAgo(3_000);
		mocks.revertScheduleRunCancel.mockResolvedValue(false);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).resolves.toBeUndefined();
		expect(mocks.audit).toHaveBeenCalled();
	});

	it.each([
		["server", "srv-1"],
		["dokploy-server", null],
	])(
		"launched long ago and nothing carries the tag: a %s run ends cancelled with a log line",
		async (scheduleType, serverId) => {
			mocks.findDeploymentById.mockResolvedValue(
				noPid(scheduleType, serverId, { serverId }),
			);
			nothingFound();
			launchedAgo(60_000);

			await expect(
				caller.killProcess({ deploymentId: "dep_1-A" }),
			).resolves.toBeUndefined();

			expect(mocks.endScheduleRunWithoutProcess).toHaveBeenCalledWith(
				"dep_1-A",
				serverId,
				LOG,
				undefined,
			);
			expect(mocks.revertScheduleRunCancel).not.toHaveBeenCalled();
			expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
			expect(mocks.audit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ action: "cancel", resourceId: "dep_1-A" }),
			);
		},
	);

	it("never launched by this process and older than the stranded bound: ends cancelled, saying it was left behind", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { startedAt: ago(11 * 60_000) }),
		);
		nothingFound();

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).resolves.toBeUndefined();

		expect(mocks.endScheduleRunWithoutProcess).toHaveBeenCalledWith(
			"dep_1-A",
			"srv-1",
			LOG,
			"stranded-line",
		);
		expect(mocks.revertScheduleRunCancel).not.toHaveBeenCalled();
	});

	it("a start time that cannot be read is never treated as stranded", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { startedAt: "not a date", createdAt: null }),
		);
		nothingFound();

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("restores the run and reports the failure when the tag kill fails", async () => {
		mocks.findDeploymentById.mockResolvedValue(noPid("server", "srv-1"));
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toThrow("ssh down");

		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("refuses a dokploy-server run in the cloud, which has no host to stop it on", async () => {
		mocks.state.cloud = true;
		mocks.findDeploymentById.mockResolvedValue(
			noPid("dokploy-server", null, { serverId: null }),
		);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Deployment has no server to stop it on",
		});

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.revertScheduleRunCancel).toHaveBeenCalled();
	});

	it("never hands an unsafe run id to a shell", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { deploymentId: "x'; reboot; '" }),
		);

		await expect(
			caller.killProcess({ deploymentId: "x" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("keeps the pid kill when the run did print its pid, however old", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { pid: "4242" }),
		);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith("srv-1", "kill -9 4242");
		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
		expectCancelled();
	});

	it("still validates a recorded pid", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			noPid("server", "srv-1", { pid: "1; reboot" }),
		);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			message: "Deployment has an invalid process id",
		});
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("a container run with nothing to stop keeps its old behaviour", () => {
	const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

	// Another replica may be the one the run used, so "nothing found" in the
	// container looked up now proves nothing, however old the run is.
	it.each([
		["a young run", 5_000],
		["an old run", 60 * 60_000],
	])("%s: undoes the claim and asks to retry", async (_label, age) => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({
				startedAt: ago(age),
				logPath: "/l.log",
				schedule: {
					scheduleId: "sch-1",
					scheduleType: "application",
					serverId: "srv-1",
				},
			}),
		);
		mocks.findScheduleById.mockResolvedValue(applicationSchedule("srv-1"));
		mocks.getServiceContainer.mockResolvedValue({ Id: "cont-1" });
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: `${SCHEDULE_NONE_MARKER}\n`,
			stderr: "",
		});
		mocks.revertScheduleRunCancel.mockResolvedValue(true);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			message: "The run is still starting, try again in a moment",
		});

		expect(mocks.revertScheduleRunCancel).toHaveBeenCalledWith(
			"dep_1-A",
			"claim-1",
		);
		expect(mocks.endScheduleRunWithoutProcess).not.toHaveBeenCalled();
	});
});

describe("killProcess on a deployment that is not a schedule run", () => {
	it("keeps the plain pid kill and the errored status", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ schedule: null, serverId: "srv-1" }),
		);

		await caller.killProcess({ deploymentId: "dep_1-A" });

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith("srv-1", "kill -9 4242");
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"dep_1-A",
			"error",
		);
		expect(mocks.claimScheduleRunCancel).not.toHaveBeenCalled();
		expect(mocks.revertScheduleRunCancel).not.toHaveBeenCalled();
	});

	it("still says it is not running for a plain deployment without a pid", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ schedule: null, serverId: "srv-1", pid: null }),
		);

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Deployment is not running",
		});

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("does not touch the status when its kill fails", async () => {
		mocks.findDeploymentById.mockResolvedValue(
			deployment({ schedule: null, serverId: "srv-1" }),
		);
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));

		await expect(
			caller.killProcess({ deploymentId: "dep_1-A" }),
		).rejects.toThrow("ssh down");

		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
	});
});
