import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How `deployCompose` / `rebuildCompose` use the read-only restricted-compose
 * audit (T-7455): the audit is called once per deploy, and a deploy runs the
 * very same commands, ends in the very same state, whether the audit is off,
 * on, or broken. It is never the reason a deploy fails.
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
	appendLogLine: vi.fn().mockResolvedValue(undefined),
	evaluateComposePolicy: vi.fn(),
	actualEvaluate: undefined as unknown as (...args: unknown[]) => unknown,
	warn: vi.fn(),
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
		appendLogLine: mocks.appendLogLine,
		markDeploymentDoneUnlessCancelled: async (deploymentId: string) => {
			mocks.updateDeploymentStatus(deploymentId, "done");
			return true;
		},
	};
});
vi.mock("@dokploy/server/utils/compose-policy/evaluate", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/compose-policy/evaluate")
	>("@dokploy/server/utils/compose-policy/evaluate");
	mocks.actualEvaluate = actual.evaluateComposePolicy as never;
	mocks.evaluateComposePolicy.mockImplementation(actual.evaluateComposePolicy);
	return { ...actual, evaluateComposePolicy: mocks.evaluateComposePolicy };
});
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));

import { db } from "@dokploy/server/db";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";

const RAW = "services:\n  web:\n    image: nginx\n    privileged: true\n";

// The mocked database answers every table with the same row, so the one row
// is both the compose and the organization that owns it.
const composeRow = (auditOn: boolean) => ({
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeFile: RAW,
	env: "",
	composeType: "docker-compose",
	composePath: "./docker-compose.yml",
	serverId: null as string | null,
	buildServerId: null,
	buildRegistryId: null,
	domains: [],
	command: "",
	deployGuardrails: null,
	restrictedComposeAudit: auditOn,
	restrictedComposeAuditExclusions: [],
	environment: {
		name: "prod",
		project: { name: "P", organizationId: "org-1" },
	},
});

// The audit runs in the background (the deploy awaits nothing from it): give
// it a few turns of the event loop to finish before looking at its effects.
const settle = async () => {
	for (let i = 0; i < 20; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
};

const useCompose = (row: ReturnType<typeof composeRow>) =>
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(row as never);

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

const executed = () =>
	mocks.execAsync.mock.calls.map((call) => String(call[0]));
const deploymentStatuses = () =>
	mocks.updateDeploymentStatus.mock.calls.map((call) => call[1]);
const composeStatuses = () =>
	mocks.updateCompose.mock.calls
		.map((call) => (call[1] as { composeStatus?: string }).composeStatus)
		.filter(Boolean);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.evaluateComposePolicy.mockImplementation(mocks.actualEvaluate);
	mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
	mocks.appendLogLine.mockResolvedValue(undefined);
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
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
	vi.mocked(db.insert).mockImplementation((() => ({
		values: () => Promise.resolve(undefined),
	})) as never);
});

describe.each([
	["deployCompose", deploy],
	["rebuildCompose", rebuild],
])("%s", (_name, run) => {
	it("with the audit off: no evaluation, no log line, no row, the usual deploy", async () => {
		useCompose(composeRow(false));

		await run();
		await settle();

		expect(mocks.evaluateComposePolicy).not.toHaveBeenCalled();
		expect(mocks.appendLogLine).not.toHaveBeenCalled();
		expect(db.insert).not.toHaveBeenCalled();
		expect(deploymentStatuses()).toContain("done");
	});

	it("with the audit on: one evaluation, its lines in this deployment's log", async () => {
		useCompose(composeRow(true));

		await run();
		await settle();

		expect(mocks.evaluateComposePolicy).toHaveBeenCalledTimes(1);
		expect(mocks.appendLogLine).toHaveBeenCalledTimes(1);
		const [serverId, logPath, text] = mocks.appendLogLine.mock.calls[0] as [
			string | null,
			string,
			string,
		];
		expect(serverId).toBeNull();
		expect(logPath).toBe("/var/log/dep-1.log");
		expect(text).toContain(
			"[restricted-compose audit] would refuse: service=web rule=host-privilege",
		);
		expect(db.insert).toHaveBeenCalledTimes(1);
		expect(deploymentStatuses()).toContain("done");
	});

	it("runs the same commands and ends in the same state as with the audit off", async () => {
		useCompose(composeRow(false));
		await run();
		await settle();
		const baseline = {
			commands: executed(),
			deployment: deploymentStatuses(),
			compose: composeStatuses(),
		};

		vi.clearAllMocks();
		mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
		mocks.createDeploymentCompose.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: "/var/log/dep-1.log",
		});
		useCompose(composeRow(true));
		await run();
		await settle();

		expect(executed()).toEqual(baseline.commands);
		expect(deploymentStatuses()).toEqual(baseline.deployment);
		expect(composeStatuses()).toEqual(baseline.compose);
	});

	it("an evaluator that throws changes nothing about the deploy", async () => {
		useCompose(composeRow(false));
		await run();
		await settle();
		const baseline = {
			commands: executed(),
			deployment: deploymentStatuses(),
			compose: composeStatuses(),
		};

		vi.clearAllMocks();
		mocks.execAsync.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
		mocks.createDeploymentCompose.mockResolvedValue({
			deploymentId: "dep-1",
			logPath: "/var/log/dep-1.log",
		});
		mocks.evaluateComposePolicy.mockImplementation(() => {
			throw new Error("the evaluator broke");
		});
		useCompose(composeRow(true));

		await expect(run()).resolves.not.toThrow();
		await settle();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(db.insert).not.toHaveBeenCalled();
		expect(executed()).toEqual(baseline.commands);
		expect(deploymentStatuses()).toEqual(baseline.deployment);
		expect(composeStatuses()).toEqual(baseline.compose);
		expect(deploymentStatuses()).not.toContain("error");
	});

	it("a database that cannot be written never fails the deploy", async () => {
		useCompose(composeRow(true));
		vi.mocked(db.insert).mockImplementation((() => ({
			values: () => Promise.reject(new Error("relation does not exist")),
		})) as never);

		await run();
		await settle();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(deploymentStatuses()).toContain("done");
		expect(deploymentStatuses()).not.toContain("error");
	});

	it("looks at a remote compose from the log of its own server", async () => {
		useCompose({ ...composeRow(true), serverId: "server-1" });

		await run();
		await settle();

		expect(mocks.appendLogLine.mock.calls[0]?.[0]).toBe("server-1");
	});
});
