import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `previewDeployment.create` for a Docker-image application: no change
 * request exists, so the git provider (and its author gate) must never be
 * consulted, while the caller still needs the same permission as a deploy.
 */

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	createPreviewDeployment: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	resolveVerifiedPreviewAuthor: vi.fn(),
	assertPreviewAuthorAllowed: vi.fn(),
	queueAdd: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createComposePreview: vi.fn(),
	createPreviewDeployment: mocks.createPreviewDeployment,
	findApplicationById: mocks.findApplicationById,
	findComposeById: vi.fn(),
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	findPreviewDeploymentByComposeId: vi.fn(),
	findPreviewDeploymentById: mocks.findPreviewDeploymentById,
	findPreviewDeploymentsByApplicationId: vi.fn(),
	findPreviewDeploymentsByComposeId: vi.fn(),
	removePreviewDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/utils/preview-author-gate", () => ({
	resolveVerifiedPreviewAuthor: mocks.resolveVerifiedPreviewAuthor,
	assertPreviewAuthorAllowed: mocks.assertPreviewAuthorAllowed,
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: mocks.queueAdd },
}));

vi.mock("@/server/utils/deploy", () => ({ deploy: vi.fn() }));

const ctx = {
	session: { activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

const { previewDeploymentRouter } = await import(
	"@/server/api/routers/preview-deployment"
);
const caller = previewDeploymentRouter.createCaller(
	ctx as Parameters<typeof previewDeploymentRouter.createCaller>[0],
);

const dockerApplication = (extra = {}) => ({
	applicationId: "app-1",
	name: "image-app",
	sourceType: "docker",
	isPreviewDeploymentsActive: true,
	previewDockerImage: "ghcr.io/acme/app:pr-${{preview.prNumber}}",
	previewLimit: 3,
	previewDeployments: [],
	serverId: null,
	previewRequireCollaboratorPermissions: true,
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(undefined);
	mocks.createPreviewDeployment.mockResolvedValue({
		previewDeploymentId: "preview-1",
	});
	mocks.findPreviewDeploymentById.mockResolvedValue({
		previewDeploymentId: "preview-1",
	});
});

describe("previewDeployment.create for a Docker-image application", () => {
	it("creates the preview without consulting the git provider", async () => {
		mocks.findApplicationById.mockResolvedValue(dockerApplication());

		await caller.create({ applicationId: "app-1", pullRequestNumber: "42" });

		expect(mocks.resolveVerifiedPreviewAuthor).not.toHaveBeenCalled();
		expect(mocks.assertPreviewAuthorAllowed).not.toHaveBeenCalled();
		expect(mocks.createPreviewDeployment).toHaveBeenCalledWith({
			applicationId: "app-1",
			branch: "42",
			pullRequestId: "docker-42",
			pullRequestNumber: "42",
			pullRequestURL: "",
			pullRequestTitle: "ghcr.io/acme/app:pr-42",
		});
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "app-1",
				applicationType: "application-preview",
				type: "deploy",
				previewDeploymentId: "preview-1",
			}),
			expect.anything(),
		);
	});

	it("still requires the deploy permission on the application", async () => {
		mocks.findApplicationById.mockResolvedValue(dockerApplication());
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "UNAUTHORIZED" }),
		);

		await expect(
			caller.create({ applicationId: "app-1", pullRequestNumber: "42" }),
		).rejects.toThrow();

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["create"] },
		);
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("deploys an existing preview again instead of creating a second one", async () => {
		mocks.findApplicationById.mockResolvedValue(dockerApplication());
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue({
			previewDeploymentId: "preview-existing",
		});

		await caller.create({ applicationId: "app-1", pullRequestNumber: "42" });

		expect(mocks.findPreviewDeploymentByApplicationId).toHaveBeenCalledWith(
			"app-1",
			"docker-42",
		);
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({ previewDeploymentId: "preview-existing" }),
			expect.anything(),
		);
	});

	it("explains how to enable previews when no image template is set", async () => {
		mocks.findApplicationById.mockResolvedValue(
			dockerApplication({ previewDockerImage: null }),
		);

		await expect(
			caller.create({ applicationId: "app-1", pullRequestNumber: "42" }),
		).rejects.toThrow(
			"Set a preview image template to enable previews for Docker-image apps",
		);

		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
	});

	it("rejects an identifier that cannot be part of an image tag", async () => {
		mocks.findApplicationById.mockResolvedValue(dockerApplication());

		await expect(
			caller.create({
				applicationId: "app-1",
				pullRequestNumber: "42; rm -rf /",
			}),
		).rejects.toThrow("may only contain");

		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
	});

	it("honours the preview switch and the preview limit", async () => {
		mocks.findApplicationById.mockResolvedValueOnce(
			dockerApplication({ isPreviewDeploymentsActive: false }),
		);
		await expect(
			caller.create({ applicationId: "app-1", pullRequestNumber: "42" }),
		).rejects.toThrow("not enabled");

		mocks.findApplicationById.mockResolvedValueOnce(
			dockerApplication({
				previewLimit: 1,
				previewDeployments: [{ previewDeploymentId: "other" }],
			}),
		);
		await expect(
			caller.create({ applicationId: "app-1", pullRequestNumber: "43" }),
		).rejects.toThrow("limit reached");

		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
	});
});

describe("previewDeployment.create for a git provider application", () => {
	const githubApplication = {
		...dockerApplication(),
		sourceType: "github",
		previewDockerImage: null,
	};

	it("keeps the author gate", async () => {
		mocks.findApplicationById.mockResolvedValue(githubApplication);
		mocks.resolveVerifiedPreviewAuthor.mockImplementation(
			async (_resource: unknown, input: unknown) => input,
		);

		await caller.create({
			applicationId: "app-1",
			branch: "feature",
			pullRequestId: "1001",
			pullRequestNumber: "7",
			pullRequestURL: "https://github.com/acme/app/pull/7",
			pullRequestTitle: "Add a feature",
			pullRequestAuthor: "octocat",
		});

		expect(mocks.resolveVerifiedPreviewAuthor).toHaveBeenCalledTimes(1);
		expect(mocks.assertPreviewAuthorAllowed).toHaveBeenCalledTimes(1);
		expect(mocks.createPreviewDeployment).toHaveBeenCalledWith(
			expect.objectContaining({ pullRequestId: "1001", branch: "feature" }),
		);
	});

	it("still requires the change request fields", async () => {
		mocks.findApplicationById.mockResolvedValue(githubApplication);

		await expect(
			caller.create({ applicationId: "app-1", pullRequestNumber: "7" }),
		).rejects.toThrow("required to preview a pull request");

		expect(mocks.resolveVerifiedPreviewAuthor).not.toHaveBeenCalled();
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
	});

	it("does not offer previews to the other source types", async () => {
		mocks.findApplicationById.mockResolvedValue({
			...githubApplication,
			sourceType: "bitbucket",
		});

		await expect(
			caller.create({ applicationId: "app-1", pullRequestNumber: "7" }),
		).rejects.toThrow("Docker image");
	});
});
