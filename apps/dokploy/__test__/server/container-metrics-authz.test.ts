import {
	applications,
	compose,
	postgres,
	previewDeployments,
} from "@dokploy/server/db/schema";
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
	// the organization that owns the instance; the host's own containers are its
	// owners' and admins' alone
	rootOrganization: "org-a",
	isCloud: false,
	// server id -> organization, where it is not the default
	serverOrganizations: new Map<string, string>(),
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
	// preview deployments: their appName and the service they belong to
	previews: [] as {
		appName: string;
		applicationId: string | null;
		composeId: string | null;
	}[],
	// docker commands that fail without saying anything about the object
	// (the daemon or the SSH connection is down): command prefix -> error
	failures: new Map<string, Error>(),
}));

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server")>()),
	get IS_CLOUD() {
		return mocks.isCloud;
	},
	isRootOrganization: async (organizationId: string) =>
		organizationId === mocks.rootOrganization,
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
						const { params } = dialect.sqlToQuery(condition);
						// the server of a preview's parent, looked up by its id
						if ("parentId" in fields)
							return mocks.serviceRows
								.filter(
									(row) =>
										row.table === table && params.includes(row.serviceId),
								)
								.map(({ serviceId, serverId }) => ({
									parentId: serviceId,
									serverId,
								}));
						if (table === previewDeployments)
							return mocks.previews.filter((row) =>
								params.includes(row.appName),
							);
						// a row only answers a lookup for its own appName
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
		for (const [prefix, error] of mocks.failures)
			if (command.startsWith(prefix)) throw error;
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
		organizationId:
			mocks.serverOrganizations.get(serverId) ??
			(serverId === "server-b" ? "org-b" : "org-a"),
		ipAddress: "203.0.113.10",
		metricsConfig: { server: { port: 4500, token: "remote-token" } },
	})),
	getAccessibleServerIds: vi.fn(async () => mocks.servers),
}));

// The agent (SQLite): `container_name = ? OR container_name LIKE ? || '.%'`;
// `=` is case-sensitive, LIKE is not
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
		"i",
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

// an owner or admin of org-b, which does not own the instance (org-a does)
const callerOfOtherOrganization = createCallerFactory(appRouter)({
	user: { id: "user-2", email: "v@example.com", role: "member", ownerId: "o" },
	session: { activeOrganizationId: "org-b" },
	req: { headers: {} },
	res: {},
} as never);
const metricsOfOtherOrganization = (appName: string, serverId?: string) =>
	callerOfOtherOrganization.user.getContainerMetrics({
		appName,
		serverId,
		dataPoints: "50",
	});

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
	mocks.previews = [];
	mocks.failures.clear();
	mocks.isCloud = false;
	mocks.serverOrganizations.clear();
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
		// app-b's task. A name that extends app-b's appName is refused; a
		// wildcard for it gets the task dropped from the answer.
		await expect(metrics("app-b-abc123.1")).rejects.toMatchObject(notFound);
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

describe("user.getContainerMetrics: an organization that does not own the instance", () => {
	// the host's own names: Dokploy itself, Traefik, a name nothing carries
	const hostOwnNames = ["dokploy", "dokploy-traefik", "dokploy-postgres"];

	it.each(
		hostOwnNames.flatMap((name) =>
			(["owner", "admin"] as const).map((role) => [role, name] as const),
		),
	)("refuses an %s of it the host's own name %s", async (role, name) => {
		as(role);
		mocks.metrics.get("local")?.push("dokploy-postgres");
		await expect(metricsOfOtherOrganization(name)).rejects.toMatchObject(
			notFound,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses an admin of it a host container that was taken down", async () => {
		as("admin");
		mocks.containers.get("local")?.delete("dokploy-traefik");
		await expect(
			metricsOfOtherOrganization("dokploy-traefik"),
		).rejects.toMatchObject(notFound);
	});

	it.each(["owner", "admin"] as const)(
		"still gives an %s of it the rows of its own service",
		async (role) => {
			as(role);
			expect(names(await metricsOfOtherOrganization("app-b-abc123"))).toEqual([
				"app-b-abc123.1.bbbbbbbbbbbbbbbbbbbbbbbbb",
			]);
			expect(
				names(await metricsOfOtherOrganization("cmp-b-abc123-web-1")),
			).toEqual(["cmp-b-abc123-web-1"]);
		},
	);

	it("refuses an admin of it another organization's service", async () => {
		as("admin");
		await expect(
			metricsOfOtherOrganization("app-a-abc123"),
		).rejects.toMatchObject(notFound);
	});

	it("gives the admin of the organization that owns the instance the same host names", async () => {
		as("admin");
		expect(names(await metrics("dokploy"))).toEqual([
			"dokploy.1.ddddddddddddddddddddddddd",
		]);
		expect(names(await metrics("dokploy-traefik"))).toEqual([
			"dokploy-traefik",
		]);
	});

	it("gives an admin of it the names of its own remote server", async () => {
		as("admin");
		mocks.serverOrganizations.set("server-a", "org-b");
		mocks.servers = new Set(["server-a"]);
		host("server-a", {
			containers: { "dokploy-traefik": {} },
		});
		expect(
			names(await metricsOfOtherOrganization("dokploy-traefik", "server-a")),
		).toEqual(["dokploy-traefik"]);
	});

	it("refuses an admin of it a remote server of another organization", async () => {
		as("admin");
		await expect(
			metricsOfOtherOrganization("dokploy-traefik", "server-a"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("is unchanged on Dokploy Cloud", async () => {
		as("admin");
		mocks.isCloud = true;
		expect(names(await metricsOfOtherOrganization("dokploy-traefik"))).toEqual([
			"dokploy-traefik",
		]);
	});
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

	it("refuses a name longer than 255 characters before running anything", async () => {
		as("owner");
		await expect(metrics("a".repeat(256))).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.commands).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("user.getContainerMetrics: what nothing on the host carries any more", () => {
	// docker compose down: the containers are gone, the agent keeps their rows
	const composeDown = (container: string) => {
		mocks.containers.get("local")?.delete(container);
		expect(mocks.metrics.get("local")).toContain(container);
	};

	it.each(["owner", "admin"] as const)(
		"refuses an %s the rows of another organization's compose that was taken down",
		async (role) => {
			as(role);
			composeDown("cmp-b-abc123-web-1");
			await expect(metrics("cmp-b-abc123-web-1")).rejects.toMatchObject(
				notFound,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("gives an admin the rows of their own compose that was taken down", async () => {
		as("admin");
		composeDown("cmp-a-abc123-web-1");
		expect(names(await metrics("cmp-a-abc123-web-1"))).toEqual([
			"cmp-a-abc123-web-1",
		]);
	});

	it("refuses a name that extends another organization's preview appName", async () => {
		as("owner");
		mocks.previews = [
			{ appName: "preview-b-xyz789", applicationId: null, composeId: "cmp-b" },
		];
		mocks.metrics.get("local")?.push("preview-b-xyz789-web-1");
		await expect(metrics("preview-b-xyz789-web-1")).rejects.toMatchObject(
			notFound,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still gives an admin the host's own names, which extend no service's appName", async () => {
		as("admin");
		composeDown("dokploy-traefik");
		expect(names(await metrics("dokploy-traefik"))).toEqual([
			"dokploy-traefik",
		]);
	});
});

describe("user.getContainerMetrics: docker failures", () => {
	const daemonDown = () =>
		new Error(
			"Command execution failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
		);

	it.each([
		["both lookups fail", ["docker service inspect", "docker inspect"]],
		["the service lookup fails", ["docker service inspect"]],
		["the container lookup fails", ["docker inspect --type container"]],
	])(
		"refuses an admin when %s without saying the object is absent",
		async (_, prefixes) => {
			as("admin");
			// org-b's compose names its container "redis-cache", which extends
			// no appName: only docker's answer (its labels) stands between the
			// admin and org-b's rows
			mocks.containers
				.get("local")
				?.set("redis-cache", { "com.docker.compose.project": "cmp-b-abc123" });
			mocks.metrics.get("local")?.push("redis-cache");
			for (const prefix of prefixes) mocks.failures.set(prefix, daemonDown());
			for (const name of ["redis-cache", "dokploy-traefik"]) {
				await expect(metrics(name)).rejects.toMatchObject(notFound);
			}
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("refuses when the SSH connection to the server fails", async () => {
		as("admin");
		mocks.failures.set(
			"docker service inspect",
			new Error(
				"Command execution error: connect ECONNREFUSED 203.0.113.10:22",
			),
		);
		await expect(metrics("dokploy-traefik", "server-a")).rejects.toMatchObject(
			notFound,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads a host that is no swarm manager as one without services", async () => {
		as("admin");
		mocks.failures.set(
			"docker service inspect",
			Object.assign(new Error("Command execution failed"), {
				stderr:
					'Error response from daemon: This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again.',
			}),
		);
		expect(names(await metrics("dokploy-traefik"))).toEqual([
			"dokploy-traefik",
		]);
	});

	it("reads docker's own not-found answers as absent", async () => {
		as("admin");
		mocks.failures.set(
			"docker service inspect",
			Object.assign(new Error("Command execution failed"), {
				stderr: "Status: Error: no such service: dokploy-traefik, Code: 1",
			}),
		);
		expect(names(await metrics("dokploy-traefik"))).toEqual([
			"dokploy-traefik",
		]);
		mocks.failures.clear();
		mocks.containers.get("local")?.delete("dokploy-traefik");
		mocks.failures.set(
			"docker inspect --type container",
			Object.assign(new Error("Command execution failed"), {
				stderr:
					"Error response from daemon: No such container: dokploy-traefik",
			}),
		);
		expect(names(await metrics("dokploy-traefik"))).toEqual([
			"dokploy-traefik",
		]);
	});
});

describe("user.getContainerMetrics: case variants", () => {
	// docker names and appNames are case-sensitive, the agent's LIKE is not
	it.each([
		"APP-B-ABC123",
		"App-B-Abc123",
		"APP-B-ABC123.1",
		"STK-B-ABC123_WEB",
		"CMP-B-ABC123-WEB-1",
	])(
		"never hands another organization's rows to an owner asking for %s",
		async (name) => {
			as("owner");
			await expect(metrics(name)).rejects.toThrow(/No monitoring data/);
		},
	);

	it("drops the rows the agent's LIKE adds for a case variant", async () => {
		as("owner");
		await expect(metrics("APP-B-ABC123")).rejects.toThrow(/No monitoring data/);
		// the agent did answer, with app-b's task: the filter dropped it
		const answer = await fetchMock.mock.results[0]?.value;
		expect(names(await answer?.json())).toEqual([
			"app-b-abc123.1.bbbbbbbbbbbbbbbbbbbbbbbbb",
		]);
	});
});
