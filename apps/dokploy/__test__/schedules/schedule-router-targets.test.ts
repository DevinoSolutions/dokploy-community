import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A schedule runs a command against one target: a service container, a remote
 * server or the Dokploy host. Every id a request supplies must belong to the
 * caller's active organization, and must be the id its scheduleType names, on
 * create and on update alike.
 */

const mocks = vi.hoisted(() => ({
	memberRole: "owner" as string,
	// serviceId -> organizationId
	serviceOrgs: {} as Record<string, string>,
	// serverId -> organizationId
	serverOrgs: {} as Record<string, string>,
	existing: null as Record<string, unknown> | null,
	createSchedule: vi.fn(),
	updateSchedule: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	const chain = (): any => {
		const self: any = {
			set: vi.fn(() => self),
			where: vi.fn(() => self),
			values: vi.fn(() => self),
			returning: vi.fn(async () => [{}]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
	};
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) => {
					if (table === "member") {
						return {
							findFirst: vi.fn(async () => ({
								id: "member-1",
								userId: "user-1",
								organizationId: "org-1",
								role: mocks.memberRole,
								accessedServices: [],
								accessedProjects: [],
								accessedEnvironments: [],
								user: { id: "user-1" },
							})),
							findMany: vi.fn(async () => []),
						};
					}
					return tableMock();
				},
			}),
			// Service -> organization resolver used by assertServiceInOrganization.
			// The id being looked up is a bound parameter of the sql template.
			execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
				// drizzle keeps the interpolated id as a bare string chunk
				const ids = (query.queryChunks ?? []).filter(
					(chunk): chunk is string => typeof chunk === "string",
				);
				const id = ids.find((value) => value in mocks.serviceOrgs);
				return id ? [{ organizationId: mocks.serviceOrgs[id] }] : [];
			}),
			select: vi.fn(() => chain()),
			insert: vi.fn(() => chain()),
			update: vi.fn(() => chain()),
			delete: vi.fn(() => chain()),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: vi.fn(async (serverId: string) => {
		const organizationId = mocks.serverOrgs[serverId];
		if (!organizationId) throw new Error("Server not found");
		return { serverId, organizationId };
	}),
}));

vi.mock("@dokploy/server/services/schedule", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findScheduleById: vi.fn(async () => mocks.existing),
	createSchedule: mocks.createSchedule,
	updateSchedule: mocks.updateSchedule,
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { scheduleRouter } = await import("@/server/api/routers/schedule");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(scheduleRouter)({
		user: { id: "user-1", email: "owner@test.com", role: "owner" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const base = {
	name: "Nightly",
	cronExpression: "0 0 * * *",
	command: "echo hi",
	shellType: "bash" as const,
	enabled: false,
};

const stored = (
	scheduleType: string,
	ids: Record<string, string | null> = {},
) => ({
	scheduleId: "sch-1",
	scheduleType,
	appName: "schedule-run-fast-bus-AbC123",
	applicationId: null,
	composeId: null,
	serverId: null,
	organizationId: scheduleType === "dokploy-server" ? "org-1" : null,
	cronExpression: "0 0 * * *",
	enabled: false,
	...ids,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memberRole = "owner";
	mocks.serviceOrgs = {
		"app-own": "org-1",
		"app-own-2": "org-1",
		"comp-own": "org-1",
		"app-foreign": "org-2",
		"comp-foreign": "org-2",
	};
	mocks.serverOrgs = { "srv-own": "org-1", "srv-foreign": "org-2" };
	mocks.existing = null;
	mocks.createSchedule.mockResolvedValue({
		scheduleId: "sch-1",
		name: "Nightly",
		enabled: false,
	});
	mocks.updateSchedule.mockResolvedValue({
		scheduleId: "sch-1",
		name: "Nightly",
		enabled: false,
		cronExpression: "0 0 * * *",
	});
});

describe("schedule.create", () => {
	it.each([
		["application", { applicationId: "app-own" }],
		["compose", { composeId: "comp-own" }],
		["server", { serverId: "srv-own" }],
		["dokploy-server", {}],
	] as const)("accepts a %s schedule with its own target", async (scheduleType, ids) => {
		await caller().create({ ...base, scheduleType, ...ids });
		expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
	});

	it.each([
		["application", { applicationId: "app-foreign" }],
		["compose", { composeId: "comp-foreign" }],
		["server", { serverId: "srv-foreign" }],
	] as const)("rejects a %s target in another organization", async (scheduleType, ids) => {
		await expect(
			caller().create({ ...base, scheduleType, ...ids }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.createSchedule).not.toHaveBeenCalled();
	});

	it("rejects a foreign composeId hidden behind an accessible applicationId", async () => {
		await expect(
			caller().create({
				...base,
				scheduleType: "compose",
				applicationId: "app-own",
				composeId: "comp-foreign",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createSchedule).not.toHaveBeenCalled();
	});

	it.each([
		["application", { applicationId: "app-own", composeId: "comp-own" }],
		["application", { applicationId: "app-own", serverId: "srv-own" }],
		["application", { composeId: "comp-own" }],
		["application", {}],
		["compose", { applicationId: "app-own" }],
		["compose", { composeId: "comp-own", applicationId: "app-own" }],
		["compose", {}],
		["server", { applicationId: "app-own" }],
		["server", { serverId: "srv-own", composeId: "comp-own" }],
		["server", {}],
		["dokploy-server", { serverId: "srv-own" }],
		["dokploy-server", { applicationId: "app-own" }],
		["dokploy-server", { composeId: "comp-own" }],
	] as const)("rejects a %s schedule with ids %j", async (scheduleType, ids) => {
		await expect(
			caller().create({ ...base, scheduleType, ...ids }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createSchedule).not.toHaveBeenCalled();
	});

	it("treats an omitted scheduleType as an application schedule", async () => {
		await expect(
			caller().create({ ...base, composeId: "comp-own" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await caller().create({ ...base, applicationId: "app-own" });
		expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
	});

	it("takes the organization of a dokploy-server schedule from the session", async () => {
		await caller().create({
			...base,
			scheduleType: "dokploy-server",
			organizationId: "org-2",
		} as never);
		expect(mocks.createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});
});

describe("schedule.update", () => {
	it("does not retarget a server schedule to another organization's server", async () => {
		mocks.existing = stored("server", { serverId: "srv-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "server",
				serverId: "srv-foreign",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("does not retarget an application schedule to a foreign application", async () => {
		mocks.existing = stored("application", { applicationId: "app-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "application",
				applicationId: "app-foreign",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("does not retarget a compose schedule to a foreign compose", async () => {
		mocks.existing = stored("compose", { composeId: "comp-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "compose",
				composeId: "comp-foreign",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("checks the new composeId when the type changes to compose", async () => {
		mocks.existing = stored("application", { applicationId: "app-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "compose",
				applicationId: null,
				composeId: "comp-foreign",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("rejects a type change that keeps the old target", async () => {
		mocks.existing = stored("application", { applicationId: "app-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "compose",
				composeId: "comp-foreign",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "compose",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("rejects adding a second target to an existing schedule", async () => {
		mocks.existing = stored("application", { applicationId: "app-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "application",
				composeId: "comp-foreign",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("rejects switching a server schedule to the Dokploy host without clearing the server", async () => {
		mocks.existing = stored("server", { serverId: "srv-own" });
		await expect(
			caller().update({
				...base,
				scheduleId: "sch-1",
				scheduleType: "dokploy-server",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it.each([
		["application", { applicationId: "app-own" }],
		["compose", { composeId: "comp-own" }],
		["server", { serverId: "srv-own" }],
		["dokploy-server", {}],
	] as const)("lets a %s schedule be edited without naming its target", async (scheduleType, ids) => {
		mocks.existing = stored(scheduleType, ids);
		await caller().update({ ...base, scheduleId: "sch-1", scheduleType });
		expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
	});

	it("lets an application schedule move to another accessible application", async () => {
		mocks.existing = stored("application", { applicationId: "app-own" });
		await caller().update({
			...base,
			scheduleId: "sch-1",
			scheduleType: "application",
			applicationId: "app-own-2",
		});
		expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
	});

	it("lets the type change when the new target is consistent and in the organization", async () => {
		mocks.existing = stored("application", { applicationId: "app-own" });
		await caller().update({
			...base,
			scheduleId: "sch-1",
			scheduleType: "compose",
			applicationId: null,
			composeId: "comp-own",
		});
		expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
	});

	it("takes the organization from the session, not the request", async () => {
		mocks.existing = stored("dokploy-server");
		await caller().update({
			...base,
			scheduleId: "sch-1",
			scheduleType: "dokploy-server",
			organizationId: "org-2",
		} as never);
		expect(mocks.updateSchedule.mock.calls[0]?.[0]).toMatchObject({
			organizationId: "org-1",
		});
	});
});
