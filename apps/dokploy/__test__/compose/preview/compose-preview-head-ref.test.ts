import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pdFindFirst: vi.fn(),
	findComposeById: vi.fn(),
	runComposeBuild: vi.fn(),
	createDeploymentPreview: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	removeDeploymentsByPreviewDeploymentId: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: vi.fn(() => ({
			values: (values: unknown) => ({
				returning: async () => [values],
			}),
		})),
		update: vi.fn(() => ({
			set: () => ({ where: () => ({ returning: async () => [{}] }) }),
		})),
		delete: vi.fn(() => ({ where: () => ({ returning: async () => [{}] }) })),
		query: {
			previewDeployments: {
				findFirst: mocks.pdFindFirst,
				findMany: vi.fn(async () => []),
			},
			organization: {
				findFirst: vi.fn(async () => null),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
	runComposeBuild: mocks.runComposeBuild,
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/deployment")
	>()),
	createDeploymentPreview: mocks.createDeploymentPreview,
	removeDeploymentsByPreviewDeploymentId:
		mocks.removeDeploymentsByPreviewDeploymentId,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import { deployComposePreview } from "@dokploy/server/services/preview-deployment";

const composeFixture = {
	composeId: "compose-1",
	name: "My Compose",
	appName: "myapp",
	sourceType: "github",
	// No comment context (githubId null) so no comment HTTP call is made; the
	// head-ref derivation only needs sourceType + pullRequestNumber.
	githubId: null,
	owner: null,
	repository: null,
	branch: "main",
	serverId: null,
	composeType: "docker-compose",
	suffix: "",
	randomize: false,
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	previewHttps: false,
	previewEnv: "",
	domains: [],
} as never;

const previewRow = {
	previewDeploymentId: "pd-1",
	composeId: "compose-1",
	appName: "preview-myapp-abc123",
	branch: "feature-branch",
	pullRequestId: "pr-id-1",
	pullRequestNumber: "42",
	pullRequestCommentId: "",
	domain: null,
	domains: [],
	application: null,
	compose: { composeId: "compose-1", serverId: null },
} as never;

describe("deployComposePreview head-ref checkout", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findComposeById.mockResolvedValue(composeFixture);
		mocks.pdFindFirst.mockResolvedValue(previewRow);
		mocks.createDeploymentPreview.mockResolvedValue({
			deploymentId: "deployment-id",
			logPath: "/tmp/preview.log",
		});
	});

	it("passes the pull-request head ref to the build, not just the branch", async () => {
		await deployComposePreview({
			composeId: "compose-1",
			previewDeploymentId: "pd-1",
			titleLog: "Preview Deployment",
			descriptionLog: "",
		});

		expect(mocks.runComposeBuild).toHaveBeenCalledTimes(1);
		const [entity, deployment] = mocks.runComposeBuild.mock.calls[0] as [
			Record<string, unknown>,
			{ deploymentId: string },
		];

		// All three branch overrides stay (display/fallback), and the head ref
		// makes the checkout pull-request-exact even when the branch only
		// exists in a fork.
		expect(entity).toMatchObject({
			branch: "feature-branch",
			gitlabBranch: "feature-branch",
			giteaBranch: "feature-branch",
			headRef: "refs/pull/42/head",
			appName: "preview-myapp-abc123",
		});
		// Previews never re-apply patches.
		expect(mocks.runComposeBuild).toHaveBeenCalledWith(
			expect.objectContaining({ headRef: "refs/pull/42/head" }),
			deployment,
			{ applyPatches: false },
		);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"done",
		);
	});
});
