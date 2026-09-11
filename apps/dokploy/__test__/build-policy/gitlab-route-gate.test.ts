import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-2 review finding G. `skip-deploy.ts` claimed the marker was honoured on
 * every provider route, but `pages/api/deploy/gitlab.ts` had no build-policy
 * gate at all: `[skip deploy]` was ignored there and, more expensively for this
 * fork's purpose, GitLab-triggered deploys were never coalesced, so N pushes
 * produced N builds.
 *
 * These tests drive the real GitLab webhook handler with the gate mocked at its
 * module boundary and assert the four properties that matter: the gate is
 * consulted for applications and for compose units, its refusal stops the
 * enqueue, the commit message it receives is the real commit message (not the
 * "Push to <branch>" title, which no author ever writes `[skip deploy]` into),
 * and the coalescing callback targets the unit being enqueued.
 */

const mocks = vi.hoisted(() => ({
	buildPolicyDeployGate: vi.fn(),
	coalesceQueuedApplicationDeploys: vi.fn().mockResolvedValue({
		removed: 0,
		titles: [],
	}),
	coalesceQueuedComposeDeploys: vi.fn().mockResolvedValue({
		removed: 0,
		titles: [],
	}),
}));

vi.mock("@dokploy/server/services/build-policy/webhook", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/build-policy/webhook")
	>("@dokploy/server/services/build-policy/webhook");
	return { ...actual, buildPolicyDeployGate: mocks.buildPolicyDeployGate };
});

vi.mock("@dokploy/server/services/gitlab", async (importOriginal) => {
	const mod =
		await importOriginal<typeof import("@dokploy/server/services/gitlab")>();
	return { ...mod, findGitlabByWebhookSecret: vi.fn() };
});

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn().mockResolvedValue(undefined) },
	coalesceQueuedApplicationDeploys: mocks.coalesceQueuedApplicationDeploys,
	coalesceQueuedComposeDeploys: mocks.coalesceQueuedComposeDeploys,
}));

import { db } from "@dokploy/server/db";
import { findGitlabByWebhookSecret } from "@dokploy/server/services/gitlab";
import handler from "@/pages/api/deploy/gitlab";
import { myQueue } from "@/server/queues/queueSetup";

const PROVIDER = {
	gitlabId: "gitlab-id-1",
	gitlabUrl: "https://gitlab.example.com",
	webhookSecret: "super-secret",
	accessToken: "access-token",
};

const APP = {
	applicationId: "app-id-1",
	name: "My App",
	appName: "my-app",
	environmentId: "env-1",
	sourceType: "gitlab" as const,
	gitlabId: "gitlab-id-1",
	gitlabPathNamespace: "mygroup/myrepo",
	gitlabBranch: "main",
	watchPaths: null,
	buildPath: null,
	dockerfile: null,
	dockerContextPath: null,
	serverId: null,
};

const COMPOSE = {
	composeId: "compose-id-1",
	name: "My Compose",
	appName: "my-compose",
	environmentId: "env-2",
	sourceType: "gitlab" as const,
	gitlabId: "gitlab-id-1",
	gitlabPathNamespace: "mygroup/myrepo",
	gitlabBranch: "main",
	watchPaths: null,
	composePath: "./docker-compose.yml",
	serverId: null,
};

const pushPayload = (overrides: Record<string, unknown> = {}) => ({
	object_kind: "push",
	ref: "refs/heads/main",
	checkout_sha: "abc123",
	project: { id: 99, path_with_namespace: "mygroup/myrepo" },
	commits: [
		{
			id: "old000",
			message: "an earlier commit",
			added: [],
			modified: [],
			removed: [],
		},
		{
			id: "abc123",
			message: "fix: the head commit",
			added: ["src/index.ts"],
			modified: [],
			removed: [],
		},
	],
	...overrides,
});

const makeReq = (body: object): NextApiRequest =>
	({
		method: "POST",
		headers: {
			"x-gitlab-event": "Push Hook",
			"x-gitlab-token": "super-secret",
		},
		body,
	}) as any;

const makeRes = (): NextApiResponse => {
	const res: any = {};
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res as NextApiResponse;
};

/** The application query runs first, then the compose query. */
const rows = (apps: unknown[], composes: unknown[]) => {
	vi.mocked(db.query.applications.findMany).mockResolvedValueOnce(apps as any);
	vi.mocked(db.query.applications.findMany).mockResolvedValueOnce(
		composes as any,
	);
};

describe("GitLab push webhook — build-policy gate (finding G)", () => {
	beforeEach(() => {
		vi.mocked(findGitlabByWebhookSecret).mockResolvedValue(PROVIDER as any);
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: true,
			coalesced: 0,
		});
	});
	afterEach(() => vi.clearAllMocks());

	it("consults the gate before enqueueing an application deploy", async () => {
		rows([APP], []);
		await handler(makeReq(pushPayload()), makeRes());

		expect(mocks.buildPolicyDeployGate).toHaveBeenCalledTimes(1);
		expect(mocks.buildPolicyDeployGate).toHaveBeenCalledWith(
			expect.objectContaining({
				unitType: "application",
				unit: expect.objectContaining({
					unitId: "app-id-1",
					unitName: "My App",
					environmentId: "env-1",
				}),
			}),
		);
		expect(myQueue.add).toHaveBeenCalledTimes(1);
	});

	it("consults the gate before enqueueing a compose deploy", async () => {
		rows([], [COMPOSE]);
		await handler(makeReq(pushPayload()), makeRes());

		expect(mocks.buildPolicyDeployGate).toHaveBeenCalledWith(
			expect.objectContaining({
				unitType: "compose",
				unit: expect.objectContaining({
					unitId: "compose-id-1",
					environmentId: "env-2",
					composePath: "./docker-compose.yml",
				}),
			}),
		);
		expect(myQueue.add).toHaveBeenCalledTimes(1);
	});

	it("does not enqueue when the gate refuses the application deploy", async () => {
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: false,
			reason: "skip_deploy_marker",
			message: "Deployment skipped: the commit message contains [skip deploy]",
		});
		rows([APP], []);
		await handler(makeReq(pushPayload()), makeRes());

		expect(myQueue.add).not.toHaveBeenCalled();
	});

	it("does not enqueue when the gate refuses the compose deploy", async () => {
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: false,
			reason: "watch_paths",
			message: "Deployment skipped: no changed file matched",
		});
		rows([], [COMPOSE]);
		await handler(makeReq(pushPayload()), makeRes());

		expect(myQueue.add).not.toHaveBeenCalled();
	});

	it("passes the head commit's message, not the 'Push to <branch>' title", async () => {
		rows([APP], []);
		await handler(makeReq(pushPayload()), makeRes());

		expect(mocks.buildPolicyDeployGate.mock.calls[0]?.[0].commitMessage).toBe(
			"fix: the head commit",
		);
	});

	it("falls back to the newest commit when no id matches checkout_sha", async () => {
		rows([APP], []);
		await handler(
			makeReq(pushPayload({ checkout_sha: "not-in-the-list" })),
			makeRes(),
		);

		expect(mocks.buildPolicyDeployGate.mock.calls[0]?.[0].commitMessage).toBe(
			"fix: the head commit",
		);
	});

	it("passes no commit message when the payload carries no commits", async () => {
		rows([APP], []);
		await handler(makeReq(pushPayload({ commits: [] })), makeRes());

		expect(
			mocks.buildPolicyDeployGate.mock.calls[0]?.[0].commitMessage,
		).toBeNull();
	});

	it("passes the push's changed files so derived watch paths can be applied", async () => {
		rows([APP], []);
		await handler(makeReq(pushPayload()), makeRes());

		expect(mocks.buildPolicyDeployGate.mock.calls[0]?.[0].changedFiles).toEqual(
			["src/index.ts"],
		);
	});

	it("coalesces against the unit being enqueued, per unit type", async () => {
		rows([APP], []);
		await handler(makeReq(pushPayload()), makeRes());
		await mocks.buildPolicyDeployGate.mock.calls[0]?.[0].removeWaiting();
		expect(mocks.coalesceQueuedApplicationDeploys).toHaveBeenCalledWith(
			"app-id-1",
		);

		vi.clearAllMocks();
		vi.mocked(findGitlabByWebhookSecret).mockResolvedValue(PROVIDER as any);
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: true,
			coalesced: 0,
		});
		rows([], [COMPOSE]);
		await handler(makeReq(pushPayload()), makeRes());
		await mocks.buildPolicyDeployGate.mock.calls[0]?.[0].removeWaiting();
		expect(mocks.coalesceQueuedComposeDeploys).toHaveBeenCalledWith(
			"compose-id-1",
		);
	});

	it("still honours the unit's own explicit watchPaths before reaching the gate", async () => {
		rows([{ ...APP, watchPaths: ["docs/**"] }], []);
		await handler(makeReq(pushPayload()), makeRes());

		expect(mocks.buildPolicyDeployGate).not.toHaveBeenCalled();
		expect(myQueue.add).not.toHaveBeenCalled();
	});
});
