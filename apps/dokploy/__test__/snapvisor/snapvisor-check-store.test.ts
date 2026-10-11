import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The database half of the Snapvisor build watch: which deployed commits
 * become checks, and the conditional update that decides who may notify.
 */

const mocks = vi.hoisted(() => ({
	deployments: [] as Record<string, unknown>[],
	previews: [] as Record<string, unknown>[],
	applications: [] as Record<string, unknown>[],
	composes: [] as Record<string, unknown>[],
	integrations: [] as Record<string, unknown>[],
	checks: [] as Record<string, unknown>[],
	inserted: [] as Record<string, unknown>[],
	insertConflict: vi.fn(),
	deploymentsFindMany: vi.fn(),
	// `null`: return the rows the conditional update really changed.
	updateReturning: [] as unknown[] | null,
	updateSet: vi.fn(),
	updateWhere: vi.fn(),
}));

/**
 * Applies the simple `"column" <op> $n` conditions of a compiled `where` to an
 * in-memory row, so the tests can check what a query keeps and what it drops
 * (behaviour) instead of which column names appear in the SQL text.
 */
const matchesWhere = (where: unknown, row: Record<string, unknown>) => {
	if (!where) return true;
	const { sql, params } = new PgDialect().sqlToQuery(where as never);
	const normalize = (value: unknown) =>
		value instanceof Date
			? value.getTime()
			: typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
				? Date.parse(value)
				: value;
	return [
		...sql.matchAll(/"(\w+)"\s*(<=|>=|=|<|>|like)\s*\$(\d+)/gi),
	].every(([, column, op, index]) => {
		const actual = normalize(row[column as string]) as number;
		const wanted = normalize(params[Number(index) - 1]) as number;
		switch ((op as string).toLowerCase()) {
			case "=":
				return actual === wanted;
			case "<":
				return actual < wanted;
			case "<=":
				return actual <= wanted;
			case ">":
				return actual > wanted;
			case ">=":
				return actual >= wanted;
			default:
				return (
					typeof actual === "string" &&
					(actual as string).startsWith(String(wanted).replace(/%$/, ""))
				);
		}
	});
};

const filterRows = (rows: Record<string, unknown>[], where: unknown) =>
	rows.filter((row) => matchesWhere(where, row));

vi.mock("@dokploy/server/db", () => {
	const table = (rows: () => unknown[]) => ({
		findMany: vi.fn(async () => rows()),
		findFirst: vi.fn(async () => rows()[0]),
	});
	return {
		db: {
			query: {
				deployments: {
					findMany: vi.fn(async (args: { where?: unknown }) => {
						mocks.deploymentsFindMany();
						return filterRows(mocks.deployments, args?.where);
					}),
					findFirst: vi.fn(),
				},
				snapvisorBuildCheck: {
					findMany: vi.fn(async (args: { where?: unknown; limit?: number }) =>
						filterRows(mocks.checks, args?.where)
							.sort(
								(a, b) =>
									(a.nextCheckAt as Date).getTime() -
									(b.nextCheckAt as Date).getTime(),
							)
							.slice(0, args?.limit),
					),
				},
				previewDeployments: table(() => mocks.previews),
				applications: table(() => mocks.applications),
				compose: table(() => mocks.composes),
				snapvisorIntegration: table(() => mocks.integrations),
			},
			insert: vi.fn(() => ({
				values: vi.fn((values: Record<string, unknown>[]) => {
					mocks.inserted.push(...values);
					return {
						onConflictDoNothing: vi.fn(() => {
							mocks.insertConflict();
							return {
								returning: vi.fn(async () =>
									values.map((_, i) => ({ checkId: `new-${i}` })),
								),
							};
						}),
					};
				}),
			})),
			update: vi.fn(() => ({
				set: vi.fn((values: unknown) => {
					mocks.updateSet(values);
					return {
						where: vi.fn((where: unknown) => {
							mocks.updateWhere(where);
							return {
								returning: vi.fn(async () => {
									if (mocks.updateReturning) return mocks.updateReturning;
									const changed = filterRows(mocks.checks, where);
									for (const row of changed) Object.assign(row, values);
									return changed.map((row) => ({ checkId: row.checkId }));
								}),
							};
						}),
					};
				}),
			})),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

const { createSnapvisorCheckStore, SNAPVISOR_WATCH_WINDOW_MS } = await import(
	"@dokploy/server/services/snapvisor-checks"
);

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const NOW = new Date("2026-10-11T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const deployment = (overrides: Record<string, unknown> = {}) => ({
	deploymentId: "dep-1",
	status: "done",
	applicationId: "app-1",
	composeId: null,
	previewDeploymentId: null,
	description: `Commit: ${SHA_A}`,
	createdAt: minutesAgo(30).toISOString(),
	finishedAt: minutesAgo(25).toISOString(),
	...overrides,
});

const linkedApplication = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	snapvisorProjectName: "web-app",
	sourceType: "github",
	environment: { project: { organizationId: "org-1" } },
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.deployments = [];
	mocks.previews = [];
	mocks.applications = [linkedApplication()];
	mocks.composes = [];
	mocks.integrations = [{ organizationId: "org-1" }];
	mocks.checks = [];
	mocks.inserted = [];
	mocks.updateReturning = [];
});

describe("discover", () => {
	it("watches a deployed commit of a linked service in a connected organization", async () => {
		mocks.deployments = [deployment()];

		const added = await createSnapvisorCheckStore().discover(NOW);

		expect(added).toBe(1);
		expect(mocks.insertConflict).toHaveBeenCalledTimes(1);
		expect(mocks.inserted).toEqual([
			{
				organizationId: "org-1",
				serviceType: "application",
				serviceId: "app-1",
				deploymentId: "dep-1",
				commitSha: SHA_A,
				nextCheckAt: NOW,
				expiresAt: new Date(
					minutesAgo(25).getTime() + SNAPVISOR_WATCH_WINDOW_MS,
				),
			},
		]);
	});

	it("watches a compose service", async () => {
		mocks.deployments = [
			deployment({ applicationId: null, composeId: "compose-1" }),
		];
		mocks.applications = [];
		mocks.composes = [
			{
				composeId: "compose-1",
				snapvisorProjectName: "stack-app",
				sourceType: "git",
				environment: { project: { organizationId: "org-1" } },
			},
		];

		await createSnapvisorCheckStore().discover(NOW);

		expect(mocks.inserted).toMatchObject([
			{ serviceType: "compose", serviceId: "compose-1" },
		]);
	});

	it("resolves a preview deployment to its service", async () => {
		mocks.deployments = [
			deployment({ applicationId: null, previewDeploymentId: "preview-1" }),
		];
		mocks.previews = [
			{
				previewDeploymentId: "preview-1",
				applicationId: "app-1",
				composeId: null,
			},
		];

		await createSnapvisorCheckStore().discover(NOW);

		expect(mocks.inserted).toMatchObject([
			{ serviceType: "application", serviceId: "app-1", commitSha: SHA_A },
		]);
	});

	it("keeps one check per commit however often it was deployed, preferring the latest", async () => {
		mocks.deployments = [
			deployment({ deploymentId: "dep-new" }),
			deployment({ deploymentId: "dep-old" }),
			deployment({ deploymentId: "dep-b", description: `Commit: ${SHA_B}` }),
		];

		await createSnapvisorCheckStore().discover(NOW);

		expect(
			mocks.inserted.map((v) => [v.commitSha, v.deploymentId]).sort(),
		).toEqual([
			[SHA_A, "dep-new"],
			[SHA_B, "dep-b"],
		]);
	});

	it("skips a service that is not linked to a Snapvisor project", async () => {
		mocks.deployments = [deployment()];
		mocks.applications = [linkedApplication({ snapvisorProjectName: null })];

		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.inserted).toEqual([]);
	});

	it("skips an organization that has not connected Snapvisor", async () => {
		mocks.deployments = [deployment()];
		mocks.integrations = [];

		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.inserted).toEqual([]);
	});

	it("skips a deployment whose watch window has already closed", async () => {
		mocks.deployments = [
			deployment({
				createdAt: minutesAgo(7 * 60).toISOString(),
				finishedAt: minutesAgo(6 * 60 + 5).toISOString(),
			}),
		];

		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.inserted).toEqual([]);
	});

	it("ignores a short or malformed commit marker", async () => {
		mocks.deployments = [
			deployment({ description: "Commit: abc1234" }),
			deployment({ deploymentId: "dep-2", description: null }),
		];

		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
	});

	it("does not start a watch for a deployment that failed or is still running", async () => {
		mocks.deployments = [
			deployment({ deploymentId: "dep-error", status: "error" }),
			deployment({
				deploymentId: "dep-running",
				status: "running",
				description: `Commit: ${SHA_B}`,
			}),
		];

		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.inserted).toEqual([]);

		// Of two deploys of different commits only the finished one is watched.
		mocks.deployments = [
			deployment({
				deploymentId: "dep-running",
				status: "running",
				description: `Commit: ${SHA_B}`,
			}),
			deployment({ deploymentId: "dep-done" }),
		];
		await createSnapvisorCheckStore().discover(NOW);
		expect(mocks.inserted.map((v) => [v.commitSha, v.deploymentId])).toEqual([
			[SHA_A, "dep-done"],
		]);
	});

	it("stores the commit in lower case however the marker was written", async () => {
		mocks.deployments = [
			deployment({ description: `Commit: ${SHA_A.toUpperCase()}` }),
		];

		await createSnapvisorCheckStore().discover(NOW);

		expect(mocks.inserted).toMatchObject([{ commitSha: SHA_A }]);
	});

	it("does not trust a commit marker on a service that is not git-sourced", async () => {
		for (const sourceType of ["docker", "drop"]) {
			mocks.deployments = [deployment()];
			mocks.applications = [linkedApplication({ sourceType })];
			await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		}

		mocks.deployments = [
			deployment({ applicationId: null, composeId: "compose-1" }),
		];
		mocks.applications = [];
		mocks.composes = [
			{
				composeId: "compose-1",
				snapvisorProjectName: "stack-app",
				sourceType: "raw",
				environment: { project: { organizationId: "org-1" } },
			},
		];
		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.inserted).toEqual([]);
	});

	it.each(["git", "github", "gitlab", "bitbucket", "gitea"])(
		"watches a %s-sourced service",
		async (sourceType) => {
			mocks.deployments = [deployment()];
			mocks.applications = [linkedApplication({ sourceType })];

			await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(1);
		},
	);

	it("does not even scan deployments while no organization has Snapvisor connected", async () => {
		mocks.deployments = [deployment()];
		mocks.integrations = [];

		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.deploymentsFindMany).not.toHaveBeenCalled();
	});

	it("does nothing when nothing was deployed", async () => {
		await expect(createSnapvisorCheckStore().discover(NOW)).resolves.toBe(0);
		expect(mocks.insertConflict).not.toHaveBeenCalled();
	});
});

describe("claimNotification", () => {
	it("is granted to exactly the caller whose conditional update changed a row", async () => {
		const store = createSnapvisorCheckStore();

		mocks.updateReturning = [{ checkId: "check-1" }];
		await expect(store.claimNotification("check-1", NOW)).resolves.toBe(true);

		mocks.updateReturning = [];
		await expect(store.claimNotification("check-1", NOW)).resolves.toBe(false);
	});

	it("only claims a check that is still pending", async () => {
		await createSnapvisorCheckStore().claimNotification("check-1", NOW);

		expect(mocks.updateSet).toHaveBeenCalledWith({
			state: "notified",
			notifiedAt: NOW,
		});
		const query = new PgDialect().sqlToQuery(
			mocks.updateWhere.mock.calls[0]?.[0] as never,
		);
		expect(query.sql).toContain('"checkId"');
		expect(query.sql).toContain('"state"');
		expect(query.params).toEqual(["check-1", "pending"]);
	});
});

describe("expireOverdue", () => {
	it("marks only pending checks past their window", async () => {
		mocks.updateReturning = [{ checkId: "a" }, { checkId: "b" }];

		await expect(createSnapvisorCheckStore().expireOverdue(NOW)).resolves.toBe(
			2,
		);

		expect(mocks.updateSet).toHaveBeenCalledWith({ state: "expired" });
		const query = new PgDialect().sqlToQuery(
			mocks.updateWhere.mock.calls[0]?.[0] as never,
		);
		expect(query.sql).toContain('"expiresAt"');
		expect(query.params[0]).toBe("pending");
	});
});

const pendingCheck = (
	checkId: string,
	overrides: Record<string, unknown> = {},
) => ({
	checkId,
	state: "pending",
	nextCheckAt: minutesAgo(1),
	expiresAt: new Date(NOW.getTime() + 60 * 60_000),
	...overrides,
});

describe("giving up on a build that never shows up", () => {
	beforeEach(() => {
		mocks.updateReturning = null;
	});

	it("expires only pending checks whose window has passed", async () => {
		mocks.checks = [
			pendingCheck("overdue", { expiresAt: minutesAgo(1) }),
			pendingCheck("closing-now", { expiresAt: NOW }),
			pendingCheck("in-window"),
			pendingCheck("already-notified", {
				state: "notified",
				expiresAt: minutesAgo(30),
			}),
			pendingCheck("settled", { state: "settled", expiresAt: minutesAgo(30) }),
		];

		await expect(createSnapvisorCheckStore().expireOverdue(NOW)).resolves.toBe(
			2,
		);

		expect(
			Object.fromEntries(mocks.checks.map((c) => [c.checkId, c.state])),
		).toEqual({
			overdue: "expired",
			"closing-now": "expired",
			"in-window": "pending",
			"already-notified": "notified",
			settled: "settled",
		});
	});

	it("never hands out a check past its window, even if it was not expired yet", async () => {
		mocks.checks = [
			pendingCheck("overdue-but-pending", { expiresAt: minutesAgo(1) }),
			pendingCheck("closing-now", { expiresAt: NOW }),
			pendingCheck("in-window"),
		];

		const due = await createSnapvisorCheckStore().listDue(NOW, 10);

		expect(due.map((c) => c.checkId)).toEqual(["in-window"]);
	});

	it("hands out only pending checks that are due, oldest first, up to the limit", async () => {
		mocks.checks = [
			pendingCheck("later", { nextCheckAt: minutesAgo(1) }),
			pendingCheck("oldest", { nextCheckAt: minutesAgo(30) }),
			pendingCheck("not-yet", {
				nextCheckAt: new Date(NOW.getTime() + 60_000),
			}),
			pendingCheck("notified", { state: "notified" }),
			pendingCheck("middle", { nextCheckAt: minutesAgo(10) }),
		];

		const store = createSnapvisorCheckStore();

		expect((await store.listDue(NOW, 10)).map((c) => c.checkId)).toEqual([
			"oldest",
			"middle",
			"later",
		]);
		expect((await store.listDue(NOW, 2)).map((c) => c.checkId)).toEqual([
			"oldest",
			"middle",
		]);
	});
});
