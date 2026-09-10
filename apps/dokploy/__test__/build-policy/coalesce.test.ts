import {
	coalesceQueuedDeploy,
	isCoalescableDeployJob,
} from "@dokploy/server/services/build-policy/coalesce";
import { describe, expect, it, vi } from "vitest";

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
				metadata: expect.objectContaining({
					removed: 1,
					unitName: "sendly-web",
				}),
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

/**
 * Finding 5 of the PR #209 review. Coalescing used the same predicate as the
 * explicit "clean queues" action, which matches on `applicationId` alone, so a
 * push to main silently cancelled the pull request preview that was waiting for
 * the same application.
 */
describe("isCoalescableDeployJob", () => {
	const push = {
		applicationId: "app-1",
		applicationType: "application",
		titleLog: "Push to main",
	};
	const preview = {
		applicationId: "app-1",
		applicationType: "application-preview",
		previewDeploymentId: "preview-1",
		titleLog: "PR #42 preview",
	};

	it("drops the unit's own plain deploy", () => {
		expect(isCoalescableDeployJob("application", "app-1", push)).toBe(true);
	});

	it("never drops a preview deployment of the same application", () => {
		expect(isCoalescableDeployJob("application", "app-1", preview)).toBe(false);
	});

	it("never drops a plain deploy of a different application", () => {
		expect(isCoalescableDeployJob("application", "app-2", push)).toBe(false);
	});

	it("never drops a compose job while coalescing an application", () => {
		expect(
			isCoalescableDeployJob("application", "app-1", {
				composeId: "app-1",
				applicationType: "compose",
			}),
		).toBe(false);
	});

	it("drops the unit's own compose deploy but not its compose preview", () => {
		expect(
			isCoalescableDeployJob("compose", "compose-1", {
				composeId: "compose-1",
				applicationType: "compose",
			}),
		).toBe(true);
		expect(
			isCoalescableDeployJob("compose", "compose-1", {
				composeId: "compose-1",
				applicationType: "compose-preview",
				previewDeploymentId: "preview-9",
			}),
		).toBe(false);
	});

	it("tolerates a job payload that is not an object", () => {
		expect(isCoalescableDeployJob("application", "app-1", null)).toBe(false);
		expect(isCoalescableDeployJob("application", "app-1", "app-1")).toBe(false);
	});
});

describe("coalescing a queue that also holds a preview", () => {
	/** Stands in for the in-memory queue's `removeWaiting`. */
	const fakeQueue = (jobs: Record<string, unknown>[]) => ({
		jobs,
		removeWaiting(predicate: (data: unknown) => boolean) {
			const titles: string[] = [];
			const kept = jobs.filter((job) => {
				if (!predicate(job)) return true;
				if (typeof job.titleLog === "string") titles.push(job.titleLog);
				return false;
			});
			this.jobs = kept;
			return { removed: jobs.length - kept.length, titles };
		},
	});

	it("leaves the waiting preview in the queue and names the dropped deploys", async () => {
		const queue = fakeQueue([
			{
				applicationId: "app-1",
				applicationType: "application",
				titleLog: "Push 1",
			},
			{
				applicationId: "app-1",
				applicationType: "application-preview",
				previewDeploymentId: "preview-1",
				titleLog: "PR #42 preview",
			},
			{
				applicationId: "app-2",
				applicationType: "application",
				titleLog: "Other app",
			},
		]);
		const recordAudit = vi.fn().mockResolvedValue(undefined);

		const result = await coalesceQueuedDeploy({
			unitType: "application",
			unitId: "app-1",
			unitName: "sendly-web",
			organizationId: "org-1",
			removeWaiting: () =>
				queue.removeWaiting((data) =>
					isCoalescableDeployJob("application", "app-1", data),
				),
			recordAudit,
		});

		expect(result).toEqual({ removed: 1 });
		expect(queue.jobs.map((job) => job.titleLog)).toEqual([
			"PR #42 preview",
			"Other app",
		]);
		expect(recordAudit.mock.calls[0]?.[0].metadata.droppedTitles).toEqual([
			"Push 1",
		]);
	});
});
