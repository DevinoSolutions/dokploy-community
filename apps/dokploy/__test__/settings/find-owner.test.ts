import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// findOwner is the owner of the root organization, or the oldest owner when
// there is none.

const mocks = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	memberFindFirst: vi.fn(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		query: {
			organization: { findFirst: mocks.orgFindFirst },
			member: { findFirst: mocks.memberFindFirst },
		},
	},
}));

import { findOwner } from "@dokploy/server/services/admin";

type Row = { id: string; organizationId: string; role: string };

const dialect = new PgDialect();

// Two organizations, each with an owner; the second one's owner is older, so
// an unordered lookup (or one ordered by member) could return it.
const OWNERS: Row[] = [
	{ id: "m-b", organizationId: "org-b", role: "owner" },
	{ id: "m-a", organizationId: "org-a", role: "owner" },
];

// The member query: filtered by the params of its where clause. `rows` is in
// created_at order, so the first match is what the ordered query returns.
const members = (rows: Row[]) =>
	mocks.memberFindFirst.mockImplementation(
		async (query: {
			where: Parameters<PgDialect["sqlToQuery"]>[0];
			orderBy?: unknown;
		}) => {
			const { params } = dialect.sqlToQuery(query.where);
			const matching = rows.filter(
				(row) =>
					params.includes(row.role) &&
					(params.length === 1 || params.includes(row.organizationId)),
			);
			return matching[0] ? { ...matching[0], user: { id: "u" } } : undefined;
		},
	);

const organizations = (id: string | null) =>
	mocks.orgFindFirst.mockResolvedValue(id ? { id, name: id } : undefined);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("findOwner", () => {
	it("is the owner of the root organization on a multi-organization instance", async () => {
		organizations("org-a");
		members(OWNERS);

		await expect(findOwner()).resolves.toMatchObject({
			id: "m-a",
			organizationId: "org-a",
			user: { id: "u" },
		});
	});

	it("orders both lookups by creation, then id", async () => {
		const ordered = async (call: number) => {
			const [query] = mocks.memberFindFirst.mock.calls[call] as [
				{ orderBy: (m: unknown, o: unknown) => unknown[] },
			];
			const asc = vi.fn((column: unknown) => column);
			query.orderBy({ createdAt: "createdAt", id: "id" }, { asc });
			return asc.mock.calls.map(([column]) => column);
		};
		organizations("org-empty");
		members(OWNERS);

		await findOwner();

		expect(await ordered(0)).toEqual(["createdAt", "id"]);
		expect(await ordered(1)).toEqual(["createdAt", "id"]);
	});

	it("falls back to the oldest owner when there is no root organization", async () => {
		organizations(null);
		members(OWNERS);

		await expect(findOwner()).resolves.toMatchObject({ id: "m-b" });
		expect(mocks.memberFindFirst).toHaveBeenCalledTimes(1);
	});

	it("falls back to the oldest owner when the root organization has none", async () => {
		organizations("org-empty");
		members(OWNERS);

		await expect(findOwner()).resolves.toMatchObject({ id: "m-b" });
		expect(mocks.memberFindFirst).toHaveBeenCalledTimes(2);
	});

	it("answers NOT_FOUND when there is no owner at all", async () => {
		organizations(null);
		members([]);

		await expect(findOwner()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Admin not found",
		});
	});
});
