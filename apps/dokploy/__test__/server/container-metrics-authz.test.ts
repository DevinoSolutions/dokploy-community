import { applications, compose, postgres } from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// user.getContainerMetrics sends the monitoring agent a container name the
// client picked, and the agent answers every container on the host named that
// name or starting with it and a dot (an SQL LIKE, "_" matching any character).
// The host can be shared by several organizations, so the name must be one the
// caller can read on that server, and only the rows of what was checked come
// back (T-8309). Only the database rows, the docker commands and the agent are
// scripted; the permission and organization checks are the real ones.
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
	// per host ("local" or a server id): container name -> labels
	containers: new Map<string, Map<string, Record<string, string>>>(),
	// per host: swarm service name -> spec labels
	swarmServices: new Map<string, Map<string, Record<string, string>>>(),
	// per host: the container names the agent holds metrics for
	metrics: new Map<string, string[]>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	commands: [] as { serverId?: string; command: string }[],
	// servers the caller was granted
	servers: new Set<string>(),
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
		mocks.commands.push({ serverId, command });
		const host = serverId ?? "local";
		const reference = (command.trim().split(/\s+/).pop() ?? "").replace(
			/'/g,
			"",
		);
		if (command.startsWith("docker service inspect")) {
			const labels = mocks.swarmServices.get(host)?.get(reference);
			if (!labels) throw new Error("No such service");
			const id = Buffer.from(reference)
				.toString("hex")
				.padEnd(25, "z")
				.slice(0, 25);
			return {
				stdout: `${id} ${JSON.stringify(labels)} ${reference}`,
				stderr: "",
			};
		}
		if (command.startsWith("docker inspect --type container")) {
			const labels = mocks.containers.get(host)?.get(reference);
			if (!labels) throw new Error("No such container");
			return {
				stdout: `/${reference} ${mocks.idOf(reference)} ${JSON.stringify(labels)}`,
				stderr: "",
			};
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
		ipAddress: "203.0.113.10",
		metricsConfig: { server: { port: 4500, token: "remote-token" } },
	})),
	getAccessibleServerIds: vi.fn(async () => mocks.servers),
}));

// The agent: `container_name = ? OR container_name LIKE ? || '.%'`
const like = (pattern: string) =>
	new RegExp(
		`^${pattern
			.split("")
			.map((char) =>
				char === "%"
					? ".*"
					: char === "_"
						? "."
						: char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("")}$`,
	);

const fetchMock = vi.fn(async (input: string) => {
	const url = new URL(input);
	const host = url.hostname === "localhost" ? "local" : "server-a";
	const appName = url.searchParams.get("appName") ?? "";
	const rows = (mocks.metrics.get(host) ?? [])
		.filter((name) => name === appName || like(`${appName}.%`).test(name))
		.map((name) => ({ timestamp: "now", CPU: 1, ID: name, Name: name }));
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => rows,
	};
});
vi.stubGlobal("fetch", fetchMock);

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
	name: string,
	setup: {
		containers?: Record<string, Record<string, string>>;
		swarmServices?: Record<string, Record<string, string>>;
	},
) => {
	mocks.containers.set(name, new Map(Object.entries(setup.containers ?? {})));
	mocks.swarmServices.set(
		name,
		new Map(Object.entries(setup.swarmServices ?? {})),
	);
	mocks.metrics.set(name, Object.keys(setup.containers ?? {}));
};

const metrics = (appName: string, serverId?: string) =>
	caller.user.getContainerMetrics({ appName, serverId, dataPoints: "50" });

const names = (rows: unknown[]) =>
	rows.map((row) => (row as { Name: string }).Name).sort();

const notFound = { code: "NOT_FOUND" };

const swarmTask = (appName: string) => ({
	"com.docker.swarm.service.name": appName,
});

beforeEach(() => {
	as("member");
	mocks.serviceRows = [];
	mocks.serviceOrganizations.clear();
	mocks.containers.clear();
	mocks.swarmServices.clear();
	mocks.metrics.clear();
	mocks.commands.length = 0;
	mocks.servers = new Set(["server-a"]);
	fetchMock.mockClear();

	// org-a: app-a, pg-a, cmp-a (docker compose), stk-a (stack); org-b: app-b
	// and cmp-b. All on the local host, which they share.
	service(applications, "app-a", "org-a");
	service(postgres, "pg-a", "org-a");
	service(compose, "cmp-a", "org-a");
	service(compose, "stk-a", "org-a");
	service(applications, "app-b", "org-b");
	service(compose, "cmp-b", "org-b");
	service(compose, "stk-b", "org-b");
	host("local", {
		swarmServices: {
			"app-a-abc123": {},
			"pg-a-abc123": {},
			"stk-a-abc123_web": { "com.docker.stack.namespace": "stk-a-abc123" },
			"app-b-abc123": {},
			"stk-b-abc123_web": { "com.docker.stack.namespace": "stk-b-abc123" },
			dokploy: {},
		},
		containers: {
			"app-a-abc123.1.aaaaaaaaaaaaaaaaaaaaaaaaa": swarmTask("app-a-abc123"),
			"pg-a-abc123.1.ppppppppppppppppppppppppp": swarmTask("pg-a-abc123"),
			"cmp-a-abc123-web-1": { "com.docker.compose.project": "cmp-a-abc123" },
			"stk-a-abc123_web.1.sssssssssssssssssssssssss": {
				...swarmTask("stk-a-abc123_web"),
				"com.docker.stack.namespace": "stk-a-abc123",
			},
			"app-b-abc123.1.bbbbbbbbbbbbbbbbbbbbbbbbb": swarmTask("app-b-abc123"),
			"cmp-b-abc123-web-1": { "com.docker.compose.project": "cmp-b-abc123" },
			"stk-b-abc123_web.1.ttttttttttttttttttttttttt": {
				...swarmTask("stk-b-abc123_web"),
				"com.docker.stack.namespace": "stk-b-abc123",
			},
			"dokploy.1.ddddddddddddddddddddddddd": swarmTask("dokploy"),
			"dokploy-traefik": {},
		},
	});
});

describe("user.getContainerMetrics: the names the UI sends", () => {
	// the application and database pages send the service's appName; the
	// compose page sends the name of one container of the compose, as listed by
	// docker.getContainersByAppNameMatch ("<project>-<service>-<n>" for docker
	// compose, "<stack>_<service>.<slot>.<task id>" for a stack)
	const uiNames = [
		[
			"an application's appName",
			"app-a",
			"app-a-abc123",
			"app-a-abc123.1.aaaaaaaaaaaaaaaaaaaaaaaaa",
		],
		[
			"a database's appName",
			"pg-a",
			"pg-a-abc123",
			"pg-a-abc123.1.ppppppppppppppppppppppppp",
		],
		[
			"a docker compose container",
			"cmp-a",
			"cmp-a-abc123-web-1",
			"cmp-a-abc123-web-1",
		],
		[
			"a stack task container",
			"stk-a",
			"stk-a-abc123_web.1.sssssssssssssssssssssssss",
			"stk-a-abc123_web.1.sssssssssssssssssssssssss",
		],
	] as const;

	it.each(uiNames)(
		"keeps %s working for a member granted the service",
		async (_, serviceId, appName, container) => {
			as("member", [serviceId]);
			expect(names(await metrics(appName))).toEqual([container]);
			expect(fetchMock).toHaveBeenCalledWith(
				`http://localhost:3001/metrics/containers?limit=50&appName=${appName}`,
				{ headers: { Authorization: "Bearer metrics" } },
			);
		},
	);

	it.each(["owner", "admin"] as const)(
		"keeps every UI name working for an %s",
		async (role) => {
			as(role);
			for (const [, , appName, container] of uiNames) {
				expect(names(await metrics(appName))).toEqual([container]);
			}
		},
	);

	it.each(uiNames)(
		"refuses %s to a member not granted the service, without asking the agent",
		async (_, serviceId, appName) => {
			as("member", serviceId === "app-a" ? ["pg-a"] : ["app-a"]);
			await expect(metrics(appName)).rejects.toMatchObject(notFound);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("asks the server's own agent for a service on a server the member was granted", async () => {
		mocks.serviceRows = [];
		service(applications, "app-r", "org-a", "server-a");
		host("server-a", {
			swarmServices: { "app-r-abc123": {} },
			containers: {
				"app-r-abc123.1.rrrrrrrrrrrrrrrrrrrrrrrrr": swarmTask("app-r-abc123"),
			},
		});
		as("member", ["app-r"]);
		expect(names(await metrics("app-r-abc123", "server-a"))).toEqual([
			"app-r-abc123.1.rrrrrrrrrrrrrrrrrrrrrrrrr",
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://203.0.113.10:4500/metrics/containers?limit=50&appName=app-r-abc123",
			{ headers: { Authorization: "Bearer remote-token" } },
		);
		// the same service asked for on the local host is not there
		await expect(metrics("app-r-abc123")).rejects.toMatchObject(notFound);
	});

	it("refuses a server of the organization the member was not granted, before running anything", async () => {
		mocks.serviceRows = [];
		service(applications, "app-r", "org-a", "server-a");
		as("member", ["app-r"]);
		mocks.servers = new Set();
		await expect(metrics("app-r-abc123", "server-a")).rejects.toMatchObject(
			notFound,
		);
		expect(mocks.commands).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("user.getContainerMetrics: names of another organization", () => {
	const foreign = [
		"app-b-abc123",
		"cmp-b-abc123-web-1",
		"stk-b-abc123_web",
		"stk-b-abc123_web.1.ttttttttttttttttttttttttt",
	];

	it.each(["member", "admin", "owner"] as const)(
		"refuses every one of them to an org-a %s",
		async (role) => {
			as(role, ["app-b", "cmp-b", "stk-b"]);
			for (const name of foreign) {
				await expect(metrics(name)).rejects.toMatchObject(notFound);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("does not hand out another organization's tasks under a prefix of their names", async () => {
		as("owner");
		// names nothing on the host carries: the agent's prefix match would find
		// app-b's task, which is dropped
		await expect(metrics("app-b-abc123.1")).rejects.toThrow(
			/No monitoring data/,
		);
		await expect(metrics("app_b-abc123")).rejects.toThrow(/No monitoring data/);
	});

	it("keeps only the caller's own container when its name is a wildcard for another organization's", async () => {
		// a compose of org-a names its container "app_b-abc123": the agent's
		// LIKE matches app-b's task containers as well
		host("local", {
			swarmServices: { "app-b-abc123": {} },
			containers: {
				"app_b-abc123": { "com.docker.compose.project": "cmp-a-abc123" },
				"app-b-abc123.1.bbbbbbbbbbbbbbbbbbbbbbbbb": swarmTask("app-b-abc123"),
			},
		});
		as("member", ["cmp-a"]);
		expect(names(await metrics("app_b-abc123"))).toEqual(["app_b-abc123"]);
	});
});

describe("user.getContainerMetrics: the host's own names", () => {
	it.each(["dokploy", "dokploy-traefik"])(
		"refuses %s to a member",
		async (name) => {
			as("member", ["app-a"]);
			await expect(metrics(name)).rejects.toMatchObject(notFound);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(["owner", "admin"] as const)(
		"gives an %s the host's own containers",
		async (role) => {
			as(role);
			expect(names(await metrics("dokploy"))).toEqual([
				"dokploy.1.ddddddddddddddddddddddddd",
			]);
			expect(names(await metrics("dokploy-traefik"))).toEqual([
				"dokploy-traefik",
			]);
		},
	);
});

describe("user.getContainerMetrics: names docker would read otherwise", () => {
	it.each(["--help", "-a", "app a", "app;id", "$(id)", ".hidden"])(
		"refuses %j without running anything",
		async (name) => {
			as("owner");
			await expect(metrics(name)).rejects.toMatchObject(notFound);
			expect(mocks.commands).toEqual([]);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("still asks for a name when none is selected", async () => {
		as("owner");
		await expect(metrics("")).rejects.toThrow(/No Application Selected/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
