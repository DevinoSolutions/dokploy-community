import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The conditional updates that make a user cancel race-free (see
 * run-status.ts): each is ONE statement whose WHERE clause decides who wins,
 * so they are checked as the SQL they send.
 */

const mocks = vi.hoisted(() => ({
	returning: vi.fn(),
	where: vi.fn(),
	set: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const chain = {
		set: (values: unknown) => {
			mocks.set(values);
			return chain;
		},
		where: (condition: unknown) => {
			mocks.where(condition);
			return chain;
		},
		returning: () => mocks.returning(),
		// `revertScheduleRunCancel` awaits the update without `returning`.
		// biome-ignore lint/suspicious/noThenProperty: mimics a drizzle query
		then: (resolve: (value: unknown) => void) => resolve(undefined),
	};
	return { db: { update: () => chain } };
});

import {
	claimScheduleRunCancel,
	finishScheduleRun,
	revertScheduleRunCancel,
} from "@dokploy/server/utils/schedules/run-status";

const dialect = new PgDialect();
const lastWhere = () =>
	dialect.sqlToQuery(mocks.where.mock.calls.at(-1)?.[0] as never);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("claimScheduleRunCancel", () => {
	it("moves only a running run to cancelled, with a finish time", async () => {
		mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);

		await expect(claimScheduleRunCancel("dep-1")).resolves.toBe(true);

		expect(mocks.set).toHaveBeenCalledWith({
			status: "cancelled",
			finishedAt: expect.any(String),
		});
		const { sql, params } = lastWhere();
		expect(sql).toContain('"deploymentId" = $1');
		expect(sql).toContain('"status" = $2');
		expect(params).toEqual(["dep-1", "running"]);
	});

	it("is false when the run is no longer running", async () => {
		mocks.returning.mockResolvedValue([]);

		await expect(claimScheduleRunCancel("dep-1")).resolves.toBe(false);
	});
});

describe("finishScheduleRun", () => {
	it.each(["done", "error"] as const)(
		"records %s unless the run is cancelled",
		async (status) => {
			mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);

			await expect(finishScheduleRun("dep-1", status)).resolves.toBe(true);

			expect(mocks.set).toHaveBeenCalledWith({
				status,
				finishedAt: expect.any(String),
			});
			const { sql, params } = lastWhere();
			expect(sql).toContain('"deploymentId" = $1');
			expect(sql).toContain('"status" <> $2');
			expect(params).toEqual(["dep-1", "cancelled"]);
		},
	);

	it("is false, and changes nothing, for a cancelled run", async () => {
		mocks.returning.mockResolvedValue([]);

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe(false);
	});
});

describe("revertScheduleRunCancel", () => {
	it("puts only a cancelled run back to running and clears its finish time", async () => {
		await revertScheduleRunCancel("dep-1");

		expect(mocks.set).toHaveBeenCalledWith({
			status: "running",
			finishedAt: null,
		});
		const { sql, params } = lastWhere();
		expect(sql).toContain('"status" = $2');
		expect(params).toEqual(["dep-1", "cancelled"]);
	});
});
