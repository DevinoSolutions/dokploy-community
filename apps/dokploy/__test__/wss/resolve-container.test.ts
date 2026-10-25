import {
	applications,
	compose,
	postgres,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The container terminal, logs and attach sockets reach a docker object by a
// name or id the client sends. resolveDockerTarget resolves it once to the full
// id of ONE object, checks the labels against the services the caller can read
// and hands the full id back (T-7030). Only the database rows and the docker
// commands are scripted; the permission and organization checks are the real
// ones.
const mocks = vi.hoisted(() => ({
	member: { role: "member", accessedServices: [] as string[] },
	// table -> rows the service lookup finds for the object's labels
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
	// swarm service name -> its spec labels
	services: new Map<string, Record<string, string>>(),
	// swarm task id -> the id of the service it belongs to
	tasks: new Map<string, string>(),
	// container name -> the full id docker resolves it to (default: derived)
	ids: new Map<string, string>(),
	idOf: (name: string) =>
		Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
	serviceIdOf: (name: string) =>
		/^[a-z0-9]{25}$/.test(name)
			? name
			: Buffer.from(name).toString("hex").padEnd(25, "z").slice(0, 25),
	// swarm service id -> its name, when it is not the key itself
	serviceNames: new Map<string, string>(),
	commands: [] as { serverId?: string; command: string }[],
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
		const name = (command.trim().split(/\s+/).pop() ?? "").replace(/'/g, "");
		if (command.includes("docker inspect --type task")) {
			const serviceId = mocks.tasks.get(name);
			if (!serviceId) throw new Error("No such task");
			return { stdout: `${name} ${serviceId}`, stderr: "" };
		}
		if (command.includes("docker service inspect")) {
			const labels = mocks.services.get(name);
			if (!labels) throw new Error("No such service");
			return {
				stdout: `${mocks.serviceIdOf(name)} ${JSON.stringify(labels)} ${mocks.serviceNames.get(name) ?? name}`,
				stderr: "",
			};
		}
		const labels = mocks.containers.get(name);
		if (!labels) throw new Error("No such container");
		const fullId = mocks.ids.get(name) ?? mocks.idOf(name);
		return { stdout: `${fullId} ${JSON.stringify(labels)}`, stderr: "" };
	};
	return {
		...original,
		execAsync: vi.fn((command: string) => run(command)),
		execAsyncRemote: vi.fn((serverId: string, command: string) =>
			run(command, serverId),
		),
	};
});

import { resolveDockerTarget } from "@/server/wss/resolve-container";

const USER = { id: "user-1" };
const SESSION = { activeOrganizationId: "org-a" };

const resolve = (
	reference: string,
	options: {
		serviceId?: string | null;
		serverId?: string | null;
		kind?: "container" | "service";
	} = {},
) =>
	resolveDockerTarget({
		user: USER,
		session: SESSION,
		reference,
		...options,
	});

const ownApp = (labels: Record<string, string> = {}) => {
	mocks.containers.set("c-a", {
		"com.docker.swarm.service.name": "app-a-abc123",
		...labels,
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

beforeEach(() => {
	mocks.member = { role: "member", accessedServices: [] };
	mocks.serviceRows.clear();
	mocks.serviceOrganizations.clear();
	mocks.containers.clear();
	mocks.services.clear();
	mocks.tasks.clear();
	mocks.serviceNames.clear();
	mocks.ids.clear();
	mocks.parents.clear();
	mocks.commands.length = 0;
});

describe("resolveDockerTarget", () => {
	describe("name and prefix collisions", () => {
		it("returns the full id of the object that was checked, never the string sent", async () => {
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

			expect(await resolve("aaaa", { serviceId: "app-a" })).toBe(fullId);
			expect(mocks.commands).toHaveLength(1);
		});

		it("refuses a name that docker resolves to another organization container", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			// "web" is the caller's own container name on paper, but docker
			// resolves it to the victim's container, whose labels decide
			foreignApp();
			mocks.containers.set("web", {
				"com.docker.swarm.service.name": "app-b-abc123",
			});

			expect(await resolve("web", { serviceId: "app-a" })).toBeNull();
			expect(await resolve("web")).toBeNull();
		});

		it("refuses a container of another service of the same organization on a service page", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			mocks.containers.set("c-other", {
				"com.docker.swarm.service.name": "app-other-abc123",
			});
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-other", serverId: null },
			]);
			mocks.serviceOrganizations.set("app-other", "org-a");

			expect(await resolve("c-other", { serviceId: "app-a" })).toBeNull();
			// the same container is fine from its own page
			expect(await resolve("c-other", { serviceId: "app-other" })).toBe(
				mocks.idOf("c-other"),
			);
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
			mocks.serviceOrganizations.set("cmp-b", "org-b");

			expect(await resolve("c-mixed", { serviceId: "app-a" })).toBeNull();
			expect(await resolve("c-mixed")).toBeNull();
		});
	});

	describe("a container of another organization", () => {
		it("is refused for a member, an admin and an owner, with or without a service", async () => {
			foreignApp();
			for (const role of ["member", "admin", "owner"]) {
				mocks.member = { role, accessedServices: ["app-b"] };
				expect(await resolve("c-b")).toBeNull();
				expect(await resolve("c-b", { serviceId: "app-b" })).toBeNull();
			}
		});
	});

	describe("system and unlabelled containers", () => {
		beforeEach(() => {
			mocks.containers.set("dokploy", {
				"com.docker.swarm.service.name": "dokploy",
			});
			mocks.containers.set("unlabelled", {});
		});

		it("are refused for a member holding docker:read", async () => {
			mocks.member = { role: "member", accessedServices: ["app-a"] };
			expect(await resolve("dokploy")).toBeNull();
			expect(await resolve("unlabelled")).toBeNull();
		});

		it("are refused on a service page for every role, since they back no service", async () => {
			for (const role of ["member", "admin", "owner"]) {
				mocks.member = { role, accessedServices: [] };
				expect(await resolve("dokploy", { serviceId: "app-a" })).toBeNull();
				expect(await resolve("unlabelled", { serviceId: "app-a" })).toBeNull();
			}
		});

		it("are only opened by an owner or admin, who already get the host terminal", async () => {
			for (const role of ["owner", "admin"]) {
				mocks.member = { role, accessedServices: [] };
				expect(await resolve("dokploy")).toBe(mocks.idOf("dokploy"));
				expect(await resolve("unlabelled")).toBe(mocks.idOf("unlabelled"));
			}
		});

		it("are refused when the caller has no membership in the organization", async () => {
			mocks.member = undefined as never;
			expect(await resolve("dokploy")).toBeNull();
		});
	});

	describe("without a serviceId (docker pages)", () => {
		it("opens a service container the member was granted", async () => {
			mocks.member = { role: "member", accessedServices: ["app-a"] };
			ownApp();
			expect(await resolve("c-a")).toBe(mocks.idOf("c-a"));
		});

		it("refuses a service container the member was not granted", async () => {
			ownApp();
			expect(await resolve("c-a")).toBeNull();
		});

		it("opens a service container for an owner of the organization", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			ownApp();
			expect(await resolve("c-a")).toBe(mocks.idOf("c-a"));
		});

		it("refuses a missing container like any other refusal", async () => {
			expect(await resolve("nope")).toBeNull();
			expect(await resolve("nope", { serviceId: "app-a" })).toBeNull();
		});
	});

	describe("a service page", () => {
		it("opens a container of the service", async () => {
			mocks.member = { role: "member", accessedServices: ["app-a"] };
			ownApp();
			expect(await resolve("c-a", { serviceId: "app-a" })).toBe(
				mocks.idOf("c-a"),
			);
		});

		it("counts a preview deployment as its parent", async () => {
			mocks.member = { role: "member", accessedServices: ["app-a"] };
			mocks.containers.set("c-prev", {
				"com.docker.swarm.service.name": "preview-app-a-xyz",
			});
			mocks.serviceRows.set(previewDeployments, [
				{ applicationId: "app-a", composeId: null },
			]);
			mocks.parents.set(applications, [{ serverId: null }]);
			mocks.serviceOrganizations.set("app-a", "org-a");

			expect(await resolve("c-prev", { serviceId: "app-a" })).toBe(
				mocks.idOf("c-prev"),
			);
			expect(await resolve("c-prev")).toBe(mocks.idOf("c-prev"));
		});

		it("opens a compose project container by its project label", async () => {
			mocks.member = { role: "member", accessedServices: ["cmp-a"] };
			mocks.containers.set("c-web", {
				"com.docker.compose.project": "cmp-a-xyz",
			});
			mocks.serviceRows.set(compose, [{ serviceId: "cmp-a", serverId: null }]);
			mocks.serviceOrganizations.set("cmp-a", "org-a");

			expect(await resolve("c-web", { serviceId: "cmp-a" })).toBe(
				mocks.idOf("c-web"),
			);
		});

		it("opens a database service container the member was granted", async () => {
			mocks.member = { role: "member", accessedServices: ["pg-a"] };
			mocks.containers.set("c-pg", {
				"com.docker.swarm.service.name": "pg-a-abc123",
			});
			mocks.serviceRows.set(postgres, [{ serviceId: "pg-a", serverId: null }]);
			mocks.serviceOrganizations.set("pg-a", "org-a");

			expect(await resolve("c-pg", { serviceId: "pg-a" })).toBe(
				mocks.idOf("c-pg"),
			);
		});
	});

	describe("remote servers", () => {
		it("inspects over ssh on the server and opens a service that runs there", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			mocks.containers.set("c-a", {
				"com.docker.compose.project": "cmp-a-xyz",
			});
			mocks.serviceRows.set(compose, [
				{ serviceId: "cmp-a", serverId: "server-a" },
			]);
			mocks.serviceOrganizations.set("cmp-a", "org-a");

			expect(
				await resolve("c-a", { serviceId: "cmp-a", serverId: "server-a" }),
			).toBe(mocks.idOf("c-a"));
			expect(mocks.commands).toEqual([
				{ serverId: "server-a", command: expect.stringContaining("c-a") },
			]);
		});

		it("refuses a container whose service runs on another server", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			ownApp();
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-a", serverId: "server-a" },
			]);

			expect(await resolve("c-a")).toBeNull();
			expect(await resolve("c-a", { serverId: "server-b" })).toBeNull();
		});

		it("lets an owner open an unlabelled container of their own server, not a member", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			mocks.containers.set("custom", {});
			expect(await resolve("custom", { serverId: "server-a" })).toBe(
				mocks.idOf("custom"),
			);
			mocks.member = { role: "member", accessedServices: [] };
			expect(await resolve("custom", { serverId: "server-a" })).toBeNull();
		});
	});

	describe("swarm services (docker service logs)", () => {
		it("inspects the service and returns its full id", async () => {
			mocks.member = { role: "member", accessedServices: ["app-a"] };
			mocks.services.set("app-a-abc123", {});
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-a", serverId: null },
			]);
			mocks.serviceOrganizations.set("app-a", "org-a");

			const id = await resolve("app-a-abc123", {
				kind: "service",
				serviceId: "app-a",
			});
			expect(id).toBe(mocks.serviceIdOf("app-a-abc123"));
			expect(id).toHaveLength(25);
			expect(mocks.commands[0]?.command).toContain("docker service inspect");
		});

		it("maps a stack service to its stack namespace", async () => {
			mocks.member = { role: "member", accessedServices: ["cmp-a"] };
			mocks.services.set("cmp-a-xyz_web", {
				"com.docker.stack.namespace": "cmp-a-xyz",
			});
			mocks.serviceRows.set(compose, [{ serviceId: "cmp-a", serverId: null }]);
			mocks.serviceOrganizations.set("cmp-a", "org-a");

			expect(
				await resolve("cmp-a-xyz_web", { kind: "service", serviceId: "cmp-a" }),
			).toBe(mocks.serviceIdOf("cmp-a-xyz_web"));
		});

		it("refuses another organization service and Dokploy itself for a member", async () => {
			mocks.services.set("app-b-abc123", {});
			mocks.services.set("dokploy", {});
			mocks.serviceRows.set(applications, [
				{ serviceId: "app-b", serverId: null },
			]);
			mocks.serviceOrganizations.set("app-b", "org-b");

			for (const role of ["member", "owner"]) {
				mocks.member = { role, accessedServices: ["app-b"] };
				expect(await resolve("app-b-abc123", { kind: "service" })).toBeNull();
			}
			mocks.member = { role: "member", accessedServices: [] };
			expect(await resolve("dokploy", { kind: "service" })).toBeNull();
		});

		describe("task ids (the swarm pages list `docker service ps`)", () => {
			const taskId = "t".repeat(25);
			// ids of the swarm services the tasks belong to
			const ownId = "a".repeat(25);
			const foreignId = "b".repeat(25);

			const ownService = () => {
				mocks.services.set(ownId, {});
				mocks.serviceNames.set(ownId, "app-a-abc123");
				mocks.serviceRows.set(applications, [
					{ serviceId: "app-a", serverId: null },
				]);
				mocks.serviceOrganizations.set("app-a", "org-a");
			};

			it("resolves a task to its service and returns the task id for an owner", async () => {
				mocks.member = { role: "owner", accessedServices: [] };
				ownService();
				mocks.tasks.set(taskId, ownId);
				expect(
					await resolve(taskId, { kind: "service", serviceId: "app-a" }),
				).toBe(taskId);
				expect(mocks.commands.map((c) => c.command)).toEqual([
					expect.stringContaining("docker service inspect"),
					expect.stringContaining("docker inspect --type task"),
					expect.stringContaining("docker service inspect"),
				]);
			});

			it("resolves a task of a member's granted service, on a remote server too", async () => {
				mocks.member = { role: "member", accessedServices: ["app-a"] };
				ownService();
				mocks.serviceRows.set(applications, [
					{ serviceId: "app-a", serverId: "server-a" },
				]);
				mocks.tasks.set(taskId, ownId);

				expect(
					await resolve(taskId, {
						kind: "service",
						serverId: "server-a",
					}),
				).toBe(taskId);
				expect(mocks.commands.every((c) => c.serverId === "server-a")).toBe(
					true,
				);
			});

			it("refuses a task of another organization's service, for every role", async () => {
				mocks.services.set(foreignId, {});
				mocks.serviceNames.set(foreignId, "app-b-abc123");
				mocks.serviceRows.set(applications, [
					{ serviceId: "app-b", serverId: null },
				]);
				mocks.serviceOrganizations.set("app-b", "org-b");
				mocks.tasks.set(taskId, foreignId);

				for (const role of ["member", "admin", "owner"]) {
					mocks.member = { role, accessedServices: ["app-b"] };
					expect(await resolve(taskId, { kind: "service" })).toBeNull();
					expect(
						await resolve(taskId, { kind: "service", serviceId: "app-b" }),
					).toBeNull();
				}
			});

			it("refuses a task of another service on a service page", async () => {
				mocks.member = { role: "owner", accessedServices: [] };
				ownService();
				mocks.tasks.set(taskId, ownId);
				expect(
					await resolve(taskId, { kind: "service", serviceId: "app-other" }),
				).toBeNull();
			});

			it("refuses a task of Dokploy's own service for a member", async () => {
				mocks.member = { role: "member", accessedServices: ["app-a"] };
				mocks.services.set(foreignId, {});
				mocks.serviceNames.set(foreignId, "dokploy");
				mocks.tasks.set(taskId, foreignId);
				expect(await resolve(taskId, { kind: "service" })).toBeNull();
			});

			it("refuses a task whose id or service id is malformed", async () => {
				mocks.member = { role: "owner", accessedServices: [] };
				ownService();
				// docker answers, but not with a 25 character task id
				mocks.tasks.set("short", ownId);
				mocks.tasks.set("UPPERCASE".padEnd(25, "X"), ownId);
				for (const reference of ["short", "UPPERCASE".padEnd(25, "X")]) {
					expect(await resolve(reference, { kind: "service" })).toBeNull();
				}
				// the task names a service docker cannot show
				mocks.tasks.set(taskId, "c".repeat(25));
				expect(await resolve(taskId, { kind: "service" })).toBeNull();
			});

			it("refuses an unknown task and quotes the reference", async () => {
				mocks.member = { role: "owner", accessedServices: [] };
				expect(await resolve("nope", { kind: "service" })).toBeNull();
				await resolve("t; rm -rf /", { kind: "service" });
				expect(mocks.commands.at(-1)?.command).toContain("'t; rm -rf /'");
			});

			it("does not look for a task when the service id resolves", async () => {
				mocks.member = { role: "owner", accessedServices: [] };
				ownService();
				expect(await resolve(ownId, { kind: "service" })).toBe(ownId);
				expect(
					mocks.commands.some((c) => c.command.includes("--type task")),
				).toBe(false);
			});
		});

		it("refuses a container id sent as a service, and the reverse", async () => {
			mocks.member = { role: "owner", accessedServices: [] };
			ownApp();
			expect(await resolve("c-a", { kind: "service" })).toBeNull();
			mocks.services.set("svc-only", {});
			expect(await resolve("svc-only")).toBeNull();
		});
	});

	it("refuses without a user or an active organization", async () => {
		ownApp();
		mocks.member = { role: "owner", accessedServices: [] };
		expect(
			await resolveDockerTarget({
				user: null,
				session: SESSION,
				reference: "c-a",
			}),
		).toBeNull();
		expect(
			await resolveDockerTarget({
				user: USER,
				session: { activeOrganizationId: null },
				reference: "c-a",
			}),
		).toBeNull();
		expect(mocks.commands).toHaveLength(0);
	});

	it("quotes the reference so it never reaches a shell as more than one word", async () => {
		await resolve("a; rm -rf /");
		expect(mocks.commands[0]?.command).toContain("'a; rm -rf /'");
	});
});
