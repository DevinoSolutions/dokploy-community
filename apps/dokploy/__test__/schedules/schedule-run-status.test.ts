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
	findFirst: vi.fn(),
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
	return {
		db: {
			update: () => chain,
			query: { deployments: { findFirst: mocks.findFirst } },
		},
	};
});

import {
	claimScheduleRunCancel,
	finishScheduleRun,
	isScheduleRunCancelled,
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

			await expect(finishScheduleRun("dep-1", status)).resolves.toBe("recorded");

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

	it("reports a run whose row is cancelled as cancelled", async () => {
		mocks.returning.mockResolvedValue([]);
		mocks.findFirst.mockResolvedValue({ status: "cancelled" });

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe(
			"cancelled",
		);
	});

	it("reports a run whose row no longer exists as missing, not as cancelled", async () => {
		mocks.returning.mockResolvedValue([]);
		mocks.findFirst.mockResolvedValue(undefined);

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe("missing");
	});

	it("does not take a failed lookup for a cancel", async () => {
		mocks.returning.mockResolvedValue([]);
		mocks.findFirst.mockRejectedValue(new Error("db down"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe("missing");

		warn.mockRestore();
	});
});

describe("isScheduleRunCancelled", () => {
	it.each([
		["cancelled", true],
		["running", false],
		["error", false],
	])("is %s -> %s", async (status, expected) => {
		mocks.findFirst.mockResolvedValue({ status });

		await expect(isScheduleRunCancelled("dep-1")).resolves.toBe(expected);
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
