import { applications, compose } from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// server.getContainerResourceStats runs `docker stats` on a host that several
// organizations can share. Everybody gets the containers of services they can
// read on that server; the host's own containers (Dokploy, its database,
// Traefik, an unlabelled one) only an owner or admin (T-7031). Only the
// database rows and the docker commands are scripted; the permission and
// organization checks are the real ones.
const mocks = vi.hoisted(() => ({
	member: { role: "member", accessedServices: [] as string[] },
	// service rows the appName lookup finds, per table
	serviceRows: [] as {
		table: unknown;
		serviceId: string;
		serverId: string | null;
		appName: string;
	}[],
	// service id -> organization it lives in
	serviceOrganizations: new Map<string, string>(),
	// container name -> its labels, per host ("local" or a server id)
	hosts: new Map<string, Map<string, Record<string, string>>>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	commands: [] as { serverId?: string; command: string }[],
	// servers the caller was granted
	servers: new Set<string>(),
	// database round trips, to show they do not grow with the containers
	queries: 0,
}));

vi.mock("@dokploy/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("@dokploy/server/db")>();
	const dialect = new PgDialect();
	return {
		...original,
		db: {
			query: {
				member: {
					findFirst: vi.fn(async () => {
						mocks.queries++;
						return mocks.member;
					}),
				},
			},
			select: (fields: Record<string, unknown>) => ({
				from: (table: unknown) => ({
					where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
						mocks.queries++;
						// no preview deployments in these tests
						if (!("serviceId" in fields)) return [];
						// a row only answers a lookup for its own appName
						const { params } = dialect.sqlToQuery(condition);
						return mocks.serviceRows
							.filter(
								(row) => row.table === table && params.includes(row.appName),
							)
							.map(({ serviceId, serverId, appName }) => ({
								serviceId,
								serverId,
								appName,
							}));
					},
				}),
			}),
			// the organization of one service id (findServiceOrganizationId) or of
			// a batch of them (findServiceOrganizations), one row per known id
			execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
				mocks.queries++;
				const ids = new Set(dialect.sqlToQuery(query).params as string[]);
				return [...ids].flatMap((serviceId) => {
					const organizationId = mocks.serviceOrganizations.get(serviceId);
					return organizationId ? [{ serviceId, organizationId }] : [];
				});
			}),
		},
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	const run = async (command: string, serverId?: string) => {
		mocks.commands.push({ serverId, command });
		const containers = mocks.hosts.get(serverId ?? "local") ?? new Map();
		const shortId = (name: string) => mocks.idOf(name).slice(0, 12);
		if (command.startsWith("docker stats")) {
			const lines = [...containers.keys()].map((name) =>
				JSON.stringify({
					BlockIO: "0B / 0B",
					CPUPerc: "1.00%",
					Container: shortId(name),
					ID: shortId(name),
					MemPerc: "1.00%",
					MemUsage: "10MiB / 1GiB",
					Name: name,
					NetIO: "0B / 0B",
				}),
			);
			return { stdout: lines.join("\n"), stderr: "" };
		}
		if (command.startsWith("docker ps --size")) {
			const lines = [...containers.keys()].map((name) =>
				JSON.stringify({ ID: shortId(name), Name: name, Size: "1MB" }),
			);
			return { stdout: lines.join("\n"), stderr: "" };
		}
		if (command.startsWith("docker inspect")) {
			const references = command
				.slice(command.indexOf("}}' ") + 4)
				.replace(/ 2>\/dev\/null \|\| true$/, "")
				.split(/\s+/)
				.map((word) => word.replace(/'/g, ""))
				.filter(Boolean);
			const lines: string[] = [];
			for (const reference of references) {
				const name = [...containers.keys()].find((key) =>
					mocks.idOf(key).startsWith(reference),
				);
				if (name)
					lines.push(
						`${mocks.idOf(name)} ${JSON.stringify(containers.get(name))}`,
					);
			}
			return { stdout: lines.join("\n"), stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};
	return {
		...original,
		execAsync: vi.fn((command: string) => run(command)),
		execAsyncRemote: vi.fn((serverId: string, command: string) =>
			run(command, serverId),
		),
	};
});

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => false),
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/services/server")>()),
	findServerById: vi.fn(async (serverId: string) => ({
		serverId,
		organizationId: serverId === "server-b" ? "org-b" : "org-a",
	})),
	getAccessibleServerIds: vi.fn(async () => mocks.servers),
}));

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "u@example.com", role: "member", ownerId: "o" },
	session: { activeOrganizationId: "org-a" },
	req: { headers: {} },
	res: {},
} as never);

type Role = "owner" | "admin" | "member";

const as = (role: Role, accessedServices: string[] = []) => {
	mocks.member = { role, accessedServices };
};

const service = (
	table: unknown,
	serviceId: string,
	organizationId: string,
	serverId: string | null = null,
) => {
	mocks.serviceRows.push({
		table,
		serviceId,
		serverId,
		appName: `${serviceId}-abc123`,
	});
	mocks.serviceOrganizations.set(serviceId, organizationId);
};

const host = (
	serverId: string,
	containers: Record<string, Record<string, string>>,
) => mocks.hosts.set(serverId, new Map(Object.entries(containers)));

const swarm = (appName: string) => ({
	"com.docker.swarm.service.name": appName,
});

const names = (rows: { Name: string }[]) => rows.map((row) => row.Name).sort();

const systemContainers = {
	dokploy: swarm("dokploy"),
	"dokploy-postgres": swarm("dokploy-postgres"),
	"dokploy-redis": swarm("dokploy-redis"),
	"dokploy-traefik": {},
};

beforeEach(() => {
	as("member");
	mocks.serviceRows = [];
	mocks.serviceOrganizations.clear();
	mocks.hosts.clear();
	mocks.commands.length = 0;
	mocks.servers = new Set(["server-a"]);
	mocks.queries = 0;

	// org-a: app-a and app-a2 and cmp-a; org-b: app-b, all on the local host
	service(applications, "app-a", "org-a");
	service(applications, "app-a2", "org-a");
	service(compose, "cmp-a", "org-a");
	service(applications, "app-b", "org-b");
	host("local", {
		"c-a": swarm("app-a-abc123"),
		"c-a2": swarm("app-a2-abc123"),
		"c-cmp": { "com.docker.compose.project": "cmp-a-abc123" },
		"c-b": swarm("app-b-abc123"),
		...systemContainers,
	});
});

describe("server.getContainerResourceStats", () => {
	it("gives a member only the containers of the services they were granted", async () => {
		as("member", ["app-a", "cmp-a"]);
		const stats = await caller.server.getContainerResourceStats();
		expect(names(stats)).toEqual(["c-a", "c-cmp"]);
		// the size column still comes through for the rows that stay
		expect(stats[0]?.Size).toBe("1MB");
	});

	it("gives a member without grants an empty list", async () => {
		as("member");
		expect(await caller.server.getContainerResourceStats()).toEqual([]);
	});

	it.each(["owner", "admin"] as const)(
		"gives an %s the organization's containers and the host's own, not another organization's",
		async (role) => {
			as(role);
			expect(names(await caller.server.getContainerResourceStats())).toEqual([
				"c-a",
				"c-a2",
				"c-cmp",
				"dokploy",
				"dokploy-postgres",
				"dokploy-redis",
				"dokploy-traefik",
			]);
		},
	);

	it("hides a container whose labels name a service of another organization next to one of the caller's", async () => {
		as("owner");
		host("local", {
			"c-mixed": {
				...swarm("app-a-abc123"),
				"com.docker.compose.project": "app-b-abc123",
			},
		});
		expect(await caller.server.getContainerResourceStats()).toEqual([]);
	});

	it("refuses another organization's serverId before running anything", async () => {
		for (const role of ["owner", "member"] as const) {
			as(role, ["app-a"]);
			await expect(
				caller.server.getContainerResourceStats({ serverId: "server-b" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		}
		expect(mocks.commands).toHaveLength(0);
	});

	it("reads a remote server over ssh and scopes it like the local host", async () => {
		service(applications, "app-r", "org-a", "server-a");
		service(applications, "app-r2", "org-a", "server-a");
		service(applications, "app-rb", "org-b", "server-a");
		host("server-a", {
			"c-r": swarm("app-r-abc123"),
			"c-r2": swarm("app-r2-abc123"),
			"c-rb": swarm("app-rb-abc123"),
			// a local service's container name seen on the remote host
			"c-a": swarm("app-a-abc123"),
			...systemContainers,
		});

		as("member", ["app-r", "app-a"]);
		expect(
			names(
				await caller.server.getContainerResourceStats({ serverId: "server-a" }),
			),
		).toEqual(["c-r"]);
		expect(mocks.commands.every((entry) => entry.serverId === "server-a")).toBe(
			true,
		);

		as("owner");
		expect(
			names(
				await caller.server.getContainerResourceStats({ serverId: "server-a" }),
			),
		).toEqual([
			"c-r",
			"c-r2",
			"dokploy",
			"dokploy-postgres",
			"dokploy-redis",
			"dokploy-traefik",
		]);
	});

	it("refuses a member a server of the organization they were not granted, before running anything", async () => {
		service(applications, "app-r", "org-a", "server-a");
		host("server-a", { "c-r": swarm("app-r-abc123") });
		mocks.servers = new Set(["server-c"]);
		as("member", ["app-r"]);
		await expect(
			caller.server.getContainerResourceStats({ serverId: "server-a" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.commands).toHaveLength(0);
	});

	it.each(["member", "owner"] as const)(
		"makes as many database queries for 30 containers as for 3, for a %s",
		async (role) => {
			const queriesFor = async (count: number) => {
				mocks.serviceRows = [];
				mocks.serviceOrganizations.clear();
				const containers: Record<string, Record<string, string>> = {
					...systemContainers,
				};
				const granted: string[] = [];
				for (let i = 0; i < count; i++) {
					const organization = i % 3 === 0 ? "org-b" : "org-a";
					service(i % 2 ? compose : applications, `svc-${i}`, organization);
					containers[`c-${i}`] = swarm(`svc-${i}-abc123`);
					// a second replica of the same service
					containers[`c-${i}-2`] = swarm(`svc-${i}-abc123`);
					if (i % 2) granted.push(`svc-${i}`);
				}
				host("local", containers);
				as(role, granted);
				mocks.queries = 0;
				const stats = await caller.server.getContainerResourceStats();
				return { queries: mocks.queries, rows: stats.length };
			};

			const small = await queriesFor(3);
			const large = await queriesFor(30);
			expect(large.rows).toBeGreaterThan(small.rows);
			expect(large.queries).toBe(small.queries);
			expect(large.queries).toBeLessThanOrEqual(16);
		},
	);

	it("does not show a remote service's containers on the local host", async () => {
		service(applications, "app-r", "org-a", "server-a");
		host("local", { "c-r": swarm("app-r-abc123") });
		as("owner");
		expect(await caller.server.getContainerResourceStats()).toEqual([]);
	});
});
