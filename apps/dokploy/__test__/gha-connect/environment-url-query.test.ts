import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { harness, watchRow } from "./poll-harness";

const mocks = vi.hoisted(() => ({
	where: undefined as unknown,
	orderBy: undefined as unknown,
	rows: [] as Array<{ host: string; https: boolean; path: string | null }>,
}));

vi.mock("@dokploy/server", () => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	registerExternalBuild: vi.fn(),
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: (condition: unknown) => {
					mocks.where = condition;
					return {
						orderBy: (...order: unknown[]) => {
							mocks.orderBy = order;
							return Promise.resolve(mocks.rows);
						},
					};
				},
			}),
		}),
	},
}));
vi.mock("@dokploy/server/services/backup", () => ({ findBackupById: vi.fn() }));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));

const { createGhaConnectionPollDeps } = await import(
	"@/server/queues/gha-connection-deps"
);

const render = (value: unknown) =>
	new PgDialect().sqlToQuery(value as never).sql;

describe("the URL a release answers GitHub with", () => {
	const urlFor = async (serviceType: "application" | "compose") => {
		const deps = createGhaConnectionPollDeps(harness().deps);
		return deps.environmentUrl?.(watchRow({ serviceType }));
	};

	it("asks for the service's own domains, never a preview deployment's", async () => {
		mocks.rows = [{ host: "shop.example.com", https: true, path: "/" }];
		await urlFor("application");
		const sql = render(mocks.where);
		expect(sql).toContain('"applicationId"');
		expect(sql).toContain('"domainType" is null');
		expect(sql).toContain('"domainType" <>');
		await urlFor("compose");
		expect(render(mocks.where)).toContain('"composeId"');
	});

	it("orders the domains the same way on every tick", async () => {
		mocks.rows = [];
		await urlFor("compose");
		const order = (mocks.orderBy as unknown[]).map(render);
		expect(order).toEqual([
			'"domain"."createdAt" asc',
			'"domain"."uniqueConfigKey" asc',
		]);
	});

	it("answers with the first domain's URL", async () => {
		mocks.rows = [
			{ host: "first.example.com", https: true, path: "/" },
			{ host: "second.example.com", https: false, path: "/" },
		];
		expect(await urlFor("application")).toBe("https://first.example.com");
	});
});
