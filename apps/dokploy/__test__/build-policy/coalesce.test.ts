import { describe, expect, it, vi } from "vitest";
import { coalesceQueuedDeploy } from "@dokploy/server/services/build-policy/coalesce";

describe("coalesceQueuedDeploy", () => {
	const base = {
		unitType: "application" as const,
		unitId: "app-1",
		organizationId: "org-1",
		unitName: "sendly-web",
	};

	it("drops the older queued deploy and audits it", async () => {
		const removeWaiting = vi.fn().mockResolvedValue(1);
		const recordAudit = vi.fn().mockResolvedValue(undefined);

		const result = await coalesceQueuedDeploy({
			...base,
			removeWaiting,
			recordAudit,
		});

		expect(result).toEqual({ removed: 1 });
		expect(removeWaiting).toHaveBeenCalledTimes(1);
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				action: "deploy_coalesced",
				applicationId: "app-1",
				composeId: null,
				metadata: expect.objectContaining({ removed: 1, unitName: "sendly-web" }),
			}),
		);
	});

	it("collapses several queued deploys into one audit entry", async () => {
		const recordAudit = vi.fn().mockResolvedValue(undefined);
		const result = await coalesceQueuedDeploy({
			...base,
			removeWaiting: vi.fn().mockResolvedValue(4),
			recordAudit,
		});
		expect(result).toEqual({ removed: 4 });
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(recordAudit.mock.calls[0]?.[0].metadata.removed).toBe(4);
	});

	it("writes nothing when there was no queued deploy to drop", async () => {
		const recordAudit = vi.fn();
		const result = await coalesceQueuedDeploy({
			...base,
			removeWaiting: vi.fn().mockResolvedValue(0),
			recordAudit,
		});
		expect(result).toEqual({ removed: 0 });
		expect(recordAudit).not.toHaveBeenCalled();
	});

	it("targets the compose id for a compose unit", async () => {
		const recordAudit = vi.fn().mockResolvedValue(undefined);
		await coalesceQueuedDeploy({
			unitType: "compose",
			unitId: "compose-1",
			organizationId: "org-1",
			unitName: "stack",
			removeWaiting: vi.fn().mockResolvedValue(2),
			recordAudit,
		});
		expect(recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ applicationId: null, composeId: "compose-1" }),
		);
	});

	it("never lets an audit failure block the deploy that is being enqueued", async () => {
		const result = await coalesceQueuedDeploy({
			...base,
			removeWaiting: vi.fn().mockResolvedValue(1),
			recordAudit: vi.fn().mockRejectedValue(new Error("db down")),
		});
		expect(result).toEqual({ removed: 1 });
	});

	it("never lets a queue failure block the deploy that is being enqueued", async () => {
		const recordAudit = vi.fn();
		const result = await coalesceQueuedDeploy({
			...base,
			removeWaiting: vi.fn().mockRejectedValue(new Error("queue gone")),
			recordAudit,
		});
		expect(result).toEqual({ removed: 0 });
		expect(recordAudit).not.toHaveBeenCalled();
	});
});
