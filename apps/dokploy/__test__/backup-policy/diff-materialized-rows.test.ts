import {
	diffMaterializedRows,
	type ExistingMaterializedRow,
	type MaterializedRowPlan,
} from "@dokploy/server/services/backup-policy";
import { describe, expect, it } from "vitest";

type Insert = { serviceName: string; schedule: string };

const plan = (
	key: string,
	compare: Record<string, unknown>,
	insert?: Partial<Insert>,
): MaterializedRowPlan<Insert> => ({
	key,
	insert: { serviceName: key, schedule: "0 0 * * *", ...insert },
	compare,
});

const existing = (
	id: string,
	key: string,
	compare: Record<string, unknown>,
): ExistingMaterializedRow => ({ id, key, compare });

describe("diffMaterializedRows", () => {
	it("creates every desired row when nothing exists yet", () => {
		const desired = [
			plan("db:postgres:a", { schedule: "0 0 * * *" }),
			plan("db:postgres:b", { schedule: "0 0 * * *" }),
			plan("db:mysql:c", { schedule: "0 0 * * *" }),
		];

		const diff = diffMaterializedRows(desired, []);

		expect(diff.toCreate.map((p) => p.key)).toEqual([
			"db:postgres:a",
			"db:postgres:b",
			"db:mysql:c",
		]);
		expect(diff.toUpdate).toEqual([]);
		expect(diff.toDelete).toEqual([]);
	});

	it("produces no operations when desired and existing are identical", () => {
		const compare = { schedule: "0 0 * * *", destinationId: "dest-1" };
		const desired = [plan("db:postgres:a", compare)];
		const existingRows = [existing("backup-1", "db:postgres:a", compare)];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toCreate).toEqual([]);
		expect(diff.toUpdate).toEqual([]);
		expect(diff.toDelete).toEqual([]);
	});

	it.each([
		["schedule", { schedule: "0 0 * * *" }, { schedule: "*/5 * * * *" }],
		["destinationId", { destinationId: "dest-1" }, { destinationId: "dest-2" }],
		["prefix", { prefix: "a/b" }, { prefix: "a/c" }],
		["keepLatestCount", { keepLatestCount: 3 }, { keepLatestCount: 7 }],
		["enabled", { enabled: true }, { enabled: false }],
	])("updates a row when its %s field drifts", (_field, before, after) => {
		const desired = [plan("db:postgres:a", after, { serviceName: "pg" })];
		const existingRows = [existing("backup-1", "db:postgres:a", before)];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toCreate).toEqual([]);
		expect(diff.toDelete).toEqual([]);
		expect(diff.toUpdate).toEqual([
			{ id: "backup-1", insert: { serviceName: "pg", schedule: "0 0 * * *" } },
		]);
	});

	it("deletes rows whose service has left the policy scope", () => {
		const desired = [plan("db:postgres:a", { schedule: "0 0 * * *" })];
		const existingRows = [
			existing("backup-1", "db:postgres:a", { schedule: "0 0 * * *" }),
			existing("backup-2", "db:postgres:b", { schedule: "0 0 * * *" }),
		];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toCreate).toEqual([]);
		expect(diff.toUpdate).toEqual([]);
		expect(diff.toDelete).toEqual(["backup-2"]);
	});

	it("handles create, update and delete together in a single pass", () => {
		const desired = [
			// unchanged
			plan("db:postgres:a", { schedule: "0 0 * * *" }),
			// drifted -> update
			plan(
				"db:postgres:b",
				{ schedule: "*/5 * * * *" },
				{
					serviceName: "b",
					schedule: "*/5 * * * *",
				},
			),
			// brand new -> create
			plan("db:mysql:d", { schedule: "0 0 * * *" }, { serviceName: "d" }),
		];
		const existingRows = [
			existing("backup-a", "db:postgres:a", { schedule: "0 0 * * *" }),
			existing("backup-b", "db:postgres:b", { schedule: "0 0 * * *" }),
			// no longer in scope -> delete
			existing("backup-c", "db:postgres:c", { schedule: "0 0 * * *" }),
		];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toCreate.map((p) => p.key)).toEqual(["db:mysql:d"]);
		expect(diff.toUpdate).toEqual([
			{ id: "backup-b", insert: { serviceName: "b", schedule: "*/5 * * * *" } },
		]);
		expect(diff.toDelete).toEqual(["backup-c"]);
	});

	it("treats undefined and null in the compare set as equal (no drift)", () => {
		const desired = [
			plan("db:postgres:a", { keepLatestCount: null, prefix: "a/b" }),
		];
		const existingRows = [
			existing("backup-1", "db:postgres:a", { prefix: "a/b" }),
		];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toUpdate).toEqual([]);
		expect(diff.toCreate).toEqual([]);
		expect(diff.toDelete).toEqual([]);
	});

	it("treats a false value as distinct from an absent/null field", () => {
		const desired = [plan("db:postgres:a", { enabled: false })];
		const existingRows = [existing("backup-1", "db:postgres:a", {})];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toUpdate).toEqual([
			{
				id: "backup-1",
				insert: { serviceName: "db:postgres:a", schedule: "0 0 * * *" },
			},
		]);
	});

	it("never touches rows outside the policy-tagged input sets (coexist with manual)", () => {
		// The sync engine only ever passes rows already filtered by backupPolicyId,
		// so manual backups (no policyId) are absent from `existing` and can never
		// appear in any diff bucket. Assert the diff only references given ids/keys.
		const desired = [
			plan("db:postgres:a", { schedule: "0 0 * * *" }),
			plan("db:postgres:b", { schedule: "*/5 * * * *" }, { serviceName: "b" }),
		];
		const existingRows = [
			existing("policy-row-a", "db:postgres:a", { schedule: "0 0 * * *" }),
			existing("policy-row-b", "db:postgres:b", { schedule: "0 0 * * *" }),
		];

		const diff = diffMaterializedRows(desired, existingRows);

		const knownIds = new Set(existingRows.map((r) => r.id));
		const knownKeys = new Set(desired.map((p) => p.key));
		for (const id of diff.toDelete) expect(knownIds.has(id)).toBe(true);
		for (const upd of diff.toUpdate) expect(knownIds.has(upd.id)).toBe(true);
		for (const cr of diff.toCreate) expect(knownKeys.has(cr.key)).toBe(true);
		// A manual backup id never surfaces anywhere.
		expect(diff.toDelete).not.toContain("manual-row-x");
	});

	it("keys dump and volume rows in separate namespaces so same-id services do not collide", () => {
		// A dump row and a volume row for the same underlying service share the
		// service id but differ by kind prefix; the diff must treat them as distinct
		// rows (one create, one delete) rather than an update.
		const desired = [
			plan("vol:postgres:svc-1:data", { cronExpression: "0 0 * * *" }),
		];
		const existingRows = [
			existing("dump-row", "db:postgres:svc-1", { schedule: "0 0 * * *" }),
		];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toCreate.map((p) => p.key)).toEqual([
			"vol:postgres:svc-1:data",
		]);
		expect(diff.toDelete).toEqual(["dump-row"]);
		expect(diff.toUpdate).toEqual([]);
	});

	it("diffs a mixed dump + volume desired set independently per key", () => {
		const desired = [
			plan("db:postgres:a", { schedule: "0 0 * * *" }),
			plan("vol:application:app-1:uploads", { cronExpression: "0 0 * * *" }),
			plan(
				"vol:redis:r-1:data",
				{ cronExpression: "*/5 * * * *" },
				{
					serviceName: "redis-vol",
				},
			),
		];
		const existingRows = [
			existing("b-a", "db:postgres:a", { schedule: "0 0 * * *" }),
			existing("v-app", "vol:application:app-1:uploads", {
				cronExpression: "0 0 * * *",
			}),
			existing("v-redis", "vol:redis:r-1:data", {
				cronExpression: "0 0 * * *",
			}),
		];

		const diff = diffMaterializedRows(desired, existingRows);

		expect(diff.toCreate).toEqual([]);
		expect(diff.toDelete).toEqual([]);
		// Only the redis volume drifted on its cron.
		expect(diff.toUpdate).toEqual([
			{
				id: "v-redis",
				insert: { serviceName: "redis-vol", schedule: "0 0 * * *" },
			},
		]);
	});

	it("returns empty buckets for an empty desired and empty existing set", () => {
		const diff = diffMaterializedRows([], []);
		expect(diff.toCreate).toEqual([]);
		expect(diff.toUpdate).toEqual([]);
		expect(diff.toDelete).toEqual([]);
	});

	it("deletes all existing rows when the desired set becomes empty", () => {
		const existingRows = [
			existing("b-1", "db:postgres:a", { schedule: "0 0 * * *" }),
			existing("b-2", "db:postgres:b", { schedule: "0 0 * * *" }),
		];

		const diff = diffMaterializedRows([], existingRows);

		expect(diff.toDelete).toEqual(["b-1", "b-2"]);
		expect(diff.toCreate).toEqual([]);
		expect(diff.toUpdate).toEqual([]);
	});
});
