import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How `deployCompose` / `rebuildCompose` treat the opt-in deploy guardrails:
 * a health check that times out ends the deployment as `error` (never `done`)
 * through the normal failure path (log line, notification), no rollback is
 * attempted, and the Dokploy-side phase timestamps are only ever written when
 * the setting is on.
 */

const mocks = vi.hoisted(() => ({
	prepareComposeBuildServerDeploy: vi.fn().mockResolvedValue(undefined),
	waitForComposeRequiredChecks: vi.fn().mockResolvedValue(undefined),
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn().mockResolvedValue("docker compose up -d;"),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateCompose: vi.fn(),
	sendBuildErrorNotifications: vi.fn(),
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/services/compose-build-server", () => ({
	prepareComposeBuildServerDeploy: mocks.prepareComposeBuildServerDeploy,
}));
vi.mock("@dokploy/server/services/compose-registry-retention", () => ({
	pruneComposeBuildRegistry: vi.fn(),
}));
vi.mock("@dokploy/server/services/build-policy/compose-checks", () => ({
	waitForComposeRequiredChecks: mocks.waitForComposeRequiredChecks,
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.sendBuildErrorNotifications,
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: mocks.sendBuildSuccessNotifications,
}));
vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
		// A raw compose is staged over SFTP on a remote host.
		writeFileRemote: vi.fn().mockResolvedValue(undefined),
	};
});
vi.mock("@dokploy/server/utils/builders/compose", () => ({
	getBuildComposeCommand: mocks.getBuildComposeCommand,
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "probe;"),
	getCreateEnvFileCommand: vi.fn(() => ""),
	getComposeBuildOverridePath: vi.fn(() => "/override.yml"),
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
}));
vi.mock("@dokploy/server/services/deployment", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment")
	>("@dokploy/server/services/deployment");
	return {
		...actual,
		createDeploymentCompose: mocks.createDeploymentCompose,
		updateDeploymentStatus: mocks.updateDeploymentStatus,
	};
});

// The closing `done` goes through the conditional update; record it with the
// other status writes so `statuses()` sees one list.
vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return {
		...actual,
		markDeploymentDoneUnlessCancelled: async (deploymentId: string) => {
			mocks.updateDeploymentStatus(deploymentId, "done");
			return true;
		},
	};
});

import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";
import { ExecError } from "@dokploy/server/utils/process/execAsync";

const HEALTH = {
	phaseTimestamps: true,
	healthCheck: { url: "http://localhost:3000/health", timeoutSeconds: 30 },
};

const composeRow = (deployGuardrails: unknown) => ({
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeFile: "services: {}",
	env: "",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	serverId: null as string | null,
	buildServerId: null,
	buildRegistryId: null,
	domains: [],
	deployGuardrails,
	environment: {
		name: "prod",
		project: { name: "P", organizationId: "org-1" },
	},
});

const deploy = () =>
	deployCompose({
		composeId: "compose-1",
		titleLog: "Manual deployment",
		descriptionLog: "",
	});

const rebuild = () =>
	rebuildCompose({
		composeId: "compose-1",
		titleLog: "Rebuild deployment",
		descriptionLog: "",
	});

const statuses = () => ({
	deployment: mocks.updateDeploymentStatus.mock.calls.map((call) => call[1]),
	compose: mocks.updateCompose.mock.calls
		.map((call) => (call[1] as { composeStatus?: string }).composeStatus)
		.filter(Boolean),
});

const executed = () => mocks.execAsync.mock.calls.map((call) => String(call[0]));

const useCompose = async (row: ReturnType<typeof composeRow>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(row as any);
};

/** The deploy script failed the way a health-check timeout fails it. */
const failTheDeployScript = () => {
	mocks.execAsync.mockImplementation(async (command: string) => {
		if (String(command).includes("docker compose up -d;")) {
			throw new ExecError("Command execution failed: exit 1", {
				command: String(command),
				stdout: "",
				stderr: "",
				exitCode: 1,
			});
		}
		return { stdout: "", stderr: "" };
	});
};

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.update).mockImplementation((() => {
		const chain: any = {
			set: (values: unknown) => {
				mocks.updateCompose("compose", values);
				return chain;
			},
			where: () => chain,
			returning: () => Promise.resolve([{}]),
		};
		return chain;
	}) as any);
});

describe("a health check that times out", () => {
	it.each([
		["deployCompose", deploy],
		["rebuildCompose", rebuild],
	])("%s ends the deployment as error, never done, and notifies", async (name, run) => {
		await useCompose(composeRow(HEALTH));
		failTheDeployScript();

		await expect(run()).rejects.toThrow("Command execution failed");

		expect(statuses().deployment).toContain("error");
		expect(statuses().deployment).not.toContain("done");
		// No rollback marker in the log: the service is flagged, not "restored".
		expect(statuses().compose).toContain("error");
		expect(statuses().compose).not.toContain("done");
		if (name === "deployCompose") {
			// The failure notification path of a normal deploy failure.
			expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
			expect(mocks.sendBuildSuccessNotifications).not.toHaveBeenCalled();
		}
		// The usual failure line, plus the phase line when timestamps are on.
		const commands = executed();
		expect(commands.some((command) => command.includes("Error occurred"))).toBe(
			true,
		);
		expect(
			commands.some((command) => command.includes("Deployment failed (total")),
		).toBe(true);
	});

	it("does not run a rollback of its own", async () => {
		await useCompose(composeRow(HEALTH));
		failTheDeployScript();

		await deploy().catch(() => {});

		expect(
			executed().filter((command) =>
				command.includes("Restoring previous working deployment"),
			),
		).toHaveLength(0);
	});
});

describe("phase timestamps are written by Dokploy only when enabled", () => {
	it("stamps the fetch and the finish of a successful deploy", async () => {
		await useCompose(composeRow({ phaseTimestamps: true }));

		await deploy();

		const commands = executed();
		for (const message of [
			"Write compose file: started",
			"Write compose file: finished after",
			"Deployment finished (total",
		]) {
			expect(
				commands.some(
					(command) =>
						command.includes(message) &&
						command.includes("$(date -u +%Y-%m-%dT%H:%M:%SZ)") &&
						command.includes(">> /var/log/dep-1.log"),
				),
				message,
			).toBe(true);
		}
		expect(statuses().deployment).toContain("done");
	});

	it("a failing log write never fails the deployment", async () => {
		await useCompose(composeRow({ phaseTimestamps: true }));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		mocks.execAsync.mockImplementation(async (command: string) => {
			if (String(command).includes("$(date -u")) throw new Error("disk full");
			return { stdout: "", stderr: "" };
		});

		await deploy();

		expect(statuses().deployment).toContain("done");
		consoleError.mockRestore();
	});

	it.each([
		["no setting", null],
		["an empty object", {}],
		["only the other flags", { dockerEvents: true }],
	])("writes nothing extra with %s", async (_name, value) => {
		await useCompose(composeRow(value));

		await deploy();

		expect(
			executed().filter((command) => command.includes("$(date -u")),
		).toHaveLength(0);
		expect(statuses().deployment).toContain("done");
	});

	it("uses the remote server for the log of a remote deployment", async () => {
		await useCompose({
			...composeRow({ phaseTimestamps: true }),
			serverId: "server-1",
		});

		await deploy();

		expect(
			mocks.execAsyncRemote.mock.calls.some(
				(call) =>
					call[0] === "server-1" &&
					String(call[1]).includes("Deployment finished"),
			),
		).toBe(true);
		expect(
			mocks.execAsync.mock.calls.some((call) =>
				String(call[0]).includes("Deployment finished"),
			),
		).toBe(false);
	});
});
