import {
	applications,
	compose,
	postgres,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// checkDockerObjectServices (one object) hands its object to the batched
// checkDockerObjectsServices, so the ownership rule is written once (T-8309).
// The answers must stay what the one-object check used to give: the services
// behind the labels, every one on the server asked for, each passing
// checkServiceAccess(ctx, serviceId, "read"). `reference` below is that check
// as it was, run against the same rows. Only the database rows are scripted.
type Row = {
	appName: string;
	serviceId?: string;
	serverId?: string | null;
	applicationId?: string | null;
	composeId?: string | null;
};

const mocks = vi.hoisted(() => ({
	member: undefined as { role: string; accessedServices: string[] } | undefined,
	// table -> rows; a service row answers a lookup for its own appName
	rows: new Map<unknown, Row[]>(),
	// parent table -> id -> server
	parents: new Map<unknown, Map<string, string | null>>(),
	serviceOrganizations: new Map<string, string>(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("@dokploy/server/db")>();
	const dialect = new PgDialect();
	return {
		...original,
		db: {
			query: { member: { findFirst: vi.fn(async () => mocks.member) } },
			select: (fields: Record<string, unknown>) => ({
				from: (table: unknown) => ({
					where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
						const params = dialect.sqlToQuery(condition).params as string[];
						if ("parentId" in fields) {
							const parents = mocks.parents.get(table) ?? new Map();
							return params
								.filter((id) => parents.has(id))
								.map((id) => ({ parentId: id, serverId: parents.get(id) }));
						}
						return (mocks.rows.get(table) ?? []).filter((row) =>
							params.includes(row.appName),
						);
					},
				}),
			}),
			execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
				const ids = new Set(
					dialect.sqlToQuery(query).params.flat() as string[],
				);
				return [...ids].flatMap((serviceId) => {
					const organizationId = mocks.serviceOrganizations.get(serviceId);
					return organizationId ? [{ serviceId, organizationId }] : [];
				});
			}),
		},
	};
});

const { checkServiceAccess } = await import(
	"@dokploy/server/services/permission"
);
const { checkDockerObjectServices, checkDockerObjectsServices } = await import(
	"@/server/api/utils/container-service-access"
);
const { SERVICE_TABLES } = await import("@/server/wss/container-ownership");

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-a" },
} as never;

type Check = Awaited<ReturnType<typeof checkDockerObjectServices>>;

// the one-object check as it was before it delegated
const reference = async (
	appNames: string[],
	serverId?: string,
): Promise<Check> => {
	if (appNames.length === 0) return { outcome: "unowned" };
	const services: { serviceId: string; serverId: string | null }[] = [];
	for (const { table } of SERVICE_TABLES) {
		for (const row of mocks.rows.get(table) ?? []) {
			if (appNames.includes(row.appName) && row.serviceId)
				services.push({
					serviceId: row.serviceId,
					serverId: row.serverId ?? null,
				});
		}
	}
	for (const row of mocks.rows.get(previewDeployments) ?? []) {
		if (!appNames.includes(row.appName)) continue;
		for (const [parentId, table] of [
			[row.applicationId, applications],
			[row.composeId, compose],
		] as const) {
			const parents = mocks.parents.get(table);
			if (parentId && parents?.has(parentId))
				services.push({
					serviceId: parentId,
					serverId: parents.get(parentId) ?? null,
				});
		}
	}
	if (services.length === 0) return { outcome: "unowned" };
	for (const service of services) {
		if ((service.serverId ?? undefined) !== serverId)
			return { outcome: "refused" };
		try {
			await checkServiceAccess(ctx, service.serviceId, "read");
		} catch {
			return { outcome: "refused" };
		}
	}
	return {
		outcome: "readable",
		serviceIds: [...new Set(services.map((service) => service.serviceId))],
	};
};

// serviceIds are a set: compare them in one order
const normalized = (check: Check | undefined) =>
	check?.outcome === "readable"
		? { ...check, serviceIds: [...check.serviceIds].sort() }
		: check;

beforeEach(() => {
	mocks.rows = new Map<unknown, Row[]>([
		[
			applications,
			[
				{ appName: "app-a", serviceId: "app-a", serverId: null },
				{ appName: "app-a2", serviceId: "app-a2", serverId: null },
				{
					appName: "app-remote",
					serviceId: "app-remote",
					serverId: "server-a",
				},
				{ appName: "app-b", serviceId: "app-b", serverId: null },
			],
		],
		[compose, [{ appName: "cmp-a", serviceId: "cmp-a", serverId: null }]],
		[postgres, [{ appName: "pg-a", serviceId: "pg-a", serverId: "server-a" }]],
		[
			previewDeployments,
			[
				{ appName: "preview-a", applicationId: "app-a", composeId: null },
				{ appName: "preview-b", applicationId: "app-b", composeId: null },
				{ appName: "preview-cmp", applicationId: null, composeId: "cmp-a" },
				{ appName: "preview-gone", applicationId: "app-gone", composeId: null },
			],
		],
	]);
	mocks.parents = new Map<unknown, Map<string, string | null>>([
		[
			applications,
			new Map<string, string | null>([
				["app-a", null],
				["app-b", null],
			]),
		],
		[compose, new Map<string, string | null>([["cmp-a", null]])],
	]);
	mocks.serviceOrganizations = new Map([
		["app-a", "org-a"],
		["app-a2", "org-a"],
		["app-remote", "org-a"],
		["cmp-a", "org-a"],
		["pg-a", "org-a"],
		["app-b", "org-b"],
	]);
});

const objects: string[][] = [
	[],
	["nobody"],
	["app-a"],
	["app-a2"],
	["app-remote"],
	["pg-a"],
	["app-b"],
	["cmp-a"],
	["app-a", "cmp-a"],
	["cmp-a", "app-a"],
	["app-a", "app-b"],
	["app-a", "nobody"],
	["app-a", "app-remote"],
	["pg-a", "app-remote"],
	["preview-a"],
	["preview-b"],
	["preview-cmp"],
	["preview-gone"],
	["preview-a", "app-a"],
];

const members = {
	owner: { role: "owner", accessedServices: [] },
	admin: { role: "admin", accessedServices: [] },
	"member granted app-a and cmp-a": {
		role: "member",
		accessedServices: ["app-a", "cmp-a"],
	},
	"member granted the remote ones": {
		role: "member",
		accessedServices: ["app-remote", "pg-a"],
	},
	"member granted another organization's app": {
		role: "member",
		accessedServices: ["app-b"],
	},
	"member granted nothing": { role: "member", accessedServices: [] },
	"no member of the organization": undefined,
};

describe("checkDockerObjectServices", () => {
	for (const [who, member] of Object.entries(members)) {
		for (const serverId of [undefined, "server-a"]) {
			it(`gives the answers it gave before, for ${who}, on ${serverId ?? "the local host"}`, async () => {
				mocks.member = member;
				for (const appNames of objects) {
					const expected = normalized(await reference(appNames, serverId));
					const single = normalized(
						await checkDockerObjectServices(ctx, { appNames }, serverId),
					);
					expect({ appNames, check: single }).toEqual({
						appNames,
						check: expected,
					});
				}
				// and the batched check answers the whole list the same way
				const batched = await checkDockerObjectsServices(
					ctx,
					objects.map((appNames) => ({ appNames })),
					serverId,
				);
				for (const [index, appNames] of objects.entries()) {
					expect({ appNames, check: normalized(batched[index]) }).toEqual({
						appNames,
						check: normalized(await reference(appNames, serverId)),
					});
				}
			});
		}
	}

	it("covers every outcome in the matrix above", async () => {
		mocks.member = members["member granted app-a and cmp-a"];
		const outcomes = new Set<string>();
		for (const appNames of objects)
			outcomes.add((await reference(appNames)).outcome);
		expect([...outcomes].sort()).toEqual(["readable", "refused", "unowned"]);
	});
});
