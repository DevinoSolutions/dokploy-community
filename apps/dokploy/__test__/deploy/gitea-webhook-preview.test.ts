import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createComposePreview: vi.fn(),
	createPreviewDeployment: vi.fn(),
	createPreviewSecurityBlockedComment: vi.fn(),
	checkPreviewAuthorPermissions: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
	findPreviewDeploymentByComposeId: vi.fn(),
	findPreviewDeploymentsByPullRequestId: vi.fn(),
	removePreviewDeployment: vi.fn(),
	queueAdd: vi.fn(),
	deploy: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	checkPreviewAuthorPermissions: mocks.checkPreviewAuthorPermissions,
	createComposePreview: mocks.createComposePreview,
	createPreviewDeployment: mocks.createPreviewDeployment,
	createPreviewSecurityBlockedComment:
		mocks.createPreviewSecurityBlockedComment,
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	findPreviewDeploymentByComposeId: mocks.findPreviewDeploymentByComposeId,
	findPreviewDeploymentsByPullRequestId:
		mocks.findPreviewDeploymentsByPullRequestId,
	getPreviewCommentContext: (resource: any) =>
		resource.giteaId && resource.giteaOwner && resource.giteaRepository
			? {
					provider: "gitea",
					providerId: resource.giteaId,
					owner: resource.giteaOwner,
					repository: resource.giteaRepository,
				}
			: null,
	removePreviewDeployment: mocks.removePreviewDeployment,
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: mocks.queueAdd },
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: mocks.deploy,
}));

import {
	handleGiteaApplicationPullRequestEvent,
	handleGiteaComposePullRequestEvent,
} from "@/server/utils/gitea-preview";

const createApplication = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	name: "my-app",
	sourceType: "gitea",
	serverId: null,
	giteaId: "gitea-1",
	giteaOwner: "acme",
	giteaRepository: "web",
	giteaBranch: "main",
	isPreviewDeploymentsActive: true,
	previewLabels: null,
	previewLimit: 3,
	previewRequireCollaboratorPermissions: true,
	previewDeployments: [],
	...overrides,
});

const createBody = ({
	pull_request: pullRequestOverrides,
	...overrides
}: Record<string, any> = {}) => ({
	action: "opened",
	repository: {
		name: "web",
		owner: { login: "acme" },
	},
	...overrides,
	pull_request: {
		id: 42,
		number: 7,
		title: "Add a thing",
		html_url: "https://gitea.example.com/acme/web/pulls/7",
		user: { login: "contributor" },
		labels: [],
		base: { ref: "main" },
		head: {
			ref: "feature/thing",
			sha: "deadbeef",
			repo: { name: "web", owner: { login: "acme" } },
		},
		...(pullRequestOverrides ?? {}),
	},
});

describe("handleGiteaApplicationPullRequestEvent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPreviewAuthorPermissions.mockResolvedValue({
			hasWriteAccess: true,
			permission: "write",
			verified: true,
		});
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(undefined);
		mocks.createPreviewDeployment.mockResolvedValue({
			previewDeploymentId: "preview-1",
		});
	});

	it("creates a preview deployment and queues a job when a pull request is opened", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewDeployment).toHaveBeenCalledWith({
			applicationId: "app-1",
			branch: "feature/thing",
			pullRequestId: "42",
			pullRequestNumber: "7",
			pullRequestTitle: "Add a thing",
			pullRequestURL: "https://gitea.example.com/acme/web/pulls/7",
		});
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "app-1",
				applicationType: "application-preview",
				previewDeploymentId: "preview-1",
				type: "deploy",
				descriptionLog: "Hash: deadbeef",
			}),
			expect.anything(),
		);
	});

	it("redeploys the existing preview on 'synchronized' without creating a second one", async () => {
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue({
			previewDeploymentId: "preview-existing",
		});

		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ action: "synchronized" }),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({ previewDeploymentId: "preview-existing" }),
			expect.anything(),
		);
	});

	it("removes only the previews of this application when the pull request is closed", async () => {
		mocks.findPreviewDeploymentsByPullRequestId.mockResolvedValue([
			{ previewDeploymentId: "preview-mine", applicationId: "app-1" },
			{ previewDeploymentId: "preview-other", applicationId: "app-2" },
		]);

		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ action: "closed" }),
		});

		expect(result.status).toBe(200);
		expect(mocks.removePreviewDeployment).toHaveBeenCalledExactlyOnceWith(
			"preview-mine",
		);
	});

	it("ignores a pull request that does not target the configured branch", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ pull_request: { base: { ref: "develop" } } }),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a payload from a different repository than the application is configured for", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({
				repository: { name: "other", owner: { login: "acme" } },
			}),
		});

		expect(result.status).toBe(400);
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("skips pull requests opened from a fork", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({
				pull_request: {
					head: {
						ref: "feature/thing",
						sha: "deadbeef",
						repo: { name: "web", owner: { login: "someone-else" } },
					},
				},
			}),
		});

		expect(result.status).toBe(200);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("blocks an author without write access and reports it on the pull request", async () => {
		mocks.checkPreviewAuthorPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: "read",
			verified: true,
		});

		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewSecurityBlockedComment).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "gitea" }),
			{ prNumber: 7, prAuthor: "contributor", permission: "read" },
		);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("skips without blaming the author when Gitea refuses the permission lookup", async () => {
		mocks.checkPreviewAuthorPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: null,
			verified: false,
		});

		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewSecurityBlockedComment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("authorizes the repository owner without calling the permission endpoint", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ pull_request: { user: { login: "Acme" } } }),
		});

		expect(result.status).toBe(200);
		expect(mocks.checkPreviewAuthorPermissions).not.toHaveBeenCalled();
		expect(mocks.queueAdd).toHaveBeenCalled();
	});

	it("skips the permission lookup when the security check is disabled", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication({
				previewRequireCollaboratorPermissions: false,
			}) as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.checkPreviewAuthorPermissions).not.toHaveBeenCalled();
		expect(mocks.queueAdd).toHaveBeenCalled();
	});

	it("applies the preview limit to new previews but still redeploys existing ones", async () => {
		const application = createApplication({
			previewLimit: 1,
			previewDeployments: [{ previewDeploymentId: "preview-existing" }],
		}) as any;

		const blocked = await handleGiteaApplicationPullRequestEvent({
			application,
			body: createBody(),
		});

		expect(blocked.message).toContain("limit");
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();

		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue({
			previewDeploymentId: "preview-existing",
		});

		const redeployed = await handleGiteaApplicationPullRequestEvent({
			application,
			body: createBody({ action: "synchronized" }),
		});

		expect(redeployed.status).toBe(200);
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({ previewDeploymentId: "preview-existing" }),
			expect.anything(),
		);
	});

	it("never creates a preview on 'label_cleared'", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ action: "label_cleared" }),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("only deploys labelled pull requests when preview labels are configured", async () => {
		const application = createApplication({
			previewLabels: ["preview"],
		}) as any;

		const withoutLabel = await handleGiteaApplicationPullRequestEvent({
			application,
			body: createBody({ pull_request: { labels: [{ name: "bug" }] } }),
		});

		expect(withoutLabel.status).toBe(200);
		expect(mocks.queueAdd).not.toHaveBeenCalled();

		const withLabel = await handleGiteaApplicationPullRequestEvent({
			application,
			body: createBody({ pull_request: { labels: [{ name: "preview" }] } }),
		});

		expect(withLabel.status).toBe(200);
		expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
	});

	it("does nothing when preview deployments are disabled for the application", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication({
				isPreviewDeploymentsActive: false,
			}) as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a payload without a pull request id", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ pull_request: { id: undefined } }),
		});

		expect(result.status).toBe(400);
	});

	it("rejects a payload without a pull request author", async () => {
		const result = await handleGiteaApplicationPullRequestEvent({
			application: createApplication() as any,
			body: createBody({ pull_request: { user: {} } }),
		});

		expect(result.status).toBe(400);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});
});

/**
 * Fork behaviour, mirroring `shouldDeployPreviewDeployment` in
 * `pages/api/deploy/github.ts`: a label change never redeploys a preview that
 * already exists. Upstream's Gitea handler redeploys on `label_updated`, which
 * also fires when a label is *removed* — and Gitea still ships the removed
 * label in the payload, so the label filter would pass for a pull request that
 * no longer carries it.
 */
describe("label events on an existing preview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPreviewAuthorPermissions.mockResolvedValue({
			hasWriteAccess: true,
			permission: "write",
			verified: true,
		});
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue({
			previewDeploymentId: "preview-existing",
		});
	});

	it.each(["label_updated", "label_cleared"])(
		"does not redeploy an existing preview on '%s'",
		async (action) => {
			const result = await handleGiteaApplicationPullRequestEvent({
				application: createApplication() as any,
				body: createBody({ action }),
			});

			expect(result.status).toBe(200);
			expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
			expect(mocks.queueAdd).not.toHaveBeenCalled();
		},
	);

	it.each(["opened", "reopened", "synchronized"])(
		"still redeploys an existing preview on '%s'",
		async (action) => {
			const result = await handleGiteaApplicationPullRequestEvent({
				application: createApplication() as any,
				body: createBody({ action }),
			});

			expect(result.status).toBe(200);
			expect(mocks.queueAdd).toHaveBeenCalledWith(
				"deployments",
				expect.objectContaining({ previewDeploymentId: "preview-existing" }),
				expect.anything(),
			);
		},
	);
});

const createCompose = (overrides: Record<string, unknown> = {}) => ({
	composeId: "compose-1",
	name: "my-stack",
	sourceType: "gitea",
	serverId: null,
	giteaId: "gitea-1",
	giteaOwner: "acme",
	giteaRepository: "web",
	giteaBranch: "main",
	isPreviewDeploymentsActive: true,
	previewLabels: null,
	previewLimit: 3,
	previewRequireCollaboratorPermissions: true,
	previewDeployments: [],
	...overrides,
});

describe("handleGiteaComposePullRequestEvent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.checkPreviewAuthorPermissions.mockResolvedValue({
			hasWriteAccess: true,
			permission: "write",
			verified: true,
		});
		mocks.findPreviewDeploymentByComposeId.mockResolvedValue(undefined);
		mocks.createComposePreview.mockResolvedValue({
			previewDeploymentId: "compose-preview-1",
		});
	});

	it("creates a compose preview and queues a compose-preview job", async () => {
		const result = await handleGiteaComposePullRequestEvent({
			compose: createCompose() as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.createComposePreview).toHaveBeenCalledWith({
			composeId: "compose-1",
			branch: "feature/thing",
			pullRequestId: "42",
			pullRequestNumber: "7",
			pullRequestTitle: "Add a thing",
			pullRequestURL: "https://gitea.example.com/acme/web/pulls/7",
		});
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				composeId: "compose-1",
				applicationType: "compose-preview",
				previewDeploymentId: "compose-preview-1",
			}),
			expect.anything(),
		);
	});

	it("blocks an author without write access on the compose path too", async () => {
		mocks.checkPreviewAuthorPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: "read",
			verified: true,
		});

		const result = await handleGiteaComposePullRequestEvent({
			compose: createCompose() as any,
			body: createBody(),
		});

		expect(result.status).toBe(200);
		expect(mocks.createPreviewSecurityBlockedComment).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "gitea" }),
			{ prNumber: 7, prAuthor: "contributor", permission: "read" },
		);
		expect(mocks.createComposePreview).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("removes only the compose previews of this compose service on close", async () => {
		mocks.findPreviewDeploymentsByPullRequestId.mockResolvedValue([
			{
				previewDeploymentId: "compose-preview-mine",
				applicationId: null,
				composeId: "compose-1",
			},
			{
				previewDeploymentId: "compose-preview-other",
				applicationId: null,
				composeId: "compose-2",
			},
			{
				previewDeploymentId: "application-preview",
				applicationId: "app-1",
				composeId: null,
			},
		]);

		const result = await handleGiteaComposePullRequestEvent({
			compose: createCompose() as any,
			body: createBody({ action: "closed" }),
		});

		expect(result.status).toBe(200);
		expect(mocks.removePreviewDeployment).toHaveBeenCalledExactlyOnceWith(
			"compose-preview-mine",
		);
	});
});
