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
	// When set, updates run against this one row instead of returning canned
	// results, so the order in which a cancel and a run end can be replayed.
	row: null as { status: string; finishedAt: string | null } | null,
	emulate: false,
	update: vi.fn(),
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
		returning: () => (mocks.emulate ? mocks.update() : mocks.returning()),
		// `revertScheduleRunCancel` awaits the update without `returning`.
		// biome-ignore lint/suspicious/noThenProperty: mimics a drizzle query
		then: (resolve: (value: unknown) => void) => {
			if (mocks.emulate) mocks.update();
			resolve(undefined);
		},
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
	endScheduleRunCancelled,
	finishScheduleRun,
	isScheduleRunCancelled,
	revertScheduleRunCancel,
} from "@dokploy/server/utils/schedules/run-status";

const dialect = new PgDialect();
const lastWhere = () =>
	dialect.sqlToQuery(mocks.where.mock.calls.at(-1)?.[0] as never);

// Applies the last update to the row if its WHERE clause matches it, as the
// database would: each condition is a comparison of the status or the finish
// time, and the update is one statement, so it is atomic.
const applyLastUpdate = () => {
	const row = mocks.row;
	if (!row) return [];
	const { sql, params } = lastWhere();
	const comparisons = [
		...sql.matchAll(/"(status|finishedAt)" (=|<>) \$(\d+)/g),
	].every(([, column, operator, index]) => {
		const equal =
			row[column as "status" | "finishedAt"] === params[Number(index) - 1];
		return operator === "=" ? equal : !equal;
	});
	const memberships = [...sql.matchAll(/"status" in \(([^)]*)\)/g)].every(
		([, list]) =>
			[...(list as string).matchAll(/\$(\d+)/g)].some(
				([, index]) => row.status === params[Number(index) - 1],
			),
	);
	const matches = comparisons && memberships;
	if (!matches) return [];
	Object.assign(row, mocks.set.mock.calls.at(-1)?.[0]);
	return [{ deploymentId: "dep-1" }];
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.emulate = false;
	mocks.row = null;
	mocks.update.mockImplementation(applyLastUpdate);
});

describe("claimScheduleRunCancel", () => {
	it("moves only a running run to cancelled, with a finish time", async () => {
		mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);

		const claim = await claimScheduleRunCancel("dep-1");

		// The claim is the finish time it wrote, which a revert has to present.
		expect(claim).toEqual(expect.any(String));
		expect(mocks.set).toHaveBeenCalledWith({
			status: "cancelled",
			finishedAt: claim,
		});
		const { sql, params } = lastWhere();
		expect(sql).toContain('"deploymentId" = $1');
		expect(sql).toContain('"status" = $2');
		expect(params).toEqual(["dep-1", "running"]);
	});

	it("is null when the run is no longer running", async () => {
		mocks.returning.mockResolvedValue([]);

		await expect(claimScheduleRunCancel("dep-1")).resolves.toBeNull();
	});
});

describe("finishScheduleRun", () => {
	it.each(["done", "error"] as const)(
		"records %s unless the run is cancelled",
		async (status) => {
			mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);

			await expect(finishScheduleRun("dep-1", status)).resolves.toBe(
				"recorded",
			);

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

	it("reports a run whose row is cancelled as cancelled, and notes that it ended", async () => {
		mocks.returning
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ deploymentId: "dep-1" }]);

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe(
			"cancelled",
		);

		// The note: a new finish time on a row that is still cancelled.
		expect(mocks.set).toHaveBeenLastCalledWith({
			finishedAt: expect.any(String),
		});
		const { sql, params } = lastWhere();
		expect(sql).toContain('"status" = $2');
		expect(params).toEqual(["dep-1", "cancelled"]);
	});

	it("reports a run whose row no longer exists as missing, not as cancelled", async () => {
		mocks.returning.mockResolvedValue([]);

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe("missing");
	});

	it("tries again when a revert put the run back to running between its two updates", async () => {
		mocks.returning
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ deploymentId: "dep-1" }]);

		await expect(finishScheduleRun("dep-1", "done")).resolves.toBe("recorded");
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
	it("puts only a still-claimed run back to running and clears its finish time", async () => {
		mocks.returning.mockResolvedValue([{ deploymentId: "dep-1" }]);

		await expect(revertScheduleRunCancel("dep-1", "claim-1")).resolves.toBe(
			true,
		);

		expect(mocks.set).toHaveBeenCalledWith({
			status: "running",
			finishedAt: null,
		});
		const { sql, params } = lastWhere();
		expect(sql).toContain('"status" = $2');
		expect(sql).toContain('"finishedAt" = $3');
		expect(params).toEqual(["dep-1", "cancelled", "claim-1"]);
	});
});

describe("revertScheduleRunCancel, when there was nothing to undo", () => {
	it("is false", async () => {
		mocks.returning.mockResolvedValue([]);

		await expect(revertScheduleRunCancel("dep-1", "claim-1")).resolves.toBe(
			false,
		);
	});
});

describe("a cancel racing the natural end of the run", () => {
	beforeEach(() => {
		mocks.emulate = true;
		mocks.row = { status: "running", finishedAt: null };
	});

	it("ends a run whose cancel was undone as cancelled, and one still cancelled too", async () => {
		const claim = (await claimScheduleRunCancel("dep-1")) as string;
		await revertScheduleRunCancel("dep-1", claim);
		expect(mocks.row?.status).toBe("running");

		await endScheduleRunCancelled("dep-1");

		expect(mocks.row?.status).toBe("cancelled");
		expect(mocks.row?.finishedAt).toMatch(/\+00:00$/);

		await endScheduleRunCancelled("dep-1");
		expect(mocks.row?.status).toBe("cancelled");
	});

	it("does not touch a run that already ended", async () => {
		await finishScheduleRun("dep-1", "done");

		await endScheduleRunCancelled("dep-1");

		expect(mocks.row?.status).toBe("done");
	});

	it("claim, run ends, kill fails, revert: the run stays cancelled, not stuck running", async () => {
		const claim = await claimScheduleRunCancel("dep-1");
		expect(claim).not.toBeNull();
		expect(mocks.row?.status).toBe("cancelled");

		// The run ends on its own and sees the claim.
		await expect(finishScheduleRun("dep-1", "done")).resolves.toBe("cancelled");
		expect(mocks.row?.status).toBe("cancelled");

		// The kill then fails with an unhandled error, so the router reverts.
		await revertScheduleRunCancel("dep-1", claim as string);

		expect(mocks.row?.status).toBe("cancelled");
		expect(mocks.row?.finishedAt).not.toBeNull();
	});

	it("tells a revert whether it undid the claim", async () => {
		const claim = (await claimScheduleRunCancel("dep-1")) as string;
		await finishScheduleRun("dep-1", "done");
		await expect(revertScheduleRunCancel("dep-1", claim)).resolves.toBe(false);

		mocks.row = { status: "running", finishedAt: null };
		const second = (await claimScheduleRunCancel("dep-1")) as string;
		await expect(revertScheduleRunCancel("dep-1", second)).resolves.toBe(true);
	});

	it("notes the end of the run with a finish time that is a valid date but never a claim", async () => {
		vi.useFakeTimers();
		// A claim written by a clock that is ahead, behind or equal cannot match.
		try {
			for (const offsetMs of [-5000, 0, 5000]) {
				vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
				mocks.row = { status: "running", finishedAt: null };
				const claim = (await claimScheduleRunCancel("dep-1")) as string;
				vi.setSystemTime(new Date(Date.parse(claim) + offsetMs));

				await finishScheduleRun("dep-1", "error");
				await finishScheduleRun("dep-1", "error");

				const ended = mocks.row?.finishedAt as string;
				expect(ended).not.toBe(claim);
				expect(Number.isNaN(Date.parse(ended))).toBe(false);
				await expect(revertScheduleRunCancel("dep-1", claim)).resolves.toBe(
					false,
				);
				expect(mocks.row?.status).toBe("cancelled");
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("does the same when the run ends within the millisecond of the claim", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-12T12:00:00.000Z"));
		try {
			const claim = await claimScheduleRunCancel("dep-1");
			await finishScheduleRun("dep-1", "error");
			await revertScheduleRunCancel("dep-1", claim as string);
		} finally {
			vi.useRealTimers();
		}

		expect(mocks.row?.status).toBe("cancelled");
	});

	it("claim, revert, run ends: the run is recorded as done or error as usual", async () => {
		const claim = await claimScheduleRunCancel("dep-1");
		await revertScheduleRunCancel("dep-1", claim as string);
		expect(mocks.row).toEqual({ status: "running", finishedAt: null });

		await expect(finishScheduleRun("dep-1", "error")).resolves.toBe("recorded");

		expect(mocks.row?.status).toBe("error");
		expect(mocks.row?.finishedAt).not.toBeNull();
	});

	it("claim, kill fails, revert while the run is still going: back to running, cancellable again", async () => {
		const claim = await claimScheduleRunCancel("dep-1");

		await revertScheduleRunCancel("dep-1", claim as string);

		expect(mocks.row).toEqual({ status: "running", finishedAt: null });
		await expect(claimScheduleRunCancel("dep-1")).resolves.not.toBeNull();
	});

	it("a stale claim never reverts a later cancel of the same run", async () => {
		const first = await claimScheduleRunCancel("dep-1");
		await revertScheduleRunCancel("dep-1", first as string);
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.now() + 5000));
		try {
			await claimScheduleRunCancel("dep-1");
		} finally {
			vi.useRealTimers();
		}

		await revertScheduleRunCancel("dep-1", first as string);

		expect(mocks.row?.status).toBe("cancelled");
	});

	it("a run that ended before the cancel is not claimed", async () => {
		await finishScheduleRun("dep-1", "done");

		await expect(claimScheduleRunCancel("dep-1")).resolves.toBeNull();
		expect(mocks.row?.status).toBe("done");
	});
});
