import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The deploy awaits NOTHING from the restricted-compose audit (T-7455): a
 * hanging audit, one that throws synchronously and one that rejects do not
 * delay or change `deployCompose` / `rebuildCompose`, which pass through the
 * volume guard (`assertComposeVolumesBoundForDeploy`) that calls the hook.
 */

const mocks = vi.hoisted(() => ({
	runComposePolicyAudit: vi.fn(),
	prepareComposeBuildServerDeploy: vi.fn().mockResolvedValue(undefined),
	waitForComposeRequiredChecks: vi.fn().mockResolvedValue(undefined),
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn().mockResolvedValue("docker compose up -d;"),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateCompose: vi.fn(),
}));

vi.mock("@dokploy/server/services/compose-policy-audit", () => ({
	runComposePolicyAudit: mocks.runComposePolicyAudit,
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
	sendBuildErrorNotifications: vi.fn(),
}));
vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
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

import { db } from "@dokploy/server/db";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";

const composeRow = {
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
	command: "",
	deployGuardrails: null,
	environment: {
		name: "prod",
		project: { name: "P", organizationId: "org-1" },
	},
};

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

const deploymentStatuses = () =>
	mocks.updateDeploymentStatus.mock.calls.map((call) => call[1]);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(composeRow as never);
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

describe.each([
	["deployCompose", deploy],
	["rebuildCompose", rebuild],
])("%s", (_name, run) => {
	it("does not wait for an audit that never finishes", async () => {
		mocks.runComposePolicyAudit.mockReturnValue(new Promise(() => {}));
		const started = performance.now();

		await run();

		expect(performance.now() - started).toBeLessThan(2_000);
		expect(mocks.runComposePolicyAudit).toHaveBeenCalledTimes(1);
		expect(deploymentStatuses()).toContain("done");
		expect(deploymentStatuses()).not.toContain("error");
	});

	it("is not stopped by an audit that throws on the spot", async () => {
		mocks.runComposePolicyAudit.mockImplementation(() => {
			throw new Error("the audit broke");
		});

		await run();

		expect(mocks.runComposePolicyAudit).toHaveBeenCalledTimes(1);
		expect(deploymentStatuses()).toContain("done");
		expect(deploymentStatuses()).not.toContain("error");
	});

	it("is not stopped by an audit that rejects later (and the rejection is not left unhandled)", async () => {
		mocks.runComposePolicyAudit.mockImplementation(() =>
			Promise.reject(new Error("the audit failed")),
		);

		await run();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(deploymentStatuses()).toContain("done");
		expect(deploymentStatuses()).not.toContain("error");
	});

	it("hands the audit the compose and the deployment it belongs to", async () => {
		mocks.runComposePolicyAudit.mockResolvedValue(undefined);

		await run();

		expect(mocks.runComposePolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ composeId: "compose-1" }),
			expect.objectContaining({
				deploymentId: "dep-1",
				logPath: "/var/log/dep-1.log",
			}),
		);
	});
});
