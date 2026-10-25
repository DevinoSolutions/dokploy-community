import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// findServiceOrganizations used to bind one placeholder per id and per service
// table (8 x N), which a Postgres statement caps at 65,535: about 8,000
// services. The id list is bound once, as one text[] parameter (T-8309).
const mocks = vi.hoisted(() => ({
	queries: [] as { sql: string; params: unknown[] }[],
	organizations: new Map<string, string>(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("@dokploy/server/db")>();
	const dialect = new PgDialect();
	return {
		...original,
		db: {
			execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
				const built = dialect.sqlToQuery(query);
				mocks.queries.push(built);
				const [ids] = built.params as string[][];
				return (ids ?? []).flatMap((serviceId) => {
					const organizationId = mocks.organizations.get(serviceId);
					return organizationId ? [{ serviceId, organizationId }] : [];
				});
			}),
		},
	};
});

const { findServiceOrganizations } = await import(
	"@dokploy/server/services/permission"
);

beforeEach(() => {
	mocks.queries.length = 0;
	mocks.organizations.clear();
});

describe("findServiceOrganizations", () => {
	it("asks the database nothing for an empty list", async () => {
		expect((await findServiceOrganizations([])).size).toBe(0);
		expect((await findServiceOrganizations(["", ""])).size).toBe(0);
		expect(mocks.queries).toEqual([]);
	});

	it("binds the ids once, as one text array, deduplicated", async () => {
		mocks.organizations.set("app-1", "org-a");
		mocks.organizations.set("pg-1", "org-b");
		const found = await findServiceOrganizations([
			"app-1",
			"pg-1",
			"app-1",
			"missing",
			"",
		]);
		expect(Object.fromEntries(found)).toEqual({
			"app-1": "org-a",
			"pg-1": "org-b",
		});
		expect(mocks.queries).toHaveLength(1);
		const [query] = mocks.queries;
		expect(query?.params).toEqual([["app-1", "pg-1", "missing"]]);
		expect(query?.sql).toContain("unnest($1::text[])");
		expect(query?.sql).not.toContain("$2");
		// every service table is still asked
		for (const table of [
			"application",
			"compose",
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"redis",
			"libsql",
		])
			expect(query?.sql).toContain(`FROM "${table}"`);
	});

	it("keeps one bind parameter for a list far past the old limit", async () => {
		const ids = Array.from({ length: 70_000 }, (_, i) => `service-${i}`);
		for (const id of ids.slice(0, 10_000)) mocks.organizations.set(id, "org-a");
		const found = await findServiceOrganizations(ids);
		expect(found.size).toBe(10_000);
		expect(mocks.queries).toHaveLength(1);
		expect(mocks.queries[0]?.params).toHaveLength(1);
		expect(mocks.queries[0]?.params[0]).toHaveLength(70_000);
	});
});
