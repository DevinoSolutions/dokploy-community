import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cancel trail is pruned after DEPLOYMENT_CANCEL_AUDIT_RETENTION_DAYS, and
 * deleting a user clears their email from the trail while keeping the user id.
 */

const mocks = vi.hoisted(() => ({
	deleteWhere: null as unknown,
	deleted: [] as { id: string }[],
	updateSet: null as unknown,
	updateWhere: null as unknown,
	txUpdates: 0,
	txDeletes: 0,
	order: [] as string[],
}));

vi.mock("@dokploy/server/db", () => {
	const executor = {
		delete: () => ({
			where: (condition: unknown) => {
				mocks.deleteWhere = condition;
				mocks.txDeletes++;
				mocks.order.push("delete");
				const result = Promise.resolve(mocks.deleted) as Promise<unknown> & {
					returning: () => Promise<unknown>;
				};
				result.returning = async () => mocks.deleted;
				return result;
			},
		}),
		update: () => ({
			set: (values: unknown) => {
				mocks.updateSet = values;
				return {
					where: async (condition: unknown) => {
						mocks.updateWhere = condition;
						mocks.txUpdates++;
						mocks.order.push("update");
					},
				};
			},
		}),
		select: () => ({ from: () => ({ where: async () => [] }) }),
	};
	return {
		db: {
			...executor,
			transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(executor)),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/services/notification-channels", () => ({
	removeOrganizationNotifications: vi.fn(),
}));

const {
	DEPLOYMENT_CANCEL_AUDIT_RETENTION_DAYS,
	pruneDeploymentCancelAudit,
	scrubDeploymentCancelAuditActorEmail,
} = await import("@dokploy/server/services/deployment-cancel-audit");
const { removeUserById } = await import("@dokploy/server/services/admin");

const dialect = new PgDialect();
const render = (node: unknown) =>
	dialect.sqlToQuery(node as Parameters<PgDialect["sqlToQuery"]>[0]);

beforeEach(() => {
	mocks.deleteWhere = null;
	mocks.deleted = [];
	mocks.updateSet = null;
	mocks.updateWhere = null;
	mocks.txUpdates = 0;
	mocks.txDeletes = 0;
	mocks.order = [];
});

describe("pruneDeploymentCancelAudit", () => {
	it("keeps 180 days", () => {
		expect(DEPLOYMENT_CANCEL_AUDIT_RETENTION_DAYS).toBe(180);
	});

	it("deletes entries created before the cutoff and reports the count", async () => {
		mocks.deleted = [{ id: "a" }, { id: "b" }];
		const now = new Date("2026-10-19T00:00:00.000Z");
		const count = await pruneDeploymentCancelAudit(now);

		expect(count).toBe(2);
		const { sql, params } = render(mocks.deleteWhere);
		expect(sql).toContain('"createdAt" <');
		const cutoff = params[0] as Date | string;
		expect(new Date(cutoff).toISOString()).toBe(
			new Date(now.getTime() - 180 * 86_400_000).toISOString(),
		);
	});
});

describe("scrubDeploymentCancelAuditActorEmail", () => {
	it("nulls only the email of the entries of that user", async () => {
		await scrubDeploymentCancelAuditActorEmail("user-1");

		expect(mocks.updateSet).toEqual({ actorEmail: null });
		const { sql, params } = render(mocks.updateWhere);
		expect(sql).toContain('"actorId" =');
		expect(params).toEqual(["user-1"]);
	});
});

describe("removeUserById", () => {
	it("scrubs the trail email inside the transaction, before the user row goes", async () => {
		await removeUserById("user-1");

		expect(mocks.txUpdates).toBe(1);
		expect(mocks.order).toEqual(["update", "delete"]);
		expect(mocks.updateSet).toEqual({ actorEmail: null });
	});
});
