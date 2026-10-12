import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	applicationsFindMany: vi.fn(),
	composeFindMany: vi.fn(),
	queueAdd: vi.fn(),
	findGitlabByWebhookSecret: vi.fn(),
	checkGitlabMemberPermissionsByUserId: vi.fn(),
	createPreviewDeployment: vi.fn(),
	createComposePreview: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
	findPreviewDeploymentByComposeId: vi.fn(),
	// build-policy: the enqueue-time gate the webhook calls before queueing.
	buildPolicyDeployGate: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => ({ conditions })),
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
}));

vi.mock("@/server/db/schema", () => ({
	applications: {},
	compose: {},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findMany: mocks.applicationsFindMany },
			compose: { findMany: mocks.composeFindMany },
		},
	},
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	shouldDeploy: vi.fn(() => true),
	buildPolicyDeployGate: mocks.buildPolicyDeployGate,
	checkGitlabMemberPermissionsByUserId:
		mocks.checkGitlabMemberPermissionsByUserId,
	createComposePreview: mocks.createComposePreview,
	createPreviewDeployment: mocks.createPreviewDeployment,
	createSecurityBlockedMRNote: vi.fn(),
	findGitlabByWebhookSecret: mocks.findGitlabByWebhookSecret,
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	findPreviewDeploymentByComposeId: mocks.findPreviewDeploymentByComposeId,
	findPreviewDeploymentsByPullRequestId: vi.fn(),
	removePreviewDeployment: vi.fn(),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: mocks.queueAdd },
	coalesceQueuedApplicationDeploys: vi.fn().mockResolvedValue(0),
	coalesceQueuedComposeDeploys: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: vi.fn(),
}));

import handler from "@/pages/api/deploy/gitlab";

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

const createRequest = (event: string, body: Record<string, unknown>) =>
	({
		headers: {
			"x-gitlab-event": event,
			"x-gitlab-token": "webhook-secret",
		},
		body,
	}) as unknown as NextApiRequest;

const project = { id: 99, path_with_namespace: "group/repository" };

const pushRequest = () =>
	createRequest("Push Hook", {
		ref: "refs/heads/main",
		checkout_sha: "abc123",
		project,
		commits: [{ id: "abc123", message: "fix: deploy", modified: ["a.ts"] }],
	});

const tagRequest = () =>
	createRequest("Tag Push Hook", {
		ref: "refs/tags/v1.0.0",
		checkout_sha: "abc123",
		project,
	});

const mergeRequest = () =>
	createRequest("Merge Request Hook", {
		project,
		object_attributes: {
			action: "open",
			id: 7,
			iid: 3,
			author_id: 5,
			target_branch: "main",
			source_branch: "feature",
			title: "Add a thing",
			url: "https://gitlab.example.com/group/repository/-/merge_requests/3",
			last_commit: { id: "abc123" },
		},
	});

const queueOptions = expect.objectContaining({
	removeOnComplete: true,
	removeOnFail: true,
});

const application = (serverId: string | null) => ({
	applicationId: "application-id",
	name: "app",
	serverId,
	watchPaths: null,
	previewDeployments: [],
	previewLabels: null,
	previewRequireCollaboratorPermissions: false,
});

const composeService = (serverId: string | null) => ({
	composeId: "compose-id",
	name: "stack",
	serverId,
	watchPaths: null,
	previewDeployments: [],
	previewLabels: null,
	previewRequireCollaboratorPermissions: false,
});

describe("GitLab webhook queues jobs on the server of the service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });
		mocks.findGitlabByWebhookSecret.mockResolvedValue({
			gitlabId: "gitlab-id",
		});
		mocks.buildPolicyDeployGate.mockResolvedValue({ deploy: true });
		mocks.checkGitlabMemberPermissionsByUserId.mockResolvedValue({
			hasWriteAccess: true,
			accessLevel: 40,
		});
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(undefined);
		mocks.findPreviewDeploymentByComposeId.mockResolvedValue(undefined);
		mocks.createPreviewDeployment.mockResolvedValue({
			previewDeploymentId: "app-preview-id",
		});
		mocks.createComposePreview.mockResolvedValue({
			previewDeploymentId: "compose-preview-id",
		});
	});

	it.each([
		["push", pushRequest],
		["tag", tagRequest],
	])(
		"queues %s deployments on the server of each service",
		async (_, request) => {
			mocks.applicationsFindMany.mockResolvedValue([application("server-a")]);
			mocks.composeFindMany.mockResolvedValue([composeService("server-b")]);

			await handler(request(), createResponse());

			expect(mocks.queueAdd).toHaveBeenCalledWith(
				"deployments",
				expect.objectContaining({
					applicationId: "application-id",
					applicationType: "application",
					serverId: "server-a",
				}),
				queueOptions,
			);
			expect(mocks.queueAdd).toHaveBeenCalledWith(
				"deployments",
				expect.objectContaining({
					composeId: "compose-id",
					applicationType: "compose",
					serverId: "server-b",
				}),
				queueOptions,
			);
		},
	);

	it("queues merge request previews on the server of each service", async () => {
		mocks.applicationsFindMany.mockResolvedValue([application("server-a")]);
		mocks.composeFindMany.mockResolvedValue([composeService("server-b")]);

		await handler(mergeRequest(), createResponse());

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application-preview",
				previewDeploymentId: "app-preview-id",
				serverId: "server-a",
			}),
			queueOptions,
		);
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				composeId: "compose-id",
				applicationType: "compose-preview",
				previewDeploymentId: "compose-preview-id",
				serverId: "server-b",
			}),
			queueOptions,
		);
	});

	it("leaves serverId off the jobs of local services", async () => {
		mocks.applicationsFindMany.mockResolvedValue([application(null)]);
		mocks.composeFindMany.mockResolvedValue([composeService(null)]);

		await handler(pushRequest(), createResponse());

		expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
		for (const [, job] of mocks.queueAdd.mock.calls) {
			expect(job.serverId).toBeUndefined();
		}
	});
});
