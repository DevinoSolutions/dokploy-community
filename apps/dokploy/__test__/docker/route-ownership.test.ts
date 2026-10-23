import {
	applications,
	compose,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The docker routes take a container id (or an appName) the client sends. They
// must run on the full id of the ONE container that passed the ownership check,
// refuse containers of other organizations and the host's own for members, and
// check server access for the member (T-7051). Only the database rows, the
// docker commands and the docker service functions are scripted; the permission
// and organization checks are the real ones.
const mocks = vi.hoisted(() => ({
	member: {
		role: "member",
		accessedServices: [] as string[],
		canAccessToDocker: true,
	},
	// servers the caller may reach
	servers: new Set<string>(),
	serviceRows: new Map<
		unknown,
		(
			| { serviceId: string; serverId: string | null; appName?: string }
			| { applicationId: string | null; composeId: string | null }
		)[]
	>(),
	serviceOrganizations: new Map<string, string>(),
	parents: new Map<unknown, { serverId: string | null }[]>(),
	// container name -> its labels
	containers: new Map<string, Record<string, string>>(),
	// container name -> the full id docker resolves it to (default: derived)
	ids: new Map<string, string>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	commands: [] as { serverId?: string; command: string }[],
	services: {} as Record<string, ReturnType<typeof vi.fn>>,
	checkServicePermissionAndAccess: undefined as unknown as ReturnType<
		typeof vi.fn
	>,
	getContainers: undefined as unknown as ReturnType<typeof vi.fn>,
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
						if (!("serviceId" in fields || "applicationId" in fields))
							return mocks.parents.get(table) ?? [];
						// a row with an appName only answers a lookup for that name
						const { params } = dialect.sqlToQuery(condition);
						return (mocks.serviceRows.get(table) ?? []).filter(
							(row) =>
								!("appName" in row) ||
								!row.appName ||
								params.includes(row.appName),
						);
					},
				}),
			}),
			execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
				const [serviceId] = dialect.sqlToQuery(query).params as string[];
				const organizationId = mocks.serviceOrganizations.get(serviceId ?? "");
				return organizationId ? [{ organizationId }] : [];
			}),
		},
	};
});

vi.mock("@dokploy/server/services/server", () => ({
	getAccessibleServerIds: vi.fn(async () => mocks.servers),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	mocks.checkServicePermissionAndAccess = vi.fn(
		original.checkServicePermissionAndAccess,
	);
	return {
		...original,
		checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	const run = async (command: string, serverId?: string) => {
		mocks.commands.push({ serverId, command });
		if (!command.startsWith("docker inspect"))
			return { stdout: "", stderr: "" };
		// references follow the --format argument; the output has one line each
		const references = command
			.slice(command.indexOf("}}' ") + 4)
			.split(/\s+/)
			.map((word) => word.replace(/'/g, ""))
			.filter(Boolean);
		const lines: string[] = [];
		for (const reference of references) {
			const name = [...mocks.containers.keys()].find(
				(key) =>
					key === reference ||
					(mocks.ids.get(key) ?? mocks.idOf(key)).startsWith(reference),
			);
			if (!name) throw new Error("No such container");
			lines.push(
				`${mocks.ids.get(name) ?? mocks.idOf(name)} ${JSON.stringify(mocks.containers.get(name))}`,
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
		"containerKill",
		"containerRemove",
		"containerRestart",
		"containerStart",
		"containerStop",
		"deleteContainerFile",
		"getConfig",
		"getContainersByAppLabel",
		"getContainersByAppNameMatch",
		"getDockerEvents",
		"getServerHealth",
		"getServiceContainersByAppName",
		"getStackContainersByAppName",
		"listContainerFiles",
		"readContainerFile",
		"uploadFileToContainer",
		"writeContainerFile",
	];
	for (const name of names) mocks.services[name] = vi.fn(async () => []);
	mocks.getContainers = vi.fn();
	return {
		IS_CLOUD: false,
		findServerById: vi.fn(),
		getContainers: mocks.getContainers,
		...mocks.services,
	};
});

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

const { dockerRouter } = await import("@/server/api/routers/docker");

type Role = "owner" | "admin" | "member";

const callerAs = (role: Role) => {
	mocks.member = { ...mocks.member, role };
	return dockerRouter.createCaller({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role },
	} as Parameters<typeof dockerRouter.createCaller>[0]);
};

type Caller = ReturnType<typeof callerAs>;

// every route that takes a container id: its service function, whether it needs
// more than a read, and how to call it
const containerRoutes = [
	{
		route: "restartContainer",
		service: "containerRestart",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.restartContainer({ containerId, serverId }),
		args: (id: string, serverId?: string) => [id, serverId],
	},
	{
		route: "startContainer",
		service: "containerStart",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.startContainer({ containerId, serverId }),
		args: (id: string, serverId?: string) => [id, serverId],
	},
	{
		route: "stopContainer",
		service: "containerStop",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.stopContainer({ containerId, serverId }),
		args: (id: string, serverId?: string) => [id, serverId],
	},
	{
		route: "killContainer",
		service: "containerKill",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.killContainer({ containerId, serverId }),
		args: (id: string, serverId?: string) => [id, serverId],
	},
	{
		route: "removeContainer",
		service: "containerRemove",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.removeContainer({ containerId, serverId }),
		args: (id: string, serverId?: string) => [id, serverId],
	},
	{
		route: "getConfig",
		service: "getConfig",
		write: false,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.getConfig({ containerId, serverId }),
		args: (id: string, serverId?: string) => [id, serverId],
	},
	{
		route: "uploadFileToContainer",
		service: "uploadFileToContainer",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) => {
			const form = new FormData();
			form.set("containerId", containerId);
			form.set("file", new File(["hello"], "hello.txt"));
			form.set("destinationPath", "/tmp");
			if (serverId) form.set("serverId", serverId);
			return c.uploadFileToContainer(form as never);
		},
		args: (id: string, serverId?: string) => [
			id,
			expect.any(Buffer),
			"hello.txt",
			"/tmp",
			serverId ?? null,
		],
	},
	{
		route: "listContainerFiles",
		service: "listContainerFiles",
		write: false,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.listContainerFiles({ containerId, path: "/etc", serverId }),
		args: (id: string, serverId?: string) => [id, "/etc", serverId],
	},
	{
		route: "readContainerFile",
		service: "readContainerFile",
		write: false,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.readContainerFile({ containerId, path: "/etc/passwd", serverId }),
		args: (id: string, serverId?: string) => [id, "/etc/passwd", serverId],
	},
	{
		route: "writeContainerFile",
		service: "writeContainerFile",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.writeContainerFile({
				containerId,
				path: "/etc/cron.d/x",
				content: "x",
				serverId,
			}),
		args: (id: string, serverId?: string) => [
			id,
			"/etc/cron.d/x",
			"x",
			serverId,
		],
	},
	{
		route: "deleteContainerFile",
		service: "deleteContainerFile",
		write: true,
		call: (c: Caller, containerId: string, serverId?: string) =>
			c.deleteContainerFile({ containerId, path: "/etc/x", serverId }),
		args: (id: string, serverId?: string) => [id, "/etc/x", serverId],
	},
];

const ownApp = () => {
	mocks.containers.set("c-a", {
		"com.docker.swarm.service.name": "app-a-abc123",
	});
	mocks.serviceRows.set(applications, [{ serviceId: "app-a", serverId: null }]);
	mocks.serviceOrganizations.set("app-a", "org-a");
};

const foreignApp = () => {
	mocks.containers.set("c-b", {
		"com.docker.swarm.service.name": "app-b-abc123",
	});
	mocks.serviceRows.set(applications, [{ serviceId: "app-b", serverId: null }]);
	mocks.serviceOrganizations.set("app-b", "org-b");
};

const expectNotFound = async (promise: Promise<unknown>) => {
	await expect(promise).rejects.toMatchObject({
		code: "NOT_FOUND",
		message: "Container not found",
	});
};

const dockerCalls = () =>
	Object.values(mocks.services).reduce(
		(total, service) => total + service.mock.calls.length,
		0,
	);

const grant = (...accessedServices: string[]) => {
	mocks.member = { ...mocks.member, accessedServices };
};

beforeEach(() => {
	mocks.member = {
		role: "member",
		accessedServices: [],
		canAccessToDocker: true,
	};
	mocks.servers = new Set();
	mocks.serviceRows.clear();
	mocks.serviceOrganizations.clear();
	mocks.parents.clear();
	mocks.containers.clear();
	mocks.ids.clear();
	mocks.commands.length = 0;
	mocks.checkServicePermissionAndAccess.mockClear();
	mocks.getContainers.mockReset();
	for (const service of Object.values(mocks.services)) service.mockClear();
});

describe.each(containerRoutes)("docker.$route", (entry) => {
	it("refuses a container of another organization, for every role, without running anything", async () => {
		foreignApp();
		grant("app-b");
		for (const role of ["member", "admin", "owner"] as const) {
			await expectNotFound(entry.call(callerAs(role), "c-b"));
		}
		expect(dockerCalls()).toBe(0);
	});

	it("refuses a missing container like any other refusal", async () => {
		await expectNotFound(entry.call(callerAs("owner"), "nope"));
		expect(dockerCalls()).toBe(0);
	});

	it("refuses a system or unlabelled container for a member and runs it for an owner or admin", async () => {
		mocks.containers.set("dokploy", {
			"com.docker.swarm.service.name": "dokploy",
		});
		mocks.containers.set("unlabelled", {});
		for (const name of ["dokploy", "unlabelled"]) {
			await expectNotFound(entry.call(callerAs("member"), name));
		}
		expect(dockerCalls()).toBe(0);

		for (const role of ["owner", "admin"] as const) {
			for (const name of ["dokploy", "unlabelled"]) {
				mocks.services[entry.service]?.mockClear();
				await entry.call(callerAs(role), name);
				expect(mocks.services[entry.service]).toHaveBeenCalledWith(
					...entry.args(mocks.idOf(name)),
				);
			}
		}
	});

	it("runs the command on the full id, never on the string sent", async () => {
		const fullId = "a".repeat(64);
		// a name picked to look like the prefix of another container
		mocks.containers.set("aaaa", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.ids.set("aaaa", fullId);
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		await entry.call(callerAs("owner"), "aaaa");

		expect(mocks.services[entry.service]).toHaveBeenCalledWith(
			...entry.args(fullId),
		);
		expect(mocks.services[entry.service]).toHaveBeenCalledTimes(1);
	});

	it("refuses a name that docker resolves to another organization's container", async () => {
		foreignApp();
		mocks.containers.set("web", {
			"com.docker.swarm.service.name": "app-b-abc123",
		});
		await expectNotFound(entry.call(callerAs("owner"), "web"));
		expect(dockerCalls()).toBe(0);
	});

	it("opens a container of a service the member was granted, and refuses one they were not", async () => {
		ownApp();
		await expectNotFound(entry.call(callerAs("member"), "c-a"));

		grant("app-a");
		await entry.call(callerAs("member"), "c-a");
		expect(mocks.services[entry.service]).toHaveBeenCalledWith(
			...entry.args(mocks.idOf("c-a")),
		);
	});

	it(
		entry.write
			? "also needs deployment:create on the service, like stopping the service itself"
			: "needs no more than reading the service",
		async () => {
			ownApp();
			grant("app-a");
			await entry.call(callerAs("member"), "c-a");
			if (entry.write) {
				expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
					expect.anything(),
					"app-a",
					{ deployment: ["create"] },
				);
			} else {
				expect(mocks.checkServicePermissionAndAccess).not.toHaveBeenCalled();
			}
		},
	);

	if (entry.write) {
		it("is refused when the caller lacks deployment:create, with the same answer as any refusal", async () => {
			ownApp();
			mocks.checkServicePermissionAndAccess.mockRejectedValueOnce(
				new Error("Permission denied"),
			);
			await expectNotFound(entry.call(callerAs("owner"), "c-a"));
			expect(dockerCalls()).toBe(0);
		});
	}

	it("refuses a member for a server they cannot reach, before running anything on it", async () => {
		ownApp();
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: "srv-1" },
		]);
		grant("app-a");
		mocks.servers = new Set(["srv-2"]);

		await expectNotFound(entry.call(callerAs("member"), "c-a", "srv-1"));
		expect(mocks.commands).toHaveLength(0);
		expect(dockerCalls()).toBe(0);
	});

	it("runs on a reachable server, inspecting and acting on that server", async () => {
		ownApp();
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: "srv-1" },
		]);
		grant("app-a");
		mocks.servers = new Set(["srv-1"]);

		await entry.call(callerAs("member"), "c-a", "srv-1");

		expect(mocks.commands[0]?.serverId).toBe("srv-1");
		expect(mocks.services[entry.service]).toHaveBeenCalledWith(
			...entry.args(mocks.idOf("c-a"), "srv-1"),
		);
	});

	it("refuses a local container when a server is named", async () => {
		ownApp();
		mocks.servers = new Set(["srv-1"]);
		await expectNotFound(entry.call(callerAs("owner"), "c-a", "srv-1"));
		expect(dockerCalls()).toBe(0);
	});

	it("is refused for a caller without docker:read", async () => {
		ownApp();
		grant("app-a");
		mocks.member = { ...mocks.member, canAccessToDocker: false };
		await expect(entry.call(callerAs("member"), "c-a")).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(dockerCalls()).toBe(0);
	});
});

describe("labels that name more than one service", () => {
	it("counts a preview deployment as its parent service", async () => {
		mocks.containers.set("c-prev", {
			"com.docker.swarm.service.name": "preview-app-a-xyz",
		});
		mocks.serviceRows.set(previewDeployments, [
			{ applicationId: "app-a", composeId: null },
		]);
		mocks.parents.set(applications, [{ serverId: null }]);
		mocks.serviceOrganizations.set("app-a", "org-a");
		grant("app-a");

		await callerAs("member").restartContainer({ containerId: "c-prev" });
		expect(mocks.services.containerRestart).toHaveBeenCalledWith(
			mocks.idOf("c-prev"),
			undefined,
		);
	});

	it("refuses a container that also names a service the member cannot read", async () => {
		mocks.containers.set("c-mixed", {
			"com.docker.swarm.service.name": "app-a-abc123",
			"com.docker.compose.project": "cmp-b-xyz",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceRows.set(compose, [{ serviceId: "cmp-b", serverId: null }]);
		mocks.serviceOrganizations.set("app-a", "org-a");
		mocks.serviceOrganizations.set("cmp-b", "org-b");
		grant("app-a");

		await expectNotFound(
			callerAs("member").removeContainer({ containerId: "c-mixed" }),
		);
		expect(dockerCalls()).toBe(0);
	});
});

describe("docker.getContainers", () => {
	const listed = (names: string[]) =>
		names.map((name) => ({
			containerId: mocks.idOf(name).slice(0, 12),
			name,
		}));

	beforeEach(() => {
		ownApp();
		mocks.containers.set("c-b", {
			"com.docker.swarm.service.name": "app-b-abc123",
		});
		mocks.containers.set("traefik", {});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null, appName: "app-a-abc123" },
			{ serviceId: "app-b", serverId: null, appName: "app-b-abc123" },
		]);
		mocks.serviceOrganizations.set("app-b", "org-b");
		mocks.getContainers.mockImplementation(async () =>
			listed(["c-a", "c-b", "traefik"]),
		);
	});

	it("gives a member only the containers of services they were granted", async () => {
		grant("app-a");
		const result = await callerAs("member").getContainers({});
		expect(result?.map((container) => container.name)).toEqual(["c-a"]);
	});

	it("gives a member nothing for a service they were not granted", async () => {
		expect(await callerAs("member").getContainers({})).toEqual([]);
	});

	it("leaves the list as it is for an owner or admin", async () => {
		for (const role of ["owner", "admin"] as const) {
			const result = await callerAs(role).getContainers({});
			expect(result?.map((container) => container.name)).toEqual([
				"c-a",
				"c-b",
				"traefik",
			]);
		}
	});

	it("refuses a server the member cannot reach", async () => {
		mocks.servers = new Set(["srv-2"]);
		await expect(
			callerAs("member").getContainers({ serverId: "srv-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.getContainers).not.toHaveBeenCalled();
	});

	it("returns nothing for a member when the labels cannot be read", async () => {
		mocks.getContainers.mockImplementation(async () => [
			{ containerId: "ffffffffffff", name: "gone" },
		]);
		expect(await callerAs("member").getContainers({})).toEqual([]);
	});
});

describe("routes that take an appName", () => {
	const routes = [
		{
			route: "getContainersByAppLabel",
			call: (c: Caller, appName: string, serverId?: string) =>
				c.getContainersByAppLabel({ appName, type: "standalone", serverId }),
		},
		{
			route: "getStackContainersByAppName",
			call: (c: Caller, appName: string, serverId?: string) =>
				c.getStackContainersByAppName({ appName, serverId }),
		},
		{
			route: "getServiceContainersByAppName",
			call: (c: Caller, appName: string, serverId?: string) =>
				c.getServiceContainersByAppName({ appName, serverId }),
		},
		{
			route: "getContainersByAppNameMatch",
			call: (c: Caller, appName: string, serverId?: string) =>
				c.getContainersByAppNameMatch({ appName, serverId }),
		},
	];

	describe.each(routes)("docker.$route", (entry) => {
		beforeEach(() => grant("app-a"));

		it("lists the containers of a service the member was granted", async () => {
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-a", serverId: null },
			]);
			mocks.serviceOrganizations.set("app-a", "org-a");
			await entry.call(callerAs("member"), "app-a-abc123");
			expect(mocks.services[entry.route]).toHaveBeenCalledTimes(1);
		});

		it("refuses another organization's appName for every role", async () => {
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-b", serverId: null },
			]);
			mocks.serviceOrganizations.set("app-b", "org-b");
			for (const role of ["member", "admin", "owner"] as const) {
				await expectNotFound(entry.call(callerAs(role), "app-b-abc123"));
			}
			expect(dockerCalls()).toBe(0);
		});

		it("refuses a service the member was not granted", async () => {
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-c", serverId: null },
			]);
			mocks.serviceOrganizations.set("app-c", "org-a");
			await expectNotFound(entry.call(callerAs("member"), "app-c-abc123"));
			expect(dockerCalls()).toBe(0);
		});

		it("leaves the host's own appNames (Dokploy, Traefik) to owners and admins", async () => {
			await expectNotFound(entry.call(callerAs("member"), "dokploy"));
			expect(dockerCalls()).toBe(0);
			for (const role of ["owner", "admin"] as const) {
				mocks.services[entry.route]?.mockClear();
				await entry.call(callerAs(role), "dokploy");
				expect(mocks.services[entry.route]).toHaveBeenCalledTimes(1);
			}
		});

		it("refuses a server the member cannot reach", async () => {
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-a", serverId: "srv-1" },
			]);
			mocks.serviceOrganizations.set("app-a", "org-a");
			mocks.servers = new Set(["srv-2"]);
			await expectNotFound(
				entry.call(callerAs("member"), "app-a-abc123", "srv-1"),
			);
			expect(dockerCalls()).toBe(0);
		});
	});
});
