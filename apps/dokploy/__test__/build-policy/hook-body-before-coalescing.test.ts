import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Round-2 review finding C. Both deploy-hook routes called
 * `buildPolicyDeployGate` — which coalesces, dropping the unit's still-waiting
 * deploys — and only afterwards validated the optional `{image, tag, digest}`
 * body, which can answer 400. So a POST with a malformed or foreign-repository
 * image emptied the unit's queue and then enqueued nothing, and a CI job
 * retrying with a broken body kept it that way.
 *
 * The compose route made it deterministic rather than accidental:
 * `rejectComposeDeployHookImage` refuses **every** body carrying an image while
 * the organization enforces, so a CI job that standardises on always posting one
 * would coalesce the queue and 400 on every push, for ever.
 *
 * The two calls are independent — the validation reads nothing the gate
 * produces — so the fix is to swap them. These tests pin the order by driving
 * the real handlers and asserting that a refused body means the gate was never
 * reached.
 */

const mocks = vi.hoisted(() => ({
	buildPolicyDeployGate: vi.fn(),
	resolveDeployHookImage: vi.fn(),
	rejectComposeDeployHookImage: vi.fn(),
	composeFindFirst: vi.fn(),
	applicationsFindFirst: vi.fn(),
	coalesceQueuedApplicationDeploys: vi.fn(),
	coalesceQueuedComposeDeploys: vi.fn(),
	queueAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@dokploy/server/services/build-policy/webhook", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/build-policy/webhook")
	>("@dokploy/server/services/build-policy/webhook");
	return {
		...actual,
		buildPolicyDeployGate: mocks.buildPolicyDeployGate,
		resolveDeployHookImage: mocks.resolveDeployHookImage,
		rejectComposeDeployHookImage: mocks.rejectComposeDeployHookImage,
	};
});

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: mocks.queueAdd },
	coalesceQueuedApplicationDeploys: mocks.coalesceQueuedApplicationDeploys,
	coalesceQueuedComposeDeploys: mocks.coalesceQueuedComposeDeploys,
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

import { db } from "@dokploy/server/db";
import composeHandler from "@/pages/api/deploy/compose/[refreshToken]";

const RAW_COMPOSE = {
	composeId: "compose-1",
	name: "Sendly Stack",
	appName: "sendly-stack",
	environmentId: "env-1",
	sourceType: "raw",
	autoDeploy: true,
	watchPaths: null,
	composePath: "./docker-compose.yml",
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
};

const makeRes = () => {
	const res: any = {};
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	return res as NextApiResponse;
};

const makeReq = (body: object): NextApiRequest =>
	({
		method: "POST",
		// No provider headers: a manual deploy-hook POST, which is exactly how a
		// CI job calls this.
		headers: {},
		query: { refreshToken: "token-1" },
		body,
	}) as any;

describe("finding C — the deploy-hook body is validated before coalescing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.queueAdd.mockResolvedValue(undefined);
		vi.mocked(db.query.compose.findFirst).mockResolvedValue(RAW_COMPOSE as any);
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: true,
			coalesced: 0,
		});
	});

	it("does not reach the gate when the compose body is refused", async () => {
		mocks.rejectComposeDeployHookImage.mockResolvedValue({
			ok: false,
			message:
				"Deploying a supplied image by digest is not supported for compose units.",
		});
		const res = makeRes();

		await composeHandler(makeReq({ image: "ghcr.io/devino/stack" }), res);

		expect(mocks.rejectComposeDeployHookImage).toHaveBeenCalledTimes(1);
		// The whole point: nothing was coalesced on behalf of a refused request.
		expect(mocks.buildPolicyDeployGate).not.toHaveBeenCalled();
		expect(mocks.coalesceQueuedComposeDeploys).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("still runs the gate, and enqueues, when the body is accepted", async () => {
		mocks.rejectComposeDeployHookImage.mockResolvedValue({ ok: true });
		const res = makeRes();

		await composeHandler(makeReq({}), res);

		expect(mocks.buildPolicyDeployGate).toHaveBeenCalledTimes(1);
		expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
	});

	it("a gate refusal still stops the deploy, with the gate's own message", async () => {
		mocks.rejectComposeDeployHookImage.mockResolvedValue({ ok: true });
		mocks.buildPolicyDeployGate.mockResolvedValue({
			deploy: false,
			reason: "skip_deploy_marker",
			message: "Deployment skipped: the commit message contains [skip deploy]",
		});
		const res = makeRes();

		await composeHandler(makeReq({}), res);

		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(301);
	});
});
