import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectRows: vi.fn(),
	updateReturning: vi.fn(),
	markInterruptedFromJournal: vi.fn(),
	killOrphanedBuilds: vi.fn(),
	order: [] as string[],
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		select: () => ({
			from: () => ({
				leftJoin: () => ({ where: async () => mocks.selectRows() }),
			}),
		}),
		update: () => ({
			set: () => ({
				where: () =>
					Object.assign(Promise.resolve(undefined), {
						returning: async () => {
							mocks.order.push("cancelled");
							return mocks.updateReturning();
						},
					}),
			}),
		}),
	},
}));

vi.mock("@dokploy/server/services/deployment-queue-journal", () => ({
	markInterruptedFromJournal: mocks.markInterruptedFromJournal,
}));

vi.mock("@dokploy/server/services/orphan-build-kill", () => ({
	killOrphanedBuilds: mocks.killOrphanedBuilds,
}));

import { initCancelDeployments } from "@dokploy/server/utils/startup/cancel-deployments";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.order.length = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	mocks.markInterruptedFromJournal.mockResolvedValue(0);
	mocks.killOrphanedBuilds.mockImplementation(async () => {
		mocks.order.push("killed");
	});
});

describe("initCancelDeployments", () => {
	it("stops the remote build of every running deployment it cancels, after cancelling it", async () => {
		const cancelled = [
			{
				deploymentId: "d1",
				applicationId: "a",
				composeId: null,
				buildServerId: "build-1",
			},
		];
		mocks.selectRows.mockResolvedValue([
			{ deploymentId: "d1", scheduleId: null, scheduleType: null },
		]);
		mocks.updateReturning.mockResolvedValue(cancelled);

		await initCancelDeployments();

		expect(mocks.killOrphanedBuilds).toHaveBeenCalledWith(cancelled);
		expect(mocks.order).toEqual(["cancelled", "killed"]);
	});

	it("does not look for orphans when nothing was running", async () => {
		mocks.selectRows.mockResolvedValue([]);

		await initCancelDeployments();

		expect(mocks.killOrphanedBuilds).not.toHaveBeenCalled();
	});
});
