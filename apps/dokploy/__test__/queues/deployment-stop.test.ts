import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type StopDeps,
	stopDeploymentWork,
} from "../../server/queues/deployment-stop";

/**
 * Stopping the work of one deployment, on the host it runs on: the existing
 * cancel machinery (the launcher by pid file, `kill -9 <pid>`, the generic
 * `pkill`) in the order "Kill process" and "Kill build" use, and never a kill
 * that could hit another service's build.
 */

const deps = {
	cancelWithLauncher: vi.fn(),
	countOtherRunning: vi.fn(),
	killPid: vi.fn(),
	resolveKind: vi.fn(),
	killDockerBuild: vi.fn(),
} satisfies StopDeps;

const target = (overrides = {}) => ({
	deploymentId: "dep-1",
	pid: null as string | null,
	serverId: null as string | null,
	buildServerId: null as string | null,
	composeId: null as string | null,
	applicationId: "app-1" as string | null,
	previewDeploymentId: null as string | null,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	deps.cancelWithLauncher.mockResolvedValue(null);
	deps.countOtherRunning.mockResolvedValue(0);
	deps.killPid.mockResolvedValue(undefined);
	deps.resolveKind.mockResolvedValue("application");
	deps.killDockerBuild.mockResolvedValue(undefined);
});

describe("a build under a pid file (build server, rolling replace)", () => {
	it("is stopped by the launcher and nothing else is killed", async () => {
		deps.cancelWithLauncher.mockResolvedValue({
			status: "cancelled",
			result: "KILLED",
		});

		const result = await stopDeploymentWork(
			target({ serverId: "srv-1", pid: "4242" }),
			deps,
		);

		expect(deps.cancelWithLauncher).toHaveBeenCalledWith("dep-1");
		expect(result).toMatchObject({
			method: "launcher",
			claimedCancelled: true,
			notRunning: false,
		});
		expect(deps.killPid).not.toHaveBeenCalled();
		expect(deps.killDockerBuild).not.toHaveBeenCalled();
	});

	it("carries the launcher's warning", async () => {
		deps.cancelWithLauncher.mockResolvedValue({
			status: "cancelled",
			result: "UNREACHABLE",
			warning: "Could not reach the build server",
		});

		const result = await stopDeploymentWork(target(), deps);

		expect(result.warning).toBe("Could not reach the build server");
	});

	it("falls back to the pid when the release step was cancelled but not signalled", async () => {
		deps.cancelWithLauncher.mockResolvedValue({
			status: "cancelled",
			result: "NONE",
			genericStopNeeded: true,
		});

		const result = await stopDeploymentWork(
			target({ serverId: "srv-2", pid: "777" }),
			deps,
		);

		expect(deps.killPid).toHaveBeenCalledWith("srv-2", "777");
		expect(result).toMatchObject({ method: "pid", claimedCancelled: true });
	});

	it("reports a deployment that is no longer running", async () => {
		deps.cancelWithLauncher.mockResolvedValue({ status: "not-running" });

		const result = await stopDeploymentWork(target({ pid: "99" }), deps);

		expect(result.notRunning).toBe(true);
		expect(deps.killPid).not.toHaveBeenCalled();
		expect(deps.killDockerBuild).not.toHaveBeenCalled();
	});
});

describe("a process id", () => {
	it("is killed on the deployment's own server", async () => {
		const result = await stopDeploymentWork(
			target({ serverId: "srv-9", pid: "31337" }),
			deps,
		);

		expect(deps.killPid).toHaveBeenCalledWith("srv-9", "31337");
		expect(result.method).toBe("pid");
	});

	it("is killed on the Dokploy host when the deployment has no server", async () => {
		await stopDeploymentWork(target({ serverId: null, pid: "55" }), deps);

		expect(deps.killPid).toHaveBeenCalledWith(null, "55");
	});

	it.each(["0", "1", "-5", "12; rm -rf /", "$(id)", " 42", "4 2"])(
		"%j is never put in a shell command",
		async (pid) => {
			await stopDeploymentWork(target({ pid }), deps);

			expect(deps.killPid).not.toHaveBeenCalled();
		},
	);

	it("a kill that fails is reported, not thrown", async () => {
		deps.killPid.mockRejectedValue(new Error("no such process"));

		const result = await stopDeploymentWork(target({ pid: "88" }), deps);

		expect(result.method).toBe("none");
		expect(result.warning).toContain("Could not signal process 88");
	});
});

describe("a build with no handle", () => {
	it("gets the generic stop on its own host when it is the only deploy there", async () => {
		const result = await stopDeploymentWork(
			target({ serverId: "srv-3" }),
			deps,
		);

		expect(deps.killDockerBuild).toHaveBeenCalledWith("application", "srv-3");
		expect(result.method).toBe("generic");
	});

	it("is a compose stop for a compose", async () => {
		await stopDeploymentWork(
			target({ applicationId: null, composeId: "comp-1" }),
			deps,
		);

		expect(deps.killDockerBuild).toHaveBeenCalledWith("compose", null);
	});

	it("is NOT signalled when other deploys run on the host: pkill would hit them", async () => {
		deps.countOtherRunning.mockResolvedValue(2);

		const result = await stopDeploymentWork(
			target({ serverId: "srv-3" }),
			deps,
		);

		expect(deps.killDockerBuild).not.toHaveBeenCalled();
		expect(result.method).toBe("none");
		expect(result.warning).toContain("2 other deploys run on the same host");
	});
});

describe("a preview deployment", () => {
	const preview = (overrides = {}) =>
		target({
			applicationId: null,
			previewDeploymentId: "prev-1",
			serverId: "srv-app",
			...overrides,
		});

	it("built on a build server is not signalled: its row names the serving host, not the builder", async () => {
		const result = await stopDeploymentWork(
			preview({ buildServerId: "srv-build" }),
			deps,
		);

		expect(result.method).toBe("none");
		expect(result.warning).toContain("build server");
		expect(deps.cancelWithLauncher).not.toHaveBeenCalled();
		expect(deps.killPid).not.toHaveBeenCalled();
		expect(deps.killDockerBuild).not.toHaveBeenCalled();
	});

	it("of a compose gets the compose stop, not the application one", async () => {
		deps.resolveKind.mockResolvedValue("compose");

		await stopDeploymentWork(preview(), deps);

		expect(deps.killDockerBuild).toHaveBeenCalledWith("compose", "srv-app");
	});

	it("of an application gets the application stop on its own server", async () => {
		deps.resolveKind.mockResolvedValue("application");

		await stopDeploymentWork(preview(), deps);

		expect(deps.killDockerBuild).toHaveBeenCalledWith("application", "srv-app");
	});

	it("with a pid is stopped by the pid on its server", async () => {
		await stopDeploymentWork(preview({ pid: "4321" }), deps);

		expect(deps.killPid).toHaveBeenCalledWith("srv-app", "4321");
	});
});
