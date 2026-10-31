import { beforeEach, describe, expect, it, vi } from "vitest";

// A deploy that fails because a ${{vault.*}} reference cannot be resolved
// ends as `error` with the reason in the deploy log. The deployment row has to
// carry the same reason in `errorMessage` (T-11775), or the dashboard shows a
// failed deployment with no explanation. The reference is resolved for real
// (the HashiCorp client over a mocked fetch), so the message is the one the
// provider produces.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	getBuildComposeCommand: vi.fn(),
	getBackupCurrentDeploymentCommand: vi.fn(() => "true;"),
	getRollbackMarkerProbeCommand: vi.fn(() => "true;"),
	generateApplyPatchesCommand: vi.fn().mockResolvedValue(""),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	markDeploymentDoneUnlessCancelled: vi.fn(),
	prepareComposeBuildServerDeploy: vi.fn(),
	sets: [] as Record<string, unknown>[],
}));

vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
	};
});

vi.mock("@dokploy/server/utils/builders/compose", () => ({
	getBuildComposeCommand: mocks.getBuildComposeCommand,
	getBackupCurrentDeploymentCommand: mocks.getBackupCurrentDeploymentCommand,
	getRollbackMarkerProbeCommand: mocks.getRollbackMarkerProbeCommand,
	getCreateEnvFileCommand: vi.fn(() => ""),
}));

vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
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

vi.mock("@dokploy/server/services/compose-build-server", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/compose-build-server")
	>("@dokploy/server/services/compose-build-server");
	return {
		...actual,
		prepareComposeBuildServerDeploy: mocks.prepareComposeBuildServerDeploy,
	};
});

vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return {
		...actual,
		markDeploymentDoneUnlessCancelled: mocks.markDeploymentDoneUnlessCancelled,
	};
});

import { db } from "@dokploy/server/db";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";
import { resolveVaultReferences } from "@dokploy/server/utils/vault";

const MISSING_FIELD =
	'HashiCorp Vault: field "NOPE" not found in secret "dokploy-test/app"';

const raw = {
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeType: "docker-compose",
	composeFile: "services: {}",
	composePath: "./docker-compose.yml",
	env: "APP_FOO=${{vault.prov.dokploy-test/app:NOPE}}",
	serverId: null,
	buildServerId: null,
	environmentId: "env-1",
	environment: {
		environmentId: "env-1",
		projectId: "proj-1",
		name: "production",
		project: { projectId: "proj-1", name: "P", organizationId: "org-1" },
	},
	domains: [],
};

const errorMessagesWritten = () =>
	mocks.sets.flatMap((set) =>
		"errorMessage" in set ? [set.errorMessage] : [],
	);

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
			assignments: [{ projectId: "proj-1", environmentIds: [] }],
		},
	] as never);
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({ data: { data: secretFields } }),
	})) as unknown as typeof fetch;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sets.length = 0;
	const chain: Record<string, unknown> = {};
	chain.set = (values: Record<string, unknown>) => {
		mocks.sets.push(values);
		return chain;
	};
	chain.where = () => chain;
	chain.returning = () => Promise.resolve([{}]);
	chain.then = (resolve: (value: unknown) => void) => resolve([]);
	vi.mocked(db.update).mockImplementation((() => chain) as never);
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(raw as never);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.generateApplyPatchesCommand.mockResolvedValue("");
	mocks.markDeploymentDoneUnlessCancelled.mockResolvedValue(true);
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
	// The build steps resolve the env's vault references, as the real ones do.
	const resolveEnv = () =>
		resolveVaultReferences(raw.env, {
			organizationId: "org-1",
			projectId: "proj-1",
			environmentId: "env-1",
		});
	mocks.getBuildComposeCommand.mockImplementation(async () => {
		await resolveEnv();
		return "docker compose up -d;";
	});
	mocks.prepareComposeBuildServerDeploy.mockImplementation(
		async ({ entity }: { entity: { buildServerId: string | null } }) => {
			if (entity.buildServerId) await resolveEnv();
			return undefined;
		},
	);
});

describe.each([
	["deployCompose", deployCompose],
	["rebuildCompose", rebuildCompose],
])("%s with an unresolvable vault reference", (_name, run) => {
	const deploy = () =>
		run({ composeId: "compose-1", titleLog: "Deploy", descriptionLog: "" });

	it("records the reason the log shows on the deployment", async () => {
		useVault({ OTHER: "value" });

		await expect(deploy()).rejects.toThrow(MISSING_FIELD);

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(errorMessagesWritten()).toEqual([MISSING_FIELD]);
		// The log got the same text.
		const logged = [
			...mocks.execAsync.mock.calls,
			...mocks.execAsyncRemote.mock.calls,
		]
			.map((call) => String(call[call.length - 1]))
			.flatMap((command) => {
				const encoded = /echo "([^"]+)" \| base64 -d/.exec(command);
				return encoded
					? [Buffer.from(encoded[1] as string, "base64").toString()]
					: [];
			});
		expect(logged).toContain(MISSING_FIELD);
	});

	it("records it for a compose built on a build server too (it resolves them first)", async () => {
		useVault({ OTHER: "value" });
		vi.mocked(db.query.compose.findFirst).mockResolvedValue({
			...raw,
			serverId: "server-1",
			buildServerId: "build-1",
		} as never);

		await expect(deploy()).rejects.toThrow(MISSING_FIELD);

		expect(errorMessagesWritten()).toEqual([MISSING_FIELD]);
	});

	it("leaves the message alone when the failure is not a vault reference", async () => {
		useVault({ NOPE: "value" });
		mocks.getBuildComposeCommand.mockRejectedValue(new Error("boom"));

		await expect(deploy()).rejects.toThrow("boom");

		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith("dep-1", "error");
		expect(errorMessagesWritten()).toEqual([]);
	});
});
