import {
	applications,
	compose,
	postgres,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// server.getContainerProcesses runs `docker top` on a container id the client
// sends, which prints the argv of its processes. The container has to belong
// to a service the caller can read before anything runs against it (T-7006).
// Only the database rows and the docker commands are scripted; the permission
// and organization checks are the real ones.
const mocks = vi.hoisted(() => ({
	member: { role: "member", accessedServices: [] as string[] },
	// table -> rows the service lookup finds for the container's labels
	serviceRows: new Map<
		unknown,
		(
			| { serviceId: string; serverId: string | null }
			| { applicationId: string | null; composeId: string | null }
		)[]
	>(),
	// service id -> organization it lives in
	serviceOrganizations: new Map<string, string>(),
	// parent rows the preview lookup reads the server from
	parents: new Map<unknown, { serverId: string | null }[]>(),
	// container name -> its labels
	containers: new Map<string, Record<string, string>>(),
	// container name -> the full id docker resolves it to (default: derived)
	ids: new Map<string, string>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	commands: [] as { serverId?: string; command: string }[],
	// servers the caller may reach (a member only reaches the ones granted)
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
					// service lookup, preview lookup, or the preview parent's server.
					// The lookups are batched: a row comes back under every appName
					// looked up, and a parent under every id looked up.
					where: async (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
						const params = dialect.sqlToQuery(condition).params as string[];
						if ("serviceId" in fields || "applicationId" in fields)
							return (mocks.serviceRows.get(table) ?? []).flatMap((row) =>
								params.map((appName) => ({ appName, ...row })),
							);
						return (mocks.parents.get(table) ?? []).flatMap((row) =>
							params.map((parentId) => ({ parentId, ...row })),
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

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	const run = async (command: string, serverId?: string) => {
		mocks.commands.push({ serverId, command });
		if (command.includes("docker inspect")) {
			const id = command.trim().split(/\s+/).pop() ?? "";
			const labels = mocks.containers.get(id);
			if (!labels) throw new Error("No such container");
			const fullId = mocks.ids.get(id) ?? mocks.idOf(id);
			return { stdout: `${fullId} ${JSON.stringify(labels)}`, stderr: "" };
		}
		return {
			stdout: [
				"PID %CPU %MEM RSS COMMAND",
				"1 1.5 2.0 1024 node server.js --password hunter2",
			].join("\n"),
			stderr: "",
		};
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

const dockerTopRuns = () =>
	mocks.commands.filter((entry) => entry.command.includes("docker top"));

beforeEach(() => {
	mocks.member = { role: "member", accessedServices: [] };
	mocks.serviceRows.clear();
	mocks.serviceOrganizations.clear();
	mocks.containers.clear();
	mocks.ids.clear();
	mocks.parents.clear();
	mocks.commands.length = 0;
	mocks.servers = new Set(["server-a"]);
});

describe("server.getContainerProcesses", () => {
	it("refuses a member of org A asking for an org B container, and never runs docker top", async () => {
		mocks.member = { role: "member", accessedServices: ["app-b"] };
		mocks.containers.set("c-b", {
			"com.docker.swarm.service.name": "app-b-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-b", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-b", "org-b");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-b" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses an owner of org A asking for an org B container", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-b", {
			"com.docker.swarm.service.name": "app-b-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-b", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-b", "org-b");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-b" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses a member of the right org who was not granted the service", async () => {
		mocks.containers.set("c-a", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-a" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses a container that matches no service, for an owner too", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("dokploy", {
			"com.docker.swarm.service.name": "dokploy",
		});
		mocks.containers.set("unlabelled", {});

		for (const containerId of ["dokploy", "unlabelled"]) {
			await expect(
				caller.server.getContainerProcesses({ containerId }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("answers a missing container like a refused one", async () => {
		await expect(
			caller.server.getContainerProcesses({ containerId: "nope" }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Container not found",
		});
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses a container with a forged extra label naming a service the caller cannot read", async () => {
		mocks.member = { role: "member", accessedServices: ["app-a"] };
		mocks.containers.set("c-mixed", {
			"com.docker.swarm.service.name": "app-a-abc123",
			"com.docker.compose.project": "cmp-b-xyz",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceRows.set(compose, [{ serviceId: "cmp-b", serverId: null }]);
		mocks.serviceOrganizations.set("app-a", "org-a");
		mocks.serviceOrganizations.set("cmp-b", "org-a");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-mixed" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses a member a server of the organization they were not granted, before running anything", async () => {
		mocks.member = { role: "member", accessedServices: ["app-a"] };
		mocks.servers = new Set();
		mocks.containers.set("c-a", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: "server-a" },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		await expect(
			caller.server.getContainerProcesses({
				containerId: "c-a",
				serverId: "server-a",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.commands).toHaveLength(0);
	});

	it("refuses a container whose service runs on another server", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-a", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: "server-a" },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-a" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses another organization's serverId before running anything", async () => {
		mocks.member = { role: "owner", accessedServices: [] };

		await expect(
			caller.server.getContainerProcesses({
				containerId: "c-a",
				serverId: "server-b",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.commands).toHaveLength(0);
	});

	it("runs docker top locally for an owner's own service and scrubs the argv", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-a", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		const processes = await caller.server.getContainerProcesses({
			containerId: "c-a",
		});

		expect(processes).toHaveLength(1);
		expect(processes[0]?.command).toBe("node server.js --password ***");
		expect(dockerTopRuns()).toEqual([
			{
				serverId: undefined,
				command: expect.stringContaining(`docker top ${mocks.idOf("c-a")}`),
			},
		]);
	});

	it("runs docker top on the service's server through ssh", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-a", {
			"com.docker.compose.project": "cmp-a-xyz",
		});
		mocks.serviceRows.set(compose, [
			{ serviceId: "cmp-a", serverId: "server-a" },
		]);
		mocks.serviceOrganizations.set("cmp-a", "org-a");

		const processes = await caller.server.getContainerProcesses({
			containerId: "c-a",
			serverId: "server-a",
		});

		expect(processes).toHaveLength(1);
		expect(dockerTopRuns()).toEqual([
			{
				serverId: "server-a",
				command: expect.stringContaining(`docker top ${mocks.idOf("c-a")}`),
			},
		]);
	});

	it("lets a member read a database service they were granted", async () => {
		mocks.member = { role: "member", accessedServices: ["pg-a"] };
		mocks.containers.set("c-pg", {
			"com.docker.swarm.service.name": "pg-a-abc123",
		});
		mocks.serviceRows.set(postgres, [{ serviceId: "pg-a", serverId: null }]);
		mocks.serviceOrganizations.set("pg-a", "org-a");

		const processes = await caller.server.getContainerProcesses({
			containerId: "c-pg",
		});

		expect(processes).toHaveLength(1);
		expect(dockerTopRuns()).toHaveLength(1);
	});
	it("runs docker top on the id inspect returned, not on the string sent", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		const fullId = "a".repeat(64);
		// a name the caller picked to look like the prefix of another container
		mocks.containers.set("aaaa", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.ids.set("aaaa", fullId);
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		await caller.server.getContainerProcesses({ containerId: "aaaa" });

		const runs = dockerTopRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.command).toBe(
			`docker top ${fullId} -eo pid,pcpu,pmem,rss,args`,
		);
	});

	it("refuses an inspect answer without a full 64 hex id", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-a", {
			"com.docker.swarm.service.name": "app-a-abc123",
		});
		mocks.ids.set("c-a", "abc123");
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-a", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-a", "org-a");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-a" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("resolves a preview container of an application to its parent", async () => {
		mocks.containers.set("c-prev", {
			"com.docker.swarm.service.name": "preview-app-p-xyz",
		});
		mocks.serviceRows.set(previewDeployments, [
			{ applicationId: "app-p", composeId: null },
		]);
		mocks.parents.set(applications, [{ serverId: null }]);
		mocks.serviceOrganizations.set("app-p", "org-a");

		mocks.member = { role: "member", accessedServices: [] };
		await expect(
			caller.server.getContainerProcesses({ containerId: "c-prev" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);

		mocks.member = { role: "member", accessedServices: ["app-p"] };
		await caller.server.getContainerProcesses({ containerId: "c-prev" });
		expect(dockerTopRuns()).toHaveLength(1);
	});

	it("resolves a preview container of a compose to its parent and server", async () => {
		mocks.member = { role: "member", accessedServices: ["cmp-p"] };
		mocks.containers.set("c-prev", {
			"com.docker.compose.project": "preview-cmp-p-xyz",
		});
		mocks.serviceRows.set(previewDeployments, [
			{ applicationId: null, composeId: "cmp-p" },
		]);
		mocks.parents.set(compose, [{ serverId: "server-a" }]);
		mocks.serviceOrganizations.set("cmp-p", "org-a");

		// the parent runs on server-a, so the local host is the wrong place
		await expect(
			caller.server.getContainerProcesses({ containerId: "c-prev" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);

		await caller.server.getContainerProcesses({
			containerId: "c-prev",
			serverId: "server-a",
		});
		expect(dockerTopRuns()).toEqual([
			{
				serverId: "server-a",
				command: expect.stringContaining(`docker top ${mocks.idOf("c-prev")}`),
			},
		]);
	});

	it("refuses a preview of an organization B service", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-prev", {
			"com.docker.swarm.service.name": "preview-app-b-xyz",
		});
		mocks.serviceRows.set(previewDeployments, [
			{ applicationId: "app-b", composeId: null },
		]);
		mocks.parents.set(applications, [{ serverId: null }]);
		mocks.serviceOrganizations.set("app-b", "org-b");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-prev" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses a remote container requested without a serverId", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-remote", {
			"com.docker.swarm.service.name": "app-r-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-r", serverId: "server-a" },
		]);
		mocks.serviceOrganizations.set("app-r", "org-a");

		await expect(
			caller.server.getContainerProcesses({ containerId: "c-remote" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});

	it("refuses a local container requested with a serverId", async () => {
		mocks.member = { role: "owner", accessedServices: [] };
		mocks.containers.set("c-local", {
			"com.docker.swarm.service.name": "app-l-abc123",
		});
		mocks.serviceRows.set(applications, [
			{ serviceId: "app-l", serverId: null },
		]);
		mocks.serviceOrganizations.set("app-l", "org-a");

		await expect(
			caller.server.getContainerProcesses({
				containerId: "c-local",
				serverId: "server-a",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(dockerTopRuns()).toHaveLength(0);
	});
});
