import { applications } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The docker image, disk usage, swarm, event, health, cluster and network
// routes act on the whole host (T-7064). A member must not remove images or
// prune the build cache, must not read the images, nodes or health of the host,
// only gets the services, stats and events of the services they can read, and
// needs a server they were granted. The network routes are scoped to the row's
// organization and server. Only the database rows, the docker commands and the
// docker service functions are scripted; the permission and organization
// checks are the real ones.
const mocks = vi.hoisted(() => ({
	member: {
		role: "member",
		accessedServices: [] as string[],
		canAccessToDocker: true,
	},
	// the network statement is enterprise-only: a custom role would grant it
	grantAll: false,
	// servers the caller may reach
	servers: new Set<string>(),
	serviceRows: [] as {
		serviceId: string;
		serverId: string | null;
		appName: string;
	}[],
	serviceOrganizations: new Map<string, string>(),
	// container name -> its labels
	containers: new Map<string, Record<string, string>>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	// swarm service name -> its spec labels
	swarmServices: new Map<string, Record<string, string>>(),
	commands: [] as { serverId?: string; command: string }[],
	services: {} as Record<string, ReturnType<typeof vi.fn>>,
	networks: new Map<
		string,
		{
			networkId: string;
			organizationId: string;
			serverId: string | null;
			name: string;
		}
	>(),
	findMany: undefined as unknown as ReturnType<typeof vi.fn>,
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
						if (!("serviceId" in fields) || table !== applications) return [];
						// a row only answers a lookup for its own appName
						const { params } = dialect.sqlToQuery(condition);
						return mocks.serviceRows.filter((row) =>
							params.includes(row.appName),
						);
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

vi.mock("@/server/db", () => {
	mocks.findMany = vi.fn(async () => []);
	return { db: { query: { network: { findMany: mocks.findMany } } } };
});

vi.mock("@dokploy/server/services/server", () => ({
	getAccessibleServerIds: vi.fn(async () => mocks.servers),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...original,
		checkPermission: vi.fn(
			async (...args: Parameters<typeof original.checkPermission>) =>
				mocks.grantAll ? undefined : original.checkPermission(...args),
		),
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	const run = async (command: string, serverId?: string) => {
		mocks.commands.push({ serverId, command });
		if (command.startsWith("docker service inspect")) {
			const name = (command.trim().split(/\s+/).pop() ?? "").replace(/'/g, "");
			const labels = mocks.swarmServices.get(name);
			if (!labels) throw new Error("No such service");
			const id = Buffer.from(name).toString("hex").padEnd(25, "z").slice(0, 25);
			return { stdout: `${id} ${JSON.stringify(labels)} ${name}`, stderr: "" };
		}
		if (!command.startsWith("docker inspect"))
			return { stdout: "", stderr: "" };
		const references = command
			.slice(command.indexOf("}}' ") + 4)
			.replace(/ 2>\/dev\/null \|\| true$/, "")
			.split(/\s+/)
			.map((word) => word.replace(/'/g, ""))
			.filter(Boolean);
		const lines: string[] = [];
		for (const reference of references) {
			const name = [...mocks.containers.keys()].find(
				(key) => key === reference || mocks.idOf(key).startsWith(reference),
			);
			if (!name) continue;
			lines.push(
				`${mocks.idOf(name)} ${JSON.stringify(mocks.containers.get(name))}`,
			);
		}
		return { stdout: lines.join("\n"), stderr: "" };
	};
	return {
		...original,
		execAsync: vi.fn((command: string) => run(command)),
		execAsyncRemote: vi.fn((serverId: string, command: string) =>
			run(command, serverId),
		),
	};
});

vi.mock("@dokploy/server", () => {
	const names = [
		"getAllContainerStats",
		"getApplicationInfo",
		"getDockerDiskUsage",
		"getBuildCache",
		"cleanupBuilders",
		"getDockerEvents",
		"getImageConfig",
		"getImages",
		"getNodeApplications",
		"getNodeInfo",
		"getRemoteDocker",
		"getServerHealth",
		"getSwarmNodes",
		"removeImage",
		"createNetwork",
		"findNetworksToSync",
		"importDockerNetworks",
		"inspectNetwork",
		"recreateNetwork",
		"removeNetwork",
		"resyncNetwork",
	];
	for (const name of names) mocks.services[name] = vi.fn(async () => []);
	mocks.services.getRemoteDocker = vi.fn(async () => ({
		listNodes: async () => [],
		swarmInspect: async () => ({
			JoinTokens: { Worker: "worker-token", Manager: "manager-token" },
		}),
		version: async () => ({ Version: "27" }),
		info: async () => ({ Swarm: { NodeAddr: "10.0.0.1" } }),
	}));
	mocks.services.createNetwork = vi.fn(async () => ({
		networkId: "net-new",
		name: "new",
	}));
	mocks.services.importDockerNetworks = vi.fn(async () => ({
		imported: ["n"],
		errors: [],
	}));
	for (const name of ["recreateNetwork", "removeNetwork", "resyncNetwork"])
		mocks.services[name] = vi.fn(async (networkId: string) => ({
			networkId,
			name: "n",
		}));
	return {
		IS_CLOUD: false,
		findServerById: vi.fn(),
		execAsync: vi.fn(async (command: string) => {
			mocks.commands.push({ command });
			return { stdout: "", stderr: "" };
		}),
		execAsyncRemote: vi.fn(async (serverId: string, command: string) => {
			mocks.commands.push({ serverId, command });
			return { stdout: "", stderr: "" };
		}),
		findNetworkById: vi.fn(async (networkId: string) => {
			const row = mocks.networks.get(networkId);
			if (!row)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Network not found",
				});
			return row;
		}),
		...mocks.services,
	};
});

vi.mock("@/server/wss/terminal", () => ({ getLocalServerIp: vi.fn() }));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { dockerRouter } = await import("@/server/api/routers/docker");
const { dockerImageRouter } = await import("@/server/api/routers/docker-image");
const { dockerDiskUsageRouter } = await import(
	"@/server/api/routers/docker-disk-usage"
);
const { swarmRouter } = await import("@/server/api/routers/swarm");
const { clusterRouter } = await import("@/server/api/routers/cluster");
const { networkRouter } = await import("@/server/api/routers/network");

type Role = "owner" | "admin" | "member";

const context = (role: Role) => {
	mocks.member = { ...mocks.member, role };
	return {
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role },
	} as never;
};

const docker = (role: Role) => dockerRouter.createCaller(context(role));
const images = (role: Role) => dockerImageRouter.createCaller(context(role));
const disk = (role: Role) => dockerDiskUsageRouter.createCaller(context(role));
const swarm = (role: Role) => swarmRouter.createCaller(context(role));
const cluster = (role: Role) => clusterRouter.createCaller(context(role));
const networks = (role: Role) => networkRouter.createCaller(context(role));

const roles = ["owner", "admin"] as const;

const called = (...names: string[]) =>
	names.reduce(
		(total, name) => total + (mocks.services[name]?.mock.calls.length ?? 0),
		0,
	);

const expectUnauthorized = async (promise: Promise<unknown>) => {
	await expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });
};

// app-a is the member's (org-a, granted), app-b is another organization's
const twoApps = () => {
	mocks.serviceRows = [
		{ serviceId: "app-a", serverId: null, appName: "app-a-abc123" },
		{ serviceId: "app-b", serverId: null, appName: "app-b-abc123" },
	];
	mocks.serviceOrganizations.set("app-a", "org-a");
	mocks.serviceOrganizations.set("app-b", "org-b");
	mocks.member = { ...mocks.member, accessedServices: ["app-a"] };
	mocks.swarmServices.set("app-a-abc123", {});
	mocks.swarmServices.set("app-b-abc123", {});
	mocks.containers.set("c-a", {
		"com.docker.swarm.service.name": "app-a-abc123",
	});
	mocks.containers.set("c-b", {
		"com.docker.swarm.service.name": "app-b-abc123",
	});
	mocks.containers.set("traefik", {});
};

beforeEach(() => {
	mocks.member = {
		role: "member",
		accessedServices: [],
		canAccessToDocker: true,
	};
	mocks.grantAll = false;
	mocks.servers = new Set();
	mocks.serviceRows = [];
	mocks.serviceOrganizations.clear();
	mocks.containers.clear();
	mocks.swarmServices.clear();
	mocks.networks.clear();
	mocks.commands.length = 0;
	mocks.findMany.mockClear();
	for (const service of Object.values(mocks.services)) service.mockClear();
});

describe("dockerImage routes", () => {
	const image = {
		repository: "nginx",
		tag: "latest",
		id: "sha256:abc",
		serverId: undefined as string | undefined,
	};

	it("refuses a member removeImage, getImages and getImageConfig", async () => {
		const caller = images("member");
		await expectUnauthorized(caller.removeImage(image));
		await expectUnauthorized(caller.getImages({}));
		await expectUnauthorized(caller.getImageConfig({ imageRef: "nginx" }));
		expect(called("removeImage", "getImages", "getImageConfig")).toBe(0);
	});

	it.each(roles)("lets an %s remove, list and inspect images", async (role) => {
		const caller = images(role);
		await caller.removeImage({ ...image, force: true });
		await caller.getImages({});
		await caller.getImageConfig({ imageRef: "nginx" });
		expect(mocks.services.removeImage).toHaveBeenCalledWith(
			{ repository: "nginx", tag: "latest", id: "sha256:abc", force: true },
			undefined,
		);
		expect(mocks.services.getImages).toHaveBeenCalledWith(undefined);
		expect(mocks.services.getImageConfig).toHaveBeenCalledWith(
			"nginx",
			undefined,
		);
	});

	it("lets an owner act on a server of the organization and refuses another one", async () => {
		mocks.servers = new Set(["srv-1"]);
		await images("owner").removeImage({ ...image, serverId: "srv-1" });
		expect(mocks.services.removeImage).toHaveBeenCalledTimes(1);

		mocks.services.removeImage?.mockClear();
		await expectUnauthorized(
			images("owner").removeImage({ ...image, serverId: "srv-other-org" }),
		);
		await expectUnauthorized(
			images("owner").getImages({ serverId: "srv-other-org" }),
		);
		expect(called("removeImage", "getImages")).toBe(0);
	});
});

describe("dockerDiskUsage routes", () => {
	it("gives a member the sizes, but not the build cache or its pruning", async () => {
		await disk("member").getDiskUsage({});
		expect(mocks.services.getDockerDiskUsage).toHaveBeenCalledTimes(1);

		await expectUnauthorized(disk("member").getBuildCache({}));
		await expectUnauthorized(disk("member").pruneBuildCache({}));
		expect(called("getBuildCache", "cleanupBuilders")).toBe(0);
	});

	it.each(roles)("lets an %s read and prune the build cache", async (role) => {
		await disk(role).getBuildCache({});
		await disk(role).pruneBuildCache({});
		expect(mocks.services.getBuildCache).toHaveBeenCalledTimes(1);
		expect(mocks.services.cleanupBuilders).toHaveBeenCalledWith(undefined);
	});

	it("refuses a server the caller cannot reach, member or owner", async () => {
		mocks.servers = new Set(["srv-2"]);
		await expectUnauthorized(
			disk("member").getDiskUsage({ serverId: "srv-1" }),
		);
		await expectUnauthorized(
			disk("owner").getBuildCache({ serverId: "srv-1" }),
		);
		await expectUnauthorized(
			disk("owner").pruneBuildCache({ serverId: "srv-1" }),
		);
		expect(
			called("getDockerDiskUsage", "getBuildCache", "cleanupBuilders"),
		).toBe(0);
	});
});

describe("swarm nodes", () => {
	it("refuses a member the nodes, on both routers", async () => {
		await expectUnauthorized(swarm("member").getNodes({}));
		await expectUnauthorized(swarm("member").getNodeInfo({ nodeId: "n1" }));
		await expectUnauthorized(cluster("member").getNodes({}));
		expect(called("getSwarmNodes", "getNodeInfo", "getRemoteDocker")).toBe(0);
	});

	it.each(roles)("lets an %s read the nodes", async (role) => {
		await swarm(role).getNodes({});
		await swarm(role).getNodeInfo({ nodeId: "n1" });
		await cluster(role).getNodes({});
		expect(mocks.services.getSwarmNodes).toHaveBeenCalledWith(undefined);
		expect(mocks.services.getNodeInfo).toHaveBeenCalledWith("n1", undefined);
		expect(mocks.services.getRemoteDocker).toHaveBeenCalledTimes(1);
	});

	it("refuses an owner a server of another organization", async () => {
		mocks.servers = new Set(["srv-1"]);
		await expectUnauthorized(swarm("owner").getNodes({ serverId: "x" }));
		await expectUnauthorized(
			swarm("owner").getNodeInfo({ nodeId: "n1", serverId: "x" }),
		);
		await expectUnauthorized(cluster("owner").getNodes({ serverId: "x" }));
		expect(called("getSwarmNodes", "getNodeInfo", "getRemoteDocker")).toBe(0);
	});
});

describe("cluster join tokens and node removal", () => {
	it("refuses a member the local swarm's join tokens and node removal", async () => {
		const caller = cluster("member");
		await expectUnauthorized(caller.addWorker({}));
		await expectUnauthorized(caller.addManager({}));
		await expectUnauthorized(caller.removeWorker({ nodeId: "n1" }));
		expect(called("getRemoteDocker")).toBe(0);
		expect(mocks.commands).toEqual([]);
	});

	it.each(roles)("gives an %s the join commands", async (role) => {
		expect((await cluster(role).addWorker({})).command).toContain(
			"worker-token",
		);
		expect((await cluster(role).addManager({})).command).toContain(
			"manager-token",
		);
	});

	it("lets an owner remove a node of a reachable server only", async () => {
		mocks.servers = new Set(["srv-1"]);
		await cluster("owner").removeWorker({ nodeId: "n1", serverId: "srv-1" });
		expect(mocks.commands.map((entry) => entry.serverId)).toEqual([
			"srv-1",
			"srv-1",
		]);

		mocks.commands.length = 0;
		await expectUnauthorized(
			cluster("owner").removeWorker({ nodeId: "n1", serverId: "x" }),
		);
		await expectUnauthorized(cluster("owner").addWorker({ serverId: "x" }));
		await expectUnauthorized(cluster("owner").addManager({ serverId: "x" }));
		expect(mocks.commands).toEqual([]);
	});
});

describe("swarm services and stats", () => {
	const serviceRows = [
		{ ID: "s1", Name: "app-a-abc123" },
		{ ID: "s2", Name: "app-b-abc123" },
		{ ID: "s3", Name: "traefik" },
	];

	beforeEach(() => {
		twoApps();
		mocks.services.getNodeApplications?.mockImplementation(async () => [
			...serviceRows,
		]);
	});

	it("gives a member only the services they can read", async () => {
		expect(await swarm("member").getNodeApps({})).toEqual([serviceRows[0]]);
	});

	it.each(roles)("leaves the service list as it is for an %s", async (role) => {
		expect(await swarm(role).getNodeApps({})).toEqual(serviceRows);
	});

	it("refuses a member a server they were not granted, on every read route", async () => {
		mocks.servers = new Set(["srv-2"]);
		const caller = swarm("member");
		await expectUnauthorized(caller.getNodeApps({ serverId: "srv-1" }));
		await expectUnauthorized(
			caller.getAppInfos({ appName: ["app-a-abc123"], serverId: "srv-1" }),
		);
		await expectUnauthorized(caller.getContainerStats({ serverId: "srv-1" }));
		expect(
			called(
				"getNodeApplications",
				"getApplicationInfo",
				"getAllContainerStats",
			),
		).toBe(0);
	});

	it("asks docker only about the services of a member's own and filters the tasks", async () => {
		mocks.services.getApplicationInfo?.mockImplementation(async () => [
			{ ID: "t1", Name: "app-a-abc123.1" },
			{ ID: "t2", Name: "app-b-abc123.1" },
		]);
		const result = await swarm("member").getAppInfos({
			appName: ["app-a-abc123", "app-b-abc123", "traefik"],
		});
		expect(mocks.services.getApplicationInfo).toHaveBeenCalledWith(
			["app-a-abc123"],
			undefined,
		);
		expect(result).toEqual([{ ID: "t1", Name: "app-a-abc123.1" }]);
	});

	it("asks docker about every name for an owner", async () => {
		await swarm("owner").getAppInfos({
			appName: ["app-a-abc123", "app-b-abc123"],
		});
		expect(mocks.services.getApplicationInfo).toHaveBeenCalledWith(
			["app-a-abc123", "app-b-abc123"],
			undefined,
		);
	});

	it("caps the number of app names", async () => {
		await expect(
			swarm("owner").getAppInfos({
				appName: Array.from({ length: 501 }, (_, i) => `app-${i}`),
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(called("getApplicationInfo")).toBe(0);
	});

	it("rejects an app name that docker would read as a flag", async () => {
		await expect(
			swarm("owner").getAppInfos({ appName: ["--help"] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(called("getApplicationInfo")).toBe(0);
	});

	it("filters the container stats for every role: another organization's containers stay hidden from an owner or admin", async () => {
		const stats = ["c-a", "c-b", "traefik"].map((name) => ({
			ID: mocks.idOf(name).slice(0, 12),
			Name: name,
		}));
		mocks.services.getAllContainerStats?.mockImplementation(async () => [
			...stats,
		]);
		expect(
			(await swarm("member").getContainerStats({})).map(
				(row: { Name: string }) => row.Name,
			),
		).toEqual(["c-a"]);
		// c-b is org-b's: the host is shared, so org-a's admin does not see it,
		// and keeps their own containers and the host's own (traefik)
		for (const role of roles) {
			expect(
				(await swarm(role).getContainerStats({})).map(
					(row: { Name: string }) => row.Name,
				),
			).toEqual(["c-a", "traefik"]);
		}
	});
});

describe("docker.getEvents", () => {
	const event = (
		Type: string,
		attributes: Record<string, string>,
		Action = "die",
	) => ({ Type, Action, Actor: { ID: "x", Attributes: attributes } });

	const events = [
		event("container", { "com.docker.swarm.service.name": "app-a-abc123" }),
		event("container", { "com.docker.swarm.service.name": "app-b-abc123" }),
		event("service", { name: "app-a-abc123" }, "update"),
		event("service", { name: "app-b-abc123" }, "update"),
		event("container", {}),
		event("image", { name: "nginx" }, "pull"),
		event("network", { name: "other-tenant-net" }, "create"),
		event("volume", { driver: "local" }, "mount"),
	];

	beforeEach(() => {
		twoApps();
		mocks.services.getDockerEvents?.mockImplementation(async () => ({
			events,
			fetchedAt: "now",
		}));
	});

	it("gives a member only the events of the services they can read", async () => {
		const result = await docker("member").getEvents({});
		expect(result.events).toEqual([events[0], events[2]]);
		expect(result.fetchedAt).toBe("now");
	});

	it.each(roles)("leaves the events as they are for an %s", async (role) => {
		expect((await docker(role).getEvents({})).events).toEqual(events);
	});

	it("refuses a server the member cannot reach", async () => {
		mocks.servers = new Set(["srv-2"]);
		await expectUnauthorized(docker("member").getEvents({ serverId: "srv-1" }));
		expect(called("getDockerEvents")).toBe(0);
	});
});

describe("docker.getServerHealth", () => {
	it("is refused to a member, even one who holds docker.read", async () => {
		await expectUnauthorized(docker("member").getServerHealth({}));
		expect(called("getServerHealth")).toBe(0);
	});

	it.each(roles)("is allowed to an %s on a reachable server", async (role) => {
		mocks.servers = new Set(["srv-1"]);
		await docker(role).getServerHealth({ serverId: "srv-1" });
		expect(mocks.services.getServerHealth).toHaveBeenCalledWith(
			"org-a",
			"srv-1",
			undefined,
		);
	});

	it("refuses an owner a server of another organization", async () => {
		await expectUnauthorized(
			docker("owner").getServerHealth({ serverId: "x" }),
		);
		expect(called("getServerHealth")).toBe(0);
	});
});

describe("network routes", () => {
	const row = (
		networkId: string,
		organizationId: string,
		serverId: string | null,
	) => {
		mocks.networks.set(networkId, {
			networkId,
			organizationId,
			serverId,
			name: networkId,
		});
	};

	beforeEach(() => {
		// a custom role that grants the network statement to the member
		mocks.grantAll = true;
		mocks.servers = new Set(["srv-1"]);
		row("net-own", "org-a", "srv-1");
		row("net-local", "org-a", null);
		row("net-foreign", "org-b", null);
		row("net-ungranted", "org-a", "srv-2");
	});

	const rowRoutes = [
		{
			route: "one",
			service: undefined,
			call: (c: ReturnType<typeof networks>, networkId: string) =>
				c.one({ networkId }),
		},
		{
			route: "inspect",
			service: "inspectNetwork",
			call: (c: ReturnType<typeof networks>, networkId: string) =>
				c.inspect({ networkId }),
		},
		{
			route: "recreate",
			service: "recreateNetwork",
			call: (c: ReturnType<typeof networks>, networkId: string) =>
				c.recreate({ networkId }),
		},
		{
			route: "resync",
			service: "resyncNetwork",
			call: (c: ReturnType<typeof networks>, networkId: string) =>
				c.resync({ networkId }),
		},
		{
			route: "remove",
			service: "removeNetwork",
			call: (c: ReturnType<typeof networks>, networkId: string) =>
				c.remove({ networkId }),
		},
	];

	describe.each(rowRoutes)("network.$route", (entry) => {
		it("refuses a network of another organization, for every role, without touching docker", async () => {
			for (const role of ["member", "admin", "owner"] as const) {
				await expect(
					entry.call(networks(role), "net-foreign"),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
			}
			if (entry.service) expect(called(entry.service)).toBe(0);
		});

		it("refuses a member a network on a server they were not granted", async () => {
			await expect(
				entry.call(networks("member"), "net-ungranted"),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			if (entry.service) expect(called(entry.service)).toBe(0);
		});

		it("refuses a missing network the same way", async () => {
			await expect(entry.call(networks("owner"), "nope")).rejects.toMatchObject(
				{ code: "NOT_FOUND" },
			);
		});

		it("runs on a network of the organization on a reachable server", async () => {
			for (const networkId of ["net-own", "net-local"]) {
				await entry.call(networks("member"), networkId);
			}
			if (entry.service) expect(called(entry.service)).toBe(2);
		});
	});

	it("lists only the organization's networks of the requested server", async () => {
		await networks("member").all({ serverId: "srv-1" });
		const where = mocks.findMany.mock.calls[0]?.[0].where;
		const { params } = new PgDialect().sqlToQuery(where);
		expect(params).toEqual(["org-a", "srv-1"]);
	});

	it("refuses a member the list of a server they were not granted", async () => {
		await expectUnauthorized(networks("member").all({ serverId: "srv-2" }));
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("refuses to create a network on a server the member cannot reach", async () => {
		await expectUnauthorized(
			networks("member").create({ name: "x", serverId: "srv-2" }),
		);
		expect(called("createNetwork")).toBe(0);

		await networks("member").create({ name: "x", serverId: "srv-1" });
		expect(mocks.services.createNetwork).toHaveBeenCalledWith(
			expect.objectContaining({ name: "x", serverId: "srv-1" }),
			"org-a",
		);
	});

	it("keeps the host's own networks (sync and import) to owners and admins", async () => {
		await expectUnauthorized(networks("member").networksToSync({}));
		await expectUnauthorized(
			networks("member").import({ names: ["other-tenant-net"] }),
		);
		expect(called("findNetworksToSync", "importDockerNetworks")).toBe(0);

		for (const role of roles) {
			await networks(role).networksToSync({ serverId: "srv-1" });
			await networks(role).import({ serverId: "srv-1", names: ["n"] });
		}
		expect(mocks.services.findNetworksToSync).toHaveBeenCalledWith(
			"org-a",
			"srv-1",
		);
		expect(called("importDockerNetworks")).toBe(2);
		await expectUnauthorized(
			networks("owner").networksToSync({ serverId: "srv-other-org" }),
		);
	});
});
