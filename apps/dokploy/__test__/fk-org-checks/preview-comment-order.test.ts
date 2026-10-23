import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A PR preview of a service that still holds a git provider of another
// organization must be refused before the first PR comment: posting "running"
// (or "error") would use that foreign token (T-6902). The check itself is
// covered in deploy-references.test.ts; here it is refused on purpose.
const mocks = vi.hoisted(() => ({
	pdFindFirst: vi.fn(),
	findComposeById: vi.fn(),
	runComposeBuild: vi.fn(),
	createDeploymentPreview: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	ensurePreviewComment: vi.fn(),
	updatePreviewComment: vi.fn(),
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

vi.mock("@dokploy/server/services/snapvisor", () => ({
	finalizePreviewBuildMetadata: vi.fn(),
}));

vi.mock("@dokploy/server/services/preview-comment", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/preview-comment")
	>()),
	ensurePreviewComment: mocks.ensurePreviewComment,
	updatePreviewComment: mocks.updatePreviewComment,
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/deployment")
	>()),
	createDeploymentPreview: mocks.createDeploymentPreview,
	removeDeploymentsByPreviewDeploymentId: vi.fn(),
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
import { assertDeployReferencesInOrganization } from "@dokploy/server/services/service-reference-scope";

const REFUSAL =
	"Deployment refused: the GitHub provider set on this service does not belong to its organization.";

const composeFixture = {
	composeId: "compose-1",
	name: "My Compose",
	appName: "myapp",
	sourceType: "github",
	githubId: "gh-foreign",
	owner: "me",
	repository: "repo",
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
	environment: { project: { organizationId: "org-1" } },
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

const run = () =>
	deployComposePreview({
		composeId: "compose-1",
		previewDeploymentId: "pd-1",
		titleLog: "Preview Deployment",
		descriptionLog: "",
	});

describe("compose preview with a stored provider of another organization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findComposeById.mockResolvedValue(composeFixture);
		mocks.pdFindFirst.mockResolvedValue(previewRow);
		mocks.createDeploymentPreview.mockResolvedValue({
			deploymentId: "deployment-id",
			logPath: "/tmp/preview.log",
		});
		mocks.ensurePreviewComment.mockResolvedValue({
			created: false,
			commentId: "1",
		});
		vi.mocked(assertDeployReferencesInOrganization).mockResolvedValue(
			undefined,
		);
	});

	it("posts no PR comment at all, not even the failure one, and does not build", async () => {
		vi.mocked(assertDeployReferencesInOrganization).mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: REFUSAL }),
		);

		await expect(run()).rejects.toThrow(REFUSAL);

		expect(assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			expect.objectContaining({ composeId: "compose-1" }),
		);
		expect(mocks.ensurePreviewComment).not.toHaveBeenCalled();
		expect(mocks.updatePreviewComment).not.toHaveBeenCalled();
		expect(mocks.runComposeBuild).not.toHaveBeenCalled();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-id",
			"error",
		);
	});

	it("still posts the running comment first when the references are fine", async () => {
		await run();

		expect(mocks.ensurePreviewComment).toHaveBeenCalled();
		expect(mocks.ensurePreviewComment.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runComposeBuild.mock.invocationCallOrder[0] as number,
		);
	});

	it("still posts the failure comment when the build itself fails", async () => {
		mocks.runComposeBuild.mockRejectedValueOnce(new Error("build failed"));

		await expect(run()).rejects.toThrow("build failed");

		// running, then error
		expect(mocks.ensurePreviewComment).toHaveBeenCalledTimes(2);
	});
});
