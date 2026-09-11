import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding 7 of the PR #209 review: `deployment.imageTag` and
 * `deployment.imageDigest` were written on every enforced deploy and read by
 * nothing, so spec 5.2.4's "rollback redeploys a stored digest with no build"
 * did not exist. Upstream's rollback replays a snapshot pushed to a dedicated
 * rollback registry and only covers units that have one.
 */

const mocks = vi.hoisted(() => ({
	deploymentsFindFirst: vi.fn(),
	deployPinnedApplicationImage: vi.fn(),
	recordBuildPolicyAudit: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { deployments: { findFirst: mocks.deploymentsFindFirst } } },
}));

vi.mock("@dokploy/server/services/build-policy/pinned-deploy", () => ({
	deployPinnedApplicationImage: mocks.deployPinnedApplicationImage,
	toPinnedImageJob: vi.fn(),
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

import {
	digestRefForRollback,
	rollbackToDeploymentDigest,
} from "@dokploy/server/services/build-policy/rollback";

const REPOSITORY = "ghcr.io/devinosolutions/sendly-web";
const DIGEST = `sha256:${"b".repeat(64)}`;

const DEPLOYMENT = (overrides: Record<string, unknown> = {}) => ({
	deploymentId: "deployment-7",
	applicationId: "app-1",
	imageTag: `${REPOSITORY}:abc1234`,
	imageDigest: DIGEST,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deploymentsFindFirst.mockResolvedValue(DEPLOYMENT());
	mocks.deployPinnedApplicationImage.mockResolvedValue(true);
	mocks.recordBuildPolicyAudit.mockResolvedValue(null);
});

describe("digestRefForRollback", () => {
	it("pins the stored tag to the stored digest", () => {
		expect(digestRefForRollback(DEPLOYMENT() as never)).toEqual({
			ref: `${REPOSITORY}@${DIGEST}`,
			tag: `${REPOSITORY}:abc1234`,
			digest: DIGEST,
		});
	});

	it("refuses a deployment that stored no digest", () => {
		expect(() =>
			digestRefForRollback(DEPLOYMENT({ imageDigest: null }) as never),
		).toThrow(/digest/i);
	});

	it("refuses a malformed stored digest", () => {
		expect(() =>
			digestRefForRollback(DEPLOYMENT({ imageDigest: "sha256:nope" }) as never),
		).toThrow(/digest/i);
	});

	it("refuses a digest with no tag to say which repository holds it", () => {
		expect(() =>
			digestRefForRollback(DEPLOYMENT({ imageTag: null }) as never),
		).toThrow(/tag|repository/i);
	});

	it("refuses a stored tag carrying shell metacharacters", () => {
		expect(() =>
			digestRefForRollback(
				DEPLOYMENT({ imageTag: `${REPOSITORY}:a;rm -rf /` }) as never,
			),
		).toThrow();
	});
});

describe("rollbackToDeploymentDigest", () => {
	it("redeploys the stored image with no build", async () => {
		await rollbackToDeploymentDigest({
			deploymentId: "deployment-7",
			organizationId: "org-1",
		});
		expect(mocks.deployPinnedApplicationImage).toHaveBeenCalledTimes(1);
		expect(mocks.deployPinnedApplicationImage.mock.calls[0]?.[0]).toMatchObject(
			{
				applicationId: "app-1",
				pinnedImage: {
					ref: `${REPOSITORY}@${DIGEST}`,
					digest: DIGEST,
				},
			},
		);
	});

	it("does not hold the rollback behind required checks", async () => {
		await rollbackToDeploymentDigest({
			deploymentId: "deployment-7",
			organizationId: "org-1",
		});
		expect(
			mocks.deployPinnedApplicationImage.mock.calls[0]?.[0]?.skipRequiredChecks,
		).toBe(true);
	});

	it("audits the rollback against the deployment it restored", async () => {
		await rollbackToDeploymentDigest({
			deploymentId: "deployment-7",
			organizationId: "org-1",
		});
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				action: "deploy_by_digest",
				applicationId: "app-1",
				metadata: expect.objectContaining({
					rolledBackToDeploymentId: "deployment-7",
					imageDigest: DIGEST,
				}),
			}),
		);
	});

	it("deploys nothing when the deployment stored no digest", async () => {
		mocks.deploymentsFindFirst.mockResolvedValue(
			DEPLOYMENT({ imageDigest: null }),
		);
		await expect(
			rollbackToDeploymentDigest({
				deploymentId: "deployment-7",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "DIGEST_NOT_PUBLISHED" });
		expect(mocks.deployPinnedApplicationImage).not.toHaveBeenCalled();
	});

	it("deploys nothing for a deployment that is not an application's", async () => {
		mocks.deploymentsFindFirst.mockResolvedValue(
			DEPLOYMENT({ applicationId: null }),
		);
		await expect(
			rollbackToDeploymentDigest({
				deploymentId: "deployment-7",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({ code: "DIGEST_NOT_PUBLISHED" });
		expect(mocks.deployPinnedApplicationImage).not.toHaveBeenCalled();
	});
});
