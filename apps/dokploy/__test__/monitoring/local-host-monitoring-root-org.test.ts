import { applications, compose } from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Dokploy host (an empty serverId) serves every organization of a
// self-hosted instance. Monitoring reads its metrics, its container breakdown,
// its health and its stats history, so only the organization that owns the
// instance gets them. The lists that name services (containers, events, swarm
// rows) keep working for every organization, but an owner or admin of another
// organization gets the rows of its own services only, like a member. A remote
// server stays with the organization it belongs to. Only the database rows,
// the docker commands and the services behind the routes are scripted; the
// permission and organization checks are the real ones.

const ROOT = "org-root";
const OTHER = "org-other";
const ROOT_SERVER = "root".padEnd(21, "x");
const OTHER_SERVER = "other".padEnd(21, "x");

const mocks = vi.hoisted(() => ({
	isCloud: false,
	rootOrganization: "org-root",
	member: { role: "admin", accessedServices: [] as string[] },
	// server id -> organization it belongs to
	servers: new Map<string, string>(),
	// service rows the appName lookup finds
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
	// swarm service name -> its spec labels, per host
	swarmServices: new Map<string, Map<string, Record<string, string>>>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	services: {} as Record<string, ReturnType<typeof vi.fn>>,
	isRootOrganization: vi.fn(),
}));

vi.mock("@dokploy/server", async (importOriginal) => {
	const original = await importOriginal<typeof import("@dokploy/server")>();
	for (const name of [
		"getAllContainerStats",
		"getApplicationInfo",
		"getApplicationStats",
		"getContainerProcesses",
		"getContainers",
		"getDockerEvents",
		"getNodeApplications",
		"getServerHealth",
	])
		mocks.services[name] = vi.fn(async () => []);
	return {
		...original,
		get IS_CLOUD() {
			return mocks.isCloud;
		},
		isRootOrganization: mocks.isRootOrganization,
		getAllContainerStats: mocks.services.getAllContainerStats,
		getApplicationInfo: mocks.services.getApplicationInfo,
		getApplicationStats: mocks.services.getApplicationStats,
		getContainerProcesses: mocks.services.getContainerProcesses,
		getContainers: mocks.services.getContainers,
		getDockerEvents: mocks.services.getDockerEvents,
		getNodeApplications: mocks.services.getNodeApplications,
		getServerHealth: mocks.services.getServerHealth,
	};
});

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

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	const run = async (command: string, serverId?: string) => {
		const host = serverId || "local";
		const containers = mocks.hosts.get(host) ?? new Map();
		if (command.startsWith("docker service inspect")) {
			const name = (command.trim().split(/\s+/).pop() ?? "").replace(/'/g, "");
			const labels = mocks.swarmServices.get(host)?.get(name);
			if (!labels) throw new Error("No such service");
			const id = Buffer.from(name).toString("hex").padEnd(25, "z").slice(0, 25);
			return { stdout: `${id} ${JSON.stringify(labels)} ${name}`, stderr: "" };
		}
		if (command.startsWith("docker inspect")) {
			// `docker inspect ... --format '<format>' <ref> [<ref>...]`
			const references = command
				.slice(command.indexOf("}}' ") + 4)
				.replace(/ 2>\/dev\/null \|\| true$/, "")
				.split(/\s+/)
				.map((word) => word.replace(/'/g, ""))
				.filter(Boolean);
			const lines: string[] = [];
			for (const reference of references) {
				const name = [...containers.keys()].find(
					(key) => key === reference || mocks.idOf(key).startsWith(reference),
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
		organizationId: mocks.servers.get(serverId),
		ipAddress: "203.0.113.10",
		metricsConfig: { server: { port: 4500, token: "remote-token" } },
	})),
	// the servers of the caller's organization
	getAccessibleServerIds: vi.fn(
		async ({ activeOrganizationId }: { activeOrganizationId: string }) =>
			new Set(
				[...mocks.servers]
					.filter(
						([, organizationId]) => organizationId === activeOrganizationId,
					)
					.map(([serverId]) => serverId),
			),
	),
}));

const fetchMock = vi.fn(async (_url: string) => ({
	ok: true,
	status: 200,
	statusText: "OK",
	json: async () => [{ timestamp: "now", cpu: "1" }],
}));
vi.stubGlobal("fetch", fetchMock);

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");

const callerIn = (organizationId: string, role = "admin") =>
	createCallerFactory(appRouter)({
		user: { id: "user-1", email: "u@example.com", role, ownerId: "o" },
		session: { activeOrganizationId: organizationId },
		req: { headers: {} },
		res: {},
	} as never);

type Caller = ReturnType<typeof callerIn>;

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

const swarm = (appName: string) => ({
	"com.docker.swarm.service.name": appName,
});

const host = (
	serverId: string,
	containers: Record<string, Record<string, string>>,
	swarmServices: string[] = [],
) => {
	mocks.hosts.set(serverId, new Map(Object.entries(containers)));
	mocks.swarmServices.set(
		serverId,
		new Map(swarmServices.map((name) => [name, swarm(name)])),
	);
};

const settle = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(e) => e,
	);

const shortId = (name: string) => mocks.idOf(name).slice(0, 12);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isCloud = false;
	mocks.member = { role: "admin", accessedServices: [] };
	mocks.serviceRows = [];
	mocks.serviceOrganizations.clear();
	mocks.hosts.clear();
	mocks.swarmServices.clear();
	mocks.servers = new Map([
		[ROOT_SERVER, ROOT],
		[OTHER_SERVER, OTHER],
	]);
	mocks.isRootOrganization.mockImplementation(
		async (organizationId: string) => organizationId === mocks.rootOrganization,
	);
	for (const fn of Object.values(mocks.services)) {
		fn.mockReset();
		fn.mockResolvedValue([]);
	}

	// the other organization has an application and a compose on the local host,
	// the root organization another application
	service(applications, "app-other", OTHER);
	service(compose, "cmp-other", OTHER);
	service(applications, "app-root", ROOT);
	host(
		"local",
		{
			"c-other": swarm("app-other-abc123"),
			"c-cmp-other": { "com.docker.compose.project": "cmp-other-abc123" },
			"c-root": swarm("app-root-abc123"),
			dokploy: swarm("dokploy"),
			"dokploy-traefik": {},
		},
		["app-other-abc123", "app-root-abc123", "dokploy"],
	);

	// each organization has a server of its own with one application and the
	// server's own container
	for (const [serverId, organizationId, id] of [
		[OTHER_SERVER, OTHER, "app-remote"],
		[ROOT_SERVER, ROOT, "app-remote-root"],
	] as const) {
		service(applications, id, organizationId, serverId);
		host(serverId, { "c-remote": swarm(`${id}-abc123`), "dokploy-x": {} }, [
			`${id}-abc123`,
			"dokploy-x",
		]);
	}
});

// Routes that read what only the host's organization may see: refused outright
// to an organization that does not own the instance.
const routes: [
	string,
	(c: Caller, serverId?: string) => Promise<unknown>,
	() => ReturnType<typeof vi.fn>,
	// whether the route works on Dokploy Cloud
	boolean,
][] = [
	[
		"server.getServerMetrics",
		(c, serverId) => c.server.getServerMetrics({ serverId, dataPoints: "50" }),
		() => fetchMock as unknown as ReturnType<typeof vi.fn>,
		true,
	],
	[
		"server.getContainerResourceStats",
		(c, serverId) => c.server.getContainerResourceStats({ serverId }),
		() => mocks.services.getAllContainerStats as ReturnType<typeof vi.fn>,
		false,
	],
	[
		"server.getContainerProcesses",
		(c, serverId) =>
			// a container of the caller's own, on the host asked about
			c.server.getContainerProcesses({
				containerId: serverId ? "c-remote" : "c-root",
				serverId,
			}),
		() => mocks.services.getContainerProcesses as ReturnType<typeof vi.fn>,
		false,
	],
	[
		"docker.getServerHealth",
		(c, serverId) => c.docker.getServerHealth({ serverId }),
		() => mocks.services.getServerHealth as ReturnType<typeof vi.fn>,
		true,
	],
	[
		"application.readAppMonitoring (the host's stats history)",
		(c, serverId) =>
			c.application.readAppMonitoring({
				appName: serverId ? `dokploy-${serverId}` : "dokploy",
			}),
		() => mocks.services.getApplicationStats as ReturnType<typeof vi.fn>,
		false,
	],
];

describe("the local host's monitoring belongs to the organization that owns the instance", () => {
	it.each(routes)(
		"%s refuses an organization that does not own the instance",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(OTHER)));

			expect(error).toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owns this Dokploy instance"),
			});
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s treats an empty serverId as the local host",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(OTHER), ""));

			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s refuses the owner of an organization that does not own the instance too",
		async (_name, run, effect) => {
			mocks.member = { role: "owner", accessedServices: [] };
			const error = await settle(run(callerIn(OTHER, "owner")));

			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s lets the organization that owns the instance through",
		async (_name, run, effect) => {
			expect(await settle(run(callerIn(ROOT)))).toBeNull();
			expect(effect()).toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s leaves a remote server of the caller's organization alone",
		async (_name, run, effect) => {
			expect(await settle(run(callerIn(OTHER), OTHER_SERVER))).toBeNull();
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			expect(effect()).toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s refuses a remote server of another organization",
		async (_name, run, effect) => {
			const error = await settle(run(callerIn(ROOT), OTHER_SERVER));

			expect(error).toMatchObject({ code: "UNAUTHORIZED" });
			expect(effect()).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s is unchanged on Dokploy Cloud",
		async (_name, run, effect, worksOnCloud) => {
			mocks.isCloud = true;

			const error = await settle(run(callerIn(OTHER), OTHER_SERVER));

			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
			if (worksOnCloud) {
				expect(error).toBeNull();
				expect(effect()).toHaveBeenCalled();
			} else {
				// the route is not offered on Cloud, for every organization
				expect(error).toMatchObject({ code: "UNAUTHORIZED" });
				expect(effect()).not.toHaveBeenCalled();
			}
		},
	);

	it("application.readAppMonitoring still reads the stats of the caller's own service", async () => {
		expect(
			await settle(
				callerIn(OTHER).application.readAppMonitoring({
					appName: "app-other-abc123",
				}),
			),
		).toBeNull();
		expect(mocks.services.getApplicationStats).toHaveBeenCalledWith(
			"app-other-abc123",
		);
	});

	it("application.readAppMonitoring refuses the stats of another organization's service", async () => {
		const error = await settle(
			callerIn(OTHER).application.readAppMonitoring({
				appName: "app-root-abc123",
			}),
		);

		expect(error).toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.services.getApplicationStats).not.toHaveBeenCalled();
	});

	it("application.readAppMonitoring refuses the stats of a name that backs no service", async () => {
		const error = await settle(
			callerIn(OTHER).application.readAppMonitoring({
				appName: "dokploy-traefik",
			}),
		);

		expect(error).toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.services.getApplicationStats).not.toHaveBeenCalled();
	});

	it("application.readAppMonitoring gives the organization that owns the instance the stats of a name that backs no service", async () => {
		expect(
			await settle(
				callerIn(ROOT).application.readAppMonitoring({
					appName: "dokploy-traefik",
				}),
			),
		).toBeNull();
		expect(mocks.services.getApplicationStats).toHaveBeenCalledWith(
			"dokploy-traefik",
		);
	});
});

// Routes that list rows: they keep working for every organization, and an
// owner or admin of an organization that does not own the instance gets the
// rows of its own services on the local host, not the host's own and not
// another organization's. The rows the scripted services return follow the
// host that is asked about.
describe("lists on the local host give another organization its own services' rows only", () => {
	const containerNames = (serverId?: string) => [
		...(mocks.hosts.get(serverId || "local")?.keys() ?? []),
	];

	const lists: [
		string,
		(c: Caller, serverId?: string) => Promise<string[]>,
		// what an admin of the other organization sees on the local host
		string[],
		// what an admin of the organization that owns the instance sees
		string[],
		// what the admin of a remote server's organization sees on that server
		string[],
	][] = [
		[
			"docker.getContainers",
			async (c, serverId) => {
				mocks.services.getContainers?.mockResolvedValue(
					containerNames(serverId).map((name) => ({
						containerId: shortId(name),
						name,
					})),
				);
				const rows = await c.docker.getContainers({ serverId });
				return (rows ?? []).map((row) => row.name);
			},
			["c-other", "c-cmp-other"],
			// the Docker page lists everything on the host
			["c-other", "c-cmp-other", "c-root", "dokploy", "dokploy-traefik"],
			["c-remote", "dokploy-x"],
		],
		[
			"swarm.getContainerStats",
			async (c, serverId) => {
				mocks.services.getAllContainerStats?.mockResolvedValue(
					containerNames(serverId).map((name) => ({
						ID: shortId(name),
						Name: name,
					})),
				);
				const rows = await c.swarm.getContainerStats({ serverId });
				return (rows ?? []).map((row) => row.Name);
			},
			["c-other", "c-cmp-other"],
			// its own services and the host's own, not another organization's
			["c-root", "dokploy", "dokploy-traefik"],
			["c-remote", "dokploy-x"],
		],
		[
			"docker.getEvents",
			async (c, serverId) => {
				mocks.services.getDockerEvents?.mockResolvedValue({
					events: [
						...containerNames(serverId).map((name) => ({
							Type: "container",
							Actor: {
								Attributes: {
									...mocks.hosts.get(serverId || "local")?.get(name),
								},
							},
						})),
						{ Type: "network", Actor: { Attributes: { name: "bridge" } } },
					],
				});
				const { events } = await c.docker.getEvents({ serverId });
				return events.map(
					(event) =>
						(event.Actor?.Attributes?.["com.docker.swarm.service.name"] ??
							event.Actor?.Attributes?.["com.docker.compose.project"]) ||
						event.Type,
				);
			},
			["app-other-abc123", "cmp-other-abc123"],
			[
				"app-other-abc123",
				"cmp-other-abc123",
				"app-root-abc123",
				"dokploy",
				"container",
				"network",
			],
			["app-remote-abc123", "container", "network"],
		],
		[
			"swarm.getNodeApps",
			async (c, serverId) => {
				mocks.services.getNodeApplications?.mockResolvedValue(
					[...(mocks.swarmServices.get(serverId || "local")?.keys() ?? [])].map(
						(Name) => ({ Name }),
					),
				);
				const rows = await c.swarm.getNodeApps({ serverId });
				return (rows ?? []).map((row) => row.Name);
			},
			["app-other-abc123"],
			["app-other-abc123", "app-root-abc123", "dokploy"],
			["app-remote-abc123", "dokploy-x"],
		],
	];

	const sorted = (rows: string[]) => [...rows].sort();

	it.each(lists)(
		"%s gives an admin of another organization its own rows on the local host",
		async (_name, run, own) => {
			expect(sorted(await run(callerIn(OTHER)))).toEqual(sorted(own));
		},
	);

	it.each(lists)(
		"%s never gives the host's own rows or another organization's for an empty serverId",
		async (_name, run, own) => {
			// the services are looked up on the server named, and "" is none: at
			// most the caller's own rows come back, never the host's
			expect(own).toEqual(
				expect.arrayContaining(await run(callerIn(OTHER), "")),
			);
		},
	);

	it.each(lists)(
		"%s gives an owner of another organization its own rows on the local host",
		async (_name, run, own) => {
			mocks.member = { role: "owner", accessedServices: [] };

			expect(sorted(await run(callerIn(OTHER, "owner")))).toEqual(sorted(own));
		},
	);

	it.each(lists)(
		"%s gives the organization that owns the instance the host's rows",
		async (_name, run, _own, root) => {
			expect(sorted(await run(callerIn(ROOT)))).toEqual(sorted(root));
		},
	);

	it.each(lists)(
		"%s leaves a remote server of the caller's organization unfiltered",
		async (_name, run, _own, _root, remote) => {
			// the server's own container next to the organization's application
			expect(sorted(await run(callerIn(OTHER), OTHER_SERVER))).toEqual(
				sorted(remote),
			);
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
		},
	);

	it.each(lists)(
		"%s refuses a remote server of another organization",
		async (_name, run) => {
			const error = await settle(run(callerIn(ROOT), OTHER_SERVER));

			expect(error).toMatchObject({ code: "UNAUTHORIZED" });
		},
	);

	it.each(lists)(
		"%s is unchanged on Dokploy Cloud",
		async (_name, run, _own, _root, remote) => {
			mocks.isCloud = true;

			expect(sorted(await run(callerIn(OTHER), OTHER_SERVER))).toEqual(
				sorted(remote),
			);
			expect(mocks.isRootOrganization).not.toHaveBeenCalled();
		},
	);

	it("swarm.getAppInfos asks only about the services of an admin of another organization", async () => {
		await callerIn(OTHER).swarm.getAppInfos({
			appName: ["app-other-abc123", "app-root-abc123", "dokploy"],
		});

		expect(mocks.services.getApplicationInfo).toHaveBeenCalledWith(
			["app-other-abc123"],
			undefined,
		);
	});

	it("swarm.getAppInfos asks about every name for the organization that owns the instance", async () => {
		await callerIn(ROOT).swarm.getAppInfos({
			appName: ["app-other-abc123", "app-root-abc123", "dokploy"],
		});

		expect(mocks.services.getApplicationInfo).toHaveBeenCalledWith(
			["app-other-abc123", "app-root-abc123", "dokploy"],
			undefined,
		);
	});

	it("swarm.getAppInfos asks about every name on a remote server of the caller's organization", async () => {
		await callerIn(OTHER).swarm.getAppInfos({
			appName: ["app-remote-abc123", "dokploy-x"],
			serverId: OTHER_SERVER,
		});

		expect(mocks.services.getApplicationInfo).toHaveBeenCalledWith(
			["app-remote-abc123", "dokploy-x"],
			OTHER_SERVER,
		);
		expect(mocks.isRootOrganization).not.toHaveBeenCalled();
	});
});
