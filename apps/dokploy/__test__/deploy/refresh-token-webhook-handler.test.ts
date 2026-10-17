import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	applicationsFindFirst: vi.fn(),
	composeFindFirst: vi.fn(),
	queueAdd: vi.fn(),
	// build-policy: the enqueue-time gate and the deploy-hook body checks.
	buildPolicyDeployGate: vi.fn(),
	resolveDeployHookImage: vi.fn(),
	rejectComposeDeployHookImage: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
}));

vi.mock("@/server/db/schema", () => ({
	applications: {
		refreshToken: "application.refreshToken",
	},
	compose: {
		refreshToken: "compose.refreshToken",
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: {
				findFirst: mocks.applicationsFindFirst,
			},
			compose: {
				findFirst: mocks.composeFindFirst,
			},
		},
	},
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	shouldDeploy: vi.fn(() => true),
	getBitbucketHeaders: vi.fn(() => ({})),
	buildPolicyDeployGate: mocks.buildPolicyDeployGate,
	resolveDeployHookImage: mocks.resolveDeployHookImage,
	rejectComposeDeployHookImage: mocks.rejectComposeDeployHookImage,
	normalizeChangedFilesFromCommits: (commits: any) =>
		(commits ?? []).flatMap((commit: any) => commit?.modified ?? []),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: mocks.queueAdd,
	},
	coalesceQueuedApplicationDeploys: vi.fn().mockResolvedValue(0),
	coalesceQueuedComposeDeploys: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/server/utils/gitea-preview", () => ({
	handleGiteaApplicationPullRequestEvent: vi.fn(),
	handleGiteaComposePullRequestEvent: vi.fn(),
	isGiteaPullRequestEvent: vi.fn(() => false),
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: vi.fn(),
}));

import applicationHandler from "@/pages/api/deploy/[refreshToken]";
import composeHandler from "@/pages/api/deploy/compose/[refreshToken]";

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

const createGitlabPushRequest = () =>
	({
		query: {
			refreshToken: "refresh-token",
		},
		headers: {
			"x-gitlab-event": "Push Hook",
		},
		body: {
			ref: "refs/heads/main",
			checkout_sha: "abc123",
			commits: [
				{
					message: "fix: trigger deployment",
					modified: ["src/index.ts"],
				},
			],
		},
	}) as unknown as NextApiRequest;

describe("Refresh token webhook auto-deploy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });
		mocks.buildPolicyDeployGate.mockResolvedValue({ deploy: true });
		mocks.resolveDeployHookImage.mockResolvedValue({ ok: true });
		mocks.rejectComposeDeployHookImage.mockResolvedValue({ ok: true });
	});

	it("queues the application deployment on the server of the application", async () => {
		mocks.applicationsFindFirst.mockResolvedValue({
			applicationId: "application-id",
			appName: "app-name",
			name: "app",
			environment: { project: { organizationId: "org-id" } },
			autoDeploy: true,
			sourceType: "gitlab",
			gitlabBranch: "main",
			watchPaths: null,
			serverId: "server-id",
		});
		const res = createResponse();

		await applicationHandler(createGitlabPushRequest(), res);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				applicationId: "application-id",
				serverId: "server-id",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("queues the compose deployment on the server of the compose", async () => {
		mocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-id",
			name: "compose",
			autoDeploy: true,
			sourceType: "gitlab",
			gitlabBranch: "main",
			watchPaths: null,
			serverId: "server-id",
		});
		const res = createResponse();

		await composeHandler(createGitlabPushRequest(), res);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			"deployments",
			expect.objectContaining({
				composeId: "compose-id",
				serverId: "server-id",
			}),
			expect.objectContaining({
				removeOnComplete: true,
				removeOnFail: true,
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe("Refresh token webhook, push folded into a waiting deploy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });
		mocks.resolveDeployHookImage.mockResolvedValue({ ok: true });
		mocks.rejectComposeDeployHookImage.mockResolvedValue({ ok: true });
	});

	it("does not enqueue the application push when the gate merged it", async () => {
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: true,
			coalesced: 1,
			merged: true,
		});
		mocks.applicationsFindFirst.mockResolvedValue({
			applicationId: "application-id",
			appName: "app-name",
			name: "app",
			environment: { project: { organizationId: "org-id" } },
			autoDeploy: true,
			sourceType: "gitlab",
			gitlabBranch: "main",
			watchPaths: null,
			serverId: "server-id",
		});
		const res = createResponse();

		await applicationHandler(createGitlabPushRequest(), res);

		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("hands the gate the push payload to fold in, pinned image included", async () => {
		const pinnedImage = { ref: "r/app", tag: "t", digest: "sha256:new" };
		mocks.resolveDeployHookImage.mockResolvedValue({ ok: true, pinnedImage });
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: true,
			coalesced: 0,
		});
		mocks.applicationsFindFirst.mockResolvedValue({
			applicationId: "application-id",
			appName: "app-name",
			name: "app",
			environment: { project: { organizationId: "org-id" } },
			autoDeploy: true,
			sourceType: "gitlab",
			gitlabBranch: "main",
			watchPaths: null,
			serverId: "server-id",
		});
		const queueSetup = await import("@/server/queues/queueSetup");
		const res = createResponse();

		await applicationHandler(createGitlabPushRequest(), res);
		const gateArgs = mocks.buildPolicyDeployGate.mock.calls[0]?.[0];
		await gateArgs.removeWaiting();

		expect(queueSetup.coalesceQueuedApplicationDeploys).toHaveBeenCalledWith(
			"application-id",
			expect.objectContaining({ type: "deploy", pinnedImage }),
		);
		// Not merged: the push is enqueued as before.
		expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
	});

	it("does not enqueue the compose push when the gate merged it", async () => {
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: true,
			coalesced: 1,
			merged: true,
		});
		mocks.composeFindFirst.mockResolvedValue({
			composeId: "compose-id",
			appName: "compose-name",
			name: "stack",
			environmentId: "env-id",
			environment: { project: { organizationId: "org-id" } },
			autoDeploy: true,
			sourceType: "gitlab",
			gitlabBranch: "main",
			watchPaths: null,
			serverId: "server-id",
		});
		const res = createResponse();

		await composeHandler(createGitlabPushRequest(), res);

		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
	});
});
