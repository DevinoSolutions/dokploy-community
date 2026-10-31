import { resolveVaultReferences } from "@dokploy/server/utils/vault";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `deployPinnedApplicationImage` (deploy-hook image jobs and the build-policy
// rollback) creates its own deployment row and resolves the application's
// ${{vault.*}} references inside `mechanizeDockerContainer`. When a reference
// cannot be resolved the deploy ends as `error`, and the row has to carry the
// reason in `errorMessage` (T-11775) like every other deploy path. The
// reference is resolved for real (the HashiCorp client over a mocked fetch).
const sets = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn((values: Record<string, unknown>) => {
				sets.push(values);
				return chain;
			}),
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
				vaultProvider: {
					findMany: vi.fn(),
				},
			},
		},
	};
});

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(),
	updateApplicationStatus: vi.fn(),
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/services/registry", () => ({
	findAllRegistryByOrganizationId: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	findRegistryById: vi.fn(),
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: vi.fn(),
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/utils/builders", () => ({
	mechanizeDockerContainer: vi.fn(),
}));

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

import { db } from "@dokploy/server/db";
import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import { deployPinnedApplicationImage } from "@dokploy/server/services/build-policy/pinned-deploy";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as registryService from "@dokploy/server/services/registry";
import * as builders from "@dokploy/server/utils/builders";
import * as dockerUtils from "@dokploy/server/utils/docker/utils";
import * as errorNotifications from "@dokploy/server/utils/notifications/build-error";
import * as execProcess from "@dokploy/server/utils/process/execAsync";

const MISSING_FIELD =
	'HashiCorp Vault: field "NOPE" not found in secret "dokploy-test/app"';
const ENV = "APP_FOO=${{vault.prov.dokploy-test/app:NOPE}}";
const DIGEST = `sha256:${"a".repeat(64)}`;

const APPLICATION = {
	applicationId: "app-1",
	name: "Test App",
	appName: "test-app",
	env: ENV,
	serverId: null,
	environmentId: "env-id",
	domains: [],
	buildRegistry: null,
	environment: {
		environmentId: "env-id",
		projectId: "project-id",
		env: "",
		name: "production",
		project: {
			projectId: "project-id",
			name: "Test Project",
			organizationId: "org-id",
			env: "",
		},
	},
};

const errorMessagesWritten = () =>
	sets.flatMap((set) => ("errorMessage" in set ? [set.errorMessage] : []));

const useVault = (secretFields: Record<string, string>) => {
	vi.mocked(db.query.vaultProvider.findMany).mockResolvedValue([
		{
			name: "prov",
			providerType: "hashicorp",
			config: {
				providerType: "hashicorp",
				url: "https://vault.example.com",
				token: "hvs.token",
				mount: "secret",
			},
			assignments: [{ projectId: "project-id", environmentIds: [] }],
		},
	] as never);
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({ data: { data: secretFields } }),
	})) as unknown as typeof fetch;
};

const run = () =>
	deployPinnedApplicationImage({
		applicationId: "app-1",
		pinnedImage: {
			ref: "ghcr.io/devinosolutions/app",
			tag: "abc123",
			digest: DIGEST,
		},
		skipRequiredChecks: true,
	});

describe("deployPinnedApplicationImage with an unresolvable vault reference", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sets.length = 0;
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			APPLICATION as never,
		);
		vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
			{} as never,
		);
		vi.mocked(adminService.getDokployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		vi.mocked(deploymentService.createDeployment).mockResolvedValue({
			deploymentId: "deployment-id",
			logPath: "/tmp/test-deployment.log",
		} as never);
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue(
			{} as never,
		);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as never,
		);
		vi.mocked(
			registryService.findAllRegistryByOrganizationId,
		).mockResolvedValue([] as never);
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as never);
		vi.mocked(errorNotifications.sendBuildErrorNotifications).mockResolvedValue(
			undefined as never,
		);
		vi.mocked(dockerUtils.waitForSwarmServiceStable).mockResolvedValue({
			stable: true,
		} as never);
		// The service update resolves the env's vault references, as the real one
		// does.
		vi.mocked(builders.mechanizeDockerContainer).mockImplementation(
			async () => {
				await resolveVaultReferences(ENV, {
					organizationId: "org-id",
					projectId: "project-id",
					environmentId: "env-id",
				});
			},
		);
	});

	it("records the reason the log shows on the deployment", async () => {
		useVault({ OTHER: "value" });

		await expect(run()).rejects.toThrow(MISSING_FIELD);

		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
		expect(errorMessagesWritten()).toEqual([MISSING_FIELD]);
	});

	it("leaves the message alone when the failure is not a vault reference", async () => {
		useVault({ NOPE: "value" });
		vi.mocked(builders.mechanizeDockerContainer).mockRejectedValue(
			new Error("boom"),
		);

		await expect(run()).rejects.toThrow("boom");

		expect(deploymentService.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
		expect(errorMessagesWritten()).toEqual([]);
	});
});
