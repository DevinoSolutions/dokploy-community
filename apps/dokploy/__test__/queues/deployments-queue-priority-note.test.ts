import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A job that went ahead of waiting jobs says so in the deployment it creates,
 * and one that ends early reports it to the queue (which hands back the
 * priority allowance).
 */

const mocks = vi.hoisted(() => ({
	deployCompose: vi.fn(),
	deployApplication: vi.fn(),
	updateCompose: vi.fn(),
	updateApplicationStatus: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	deployApplication: mocks.deployApplication,
	deployCompose: mocks.deployCompose,
	deployComposePreview: vi.fn(),
	deployPinnedApplicationImage: vi.fn(),
	deployPreviewApplication: vi.fn(),
	isDeploymentCancelledError: () => false,
	readServiceStatus: vi.fn(),
	rebuildApplication: vi.fn(),
	rebuildCompose: vi.fn(),
	rebuildComposePreview: vi.fn(),
	rebuildPreviewApplication: vi.fn(),
	restoreServiceStatusIfUnchanged: vi.fn(),
	updateApplicationStatus: mocks.updateApplicationStatus,
	updateCompose: mocks.updateCompose,
	updatePreviewDeployment: vi.fn(),
}));

import {
	describeJob,
	processDeploymentJob,
} from "@/server/queues/deployments-queue";

const job = (extra: Record<string, unknown> = {}, wentAheadOf?: number) =>
	({
		wentAheadOf,
		data: {
			applicationType: "application",
			type: "deploy",
			applicationId: "a1",
			titleLog: "Manual deployment",
			descriptionLog: "maintenance",
			...extra,
		},
	}) as any;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateApplicationStatus.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("describeJob", () => {
	it("leaves the description alone for a job that did not go ahead", () => {
		expect(describeJob(job({}, 0))).toBe("maintenance");
		expect(describeJob(job({ priority: true }, undefined))).toBe("maintenance");
	});

	it("says how many waiting jobs it went ahead of, and for whom", () => {
		expect(
			describeJob(job({ priority: true, priorityBy: "ops@x.io" }, 4)),
		).toBe(
			"maintenance - Deployed ahead of 4 waiting jobs (priority, requested by ops@x.io)",
		);
	});

	it("uses the singular and an empty base description", () => {
		expect(describeJob(job({ descriptionLog: "", priority: true }, 1))).toBe(
			"Deployed ahead of 1 waiting job (priority)",
		);
	});
});

describe("processDeploymentJob", () => {
	it("records the note on the deployment", async () => {
		mocks.deployApplication.mockResolvedValue(undefined);

		await expect(
			processDeploymentJob(job({ priority: true, priorityBy: "ops@x.io" }, 2)),
		).resolves.toBeUndefined();

		expect(mocks.deployApplication).toHaveBeenCalledWith({
			applicationId: "a1",
			titleLog: "Manual deployment",
			descriptionLog:
				"maintenance - Deployed ahead of 2 waiting jobs (priority, requested by ops@x.io)",
		});
	});

	it("does not touch the description of a normal job", async () => {
		mocks.deployApplication.mockResolvedValue(undefined);

		await processDeploymentJob(job());

		expect(mocks.deployApplication).toHaveBeenCalledWith({
			applicationId: "a1",
			titleLog: "Manual deployment",
			descriptionLog: "maintenance",
		});
	});

	it("reports a failed deployment to the queue", async () => {
		mocks.deployApplication.mockRejectedValue(new Error("build failed"));

		await expect(processDeploymentJob(job())).resolves.toBe("failed");
		expect(mocks.updateApplicationStatus).toHaveBeenLastCalledWith(
			"a1",
			"error",
		);
	});
});
