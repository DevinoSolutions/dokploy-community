import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
	and: vi.fn((...conditions: Array<{ field: string; value: unknown }>) => ({
		conditions,
	})),
	githubFindFirst: vi.fn(),
	applicationsFindMany: vi.fn(),
	composeFindMany: vi.fn(),
	queueAdd: vi.fn(),
	verify: vi.fn(),
	shouldDeploy: vi.fn(),
	checkUserRepositoryPermissions: vi.fn(),
	createComposePreview: vi.fn(),
	createPreviewDeployment: vi.fn(),
	createSecurityBlockedComment: vi.fn(),
	findGithubById: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
	findPreviewDeploymentByComposeId: vi.fn(),
	findPreviewDeploymentsByPullRequestId: vi.fn(),
	removePreviewDeployment: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	eq: mocks.eq,
	and: mocks.and,
}));

vi.mock("@/server/db/schema", () => ({
	applications: {
		sourceType: "application.sourceType",
		autoDeploy: "application.autoDeploy",
		triggerType: "application.triggerType",
		branch: "application.branch",
		repository: "application.repository",
		owner: "application.owner",
		githubId: "application.githubId",
		isPreviewDeploymentsActive: "application.isPreviewDeploymentsActive",
	},
	compose: {
		sourceType: "compose.sourceType",
		autoDeploy: "compose.autoDeploy",
		triggerType: "compose.triggerType",
		branch: "compose.branch",
		repository: "compose.repository",
		owner: "compose.owner",
		githubId: "compose.githubId",
		isPreviewDeploymentsActive: "compose.isPreviewDeploymentsActive",
	},
	github: {
		githubInstallationId: "github.githubInstallationId",
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			github: {
				findFirst: mocks.githubFindFirst,
			},
			applications: {
				findMany: mocks.applicationsFindMany,
			},
			compose: {
				findMany: mocks.composeFindMany,
			},
		},
	},
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	shouldDeploy: mocks.shouldDeploy,
	normalizeChangedFilesFromCommits: (commits: any) =>
		(commits ?? [])
			.flatMap((commit: any) => [
				...(commit?.added ?? []),
				...(commit?.modified ?? []),
				...(commit?.removed ?? []),
			])
			.filter((path: any) => typeof path === "string" && path.length > 0),
	checkUserRepositoryPermissions: mocks.checkUserRepositoryPermissions,
	createComposePreview: mocks.createComposePreview,
	createPreviewDeployment: mocks.createPreviewDeployment,
	createSecurityBlockedComment: mocks.createSecurityBlockedComment,
	findGithubById: mocks.findGithubById,
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	findPreviewDeploymentByComposeId: mocks.findPreviewDeploymentByComposeId,
	findPreviewDeploymentsByPullRequestId:
		mocks.findPreviewDeploymentsByPullRequestId,
	getBitbucketHeaders: vi.fn(() => ({})),
	removePreviewDeployment: mocks.removePreviewDeployment,
}));

vi.mock("@octokit/webhooks", () => ({
	Webhooks: vi.fn().mockImplementation(function Webhooks() {
		return {
			verify: mocks.verify,
		};
	}),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: mocks.queueAdd,
	},
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: vi.fn(),
}));

import handler from "@/pages/api/deploy/github";

const getConditionValue = (
	where: { conditions?: Array<{ field: string; value: unknown }> } | undefined,
	field: string,
) => where?.conditions?.find((condition) => condition.field === field)?.value;

const createResponse = () => {
	const res = {
		status: vi.fn(),
		json: vi.fn(),
	} as unknown as NextApiResponse & {
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
	};

	res.status.mockImplementation(() => res);
	res.json.mockImplementation(() => res);

	return res;
};

const createPullRequestRequest = (
	action: string,
	{ labels = [] as Array<{ name: string }> } = {},
) =>
	({
		headers: {
			"x-hub-signature-256": "sha256=test-signature",
			"x-github-event": "pull_request",
		},
		body: {
			installation: {
				id: 12345,
			},
			action,
			repository: {
				name: "dokploy",
				full_name: "agentHits/dokploy",
				owner: { login: "agentHits" },
			},
			pull_request: {
				id: "pr-id-999",
				number: "42",
				title: "Add feature",
				html_url: "https://github.com/agentHits/dokploy/pull/42",
				head: { ref: "feature-branch", sha: "head-sha" },
				base: { ref: "main" },
				user: { login: "contributor" },
				labels,
			},
		},
	}) as unknown as NextApiRequest;

const composeFixture = (overrides: Record<string, unknown> = {}) => ({
	composeId: "compose-id",
	name: "my-compose",
	serverId: null,
	previewRequireCollaboratorPermissions: true,
	previewLabels: [],
	previewLimit: 3,
	previewDeployments: [],
	domains: [],
	...overrides,
});

describe("GitHub webhook compose preview deployments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "github-provider-id",
			githubInstallationId: 12345,
			githubWebhookSecret: "webhook-secret",
		});
		mocks.verify.mockResolvedValue(true);
		mocks.shouldDeploy.mockReturnValue(true);
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });
		// No application previews in these scenarios — isolate the compose loop.
		mocks.applicationsFindMany.mockResolvedValue([]);
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(undefined);
		mocks.findPreviewDeploymentByComposeId.mockResolvedValue(undefined);
		mocks.findGithubById.mockResolvedValue({
			githubId: "github-provider-id",
		});
		mocks.checkUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: true,
			permission: "write",
		});
		mocks.createComposePreview.mockResolvedValue({
			previewDeploymentId: "compose-preview-id",
		});

		mocks.composeFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "compose.sourceType") === "github" &&
				getConditionValue(where, "compose.repository") === "dokploy" &&
				getConditionValue(where, "compose.branch") === "main" &&
				getConditionValue(where, "compose.isPreviewDeploymentsActive") ===
					true &&
				getConditionValue(where, "compose.owner") === "agentHits" &&
				getConditionValue(where, "compose.githubId") === "github-provider-id";

			return Promise.resolve(matches ? [composeFixture()] : []);
		});
	});

	it("creates a compose preview with the PR head branch on opened", async () => {
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createComposePreview).toHaveBeenCalledWith({
			composeId: "compose-id",
			branch: "feature-branch",
			pullRequestId: "pr-id-999",
			pullRequestNumber: "42",
			pullRequestTitle: "Add feature",
			pullRequestURL: "https://github.com/agentHits/dokploy/pull/42",
		});
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				composeId: "compose-id",
				applicationType: "compose-preview",
				type: "deploy",
				previewDeploymentId: "compose-preview-id",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("reuses the existing preview on synchronize instead of creating a duplicate", async () => {
		mocks.findPreviewDeploymentByComposeId.mockResolvedValue({
			previewDeploymentId: "existing-preview-id",
		});
		const res = createResponse();

		await handler(createPullRequestRequest("synchronize"), res);

		expect(mocks.createComposePreview).not.toHaveBeenCalled();
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				composeId: "compose-id",
				applicationType: "compose-preview",
				previewDeploymentId: "existing-preview-id",
			}),
			expect.anything(),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("tears down every preview of the PR on closed", async () => {
		mocks.findPreviewDeploymentsByPullRequestId.mockResolvedValue([
			{ previewDeploymentId: "app-preview-id" },
			{ previewDeploymentId: "compose-preview-id" },
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("closed"), res);

		expect(mocks.findPreviewDeploymentsByPullRequestId).toHaveBeenCalledWith(
			"pr-id-999",
		);
		expect(mocks.removePreviewDeployment).toHaveBeenCalledTimes(2);
		expect(mocks.removePreviewDeployment).toHaveBeenCalledWith(
			"app-preview-id",
		);
		expect(mocks.removePreviewDeployment).toHaveBeenCalledWith(
			"compose-preview-id",
		);
		expect(res.json).toHaveBeenCalledWith({
			message: "Preview Deployment Closed",
		});
	});

	it("skips composes whose preview labels do not match the PR labels", async () => {
		mocks.composeFindMany.mockResolvedValue([
			composeFixture({ previewLabels: ["preview"] }),
		]);
		const res = createResponse();

		await handler(
			createPullRequestRequest("opened", { labels: [{ name: "bug" }] }),
			res,
		);

		expect(mocks.createComposePreview).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("creates the preview when a configured preview label is present", async () => {
		mocks.composeFindMany.mockResolvedValue([
			composeFixture({ previewLabels: ["preview"] }),
		]);
		const res = createResponse();

		await handler(
			createPullRequestRequest("opened", { labels: [{ name: "preview" }] }),
			res,
		);

		expect(mocks.createComposePreview).toHaveBeenCalledTimes(1);
	});

	it("blocks PR authors without write access and posts a security comment", async () => {
		mocks.checkUserRepositoryPermissions.mockResolvedValue({
			hasWriteAccess: false,
			permission: "read",
		});
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createComposePreview).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(mocks.createSecurityBlockedComment).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "agentHits",
				repository: "dokploy",
				prAuthor: "contributor",
			}),
		);
	});

	it("skips the permission check when previewRequireCollaboratorPermissions is disabled", async () => {
		mocks.composeFindMany.mockResolvedValue([
			composeFixture({ previewRequireCollaboratorPermissions: false }),
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.checkUserRepositoryPermissions).not.toHaveBeenCalled();
		expect(mocks.createComposePreview).toHaveBeenCalledTimes(1);
	});

	it("does not create a new preview once the preview limit is reached", async () => {
		mocks.composeFindMany.mockResolvedValue([
			composeFixture({
				previewLimit: 1,
				previewDeployments: [{ previewDeploymentId: "already-there" }],
			}),
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createComposePreview).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});
});
