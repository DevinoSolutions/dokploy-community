import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A dokploy-server schedule runs inside the Dokploy process, which holds the
 * docker socket and the instance's files. It belongs to the organization that
 * owns the instance (the first one created), whatever the caller's role.
 * Server, application and compose schedules are not affected.
 */

const mocks = vi.hoisted(() => ({
	rootOrganization: "org-1",
	existing: null as Record<string, unknown> | null,
	createSchedule: vi.fn(),
	updateSchedule: vi.fn(),
	deleteSchedule: vi.fn(),
	runCommand: vi.fn(),
	findMany: vi.fn(),
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
								organizationId: "org-2",
								role: "admin",
								accessedServices: [],
								accessedProjects: [],
								accessedEnvironments: [],
								user: { id: "user-1" },
							})),
							findMany: vi.fn(async () => []),
						};
					}
					if (table === "schedules") {
						return { findFirst: vi.fn(), findMany: mocks.findMany };
					}
					return tableMock();
				},
			}),
			execute: vi.fn(async () => []),
			select: vi.fn(() => chain()),
			insert: vi.fn(() => chain()),
			update: vi.fn(() => chain()),
			delete: vi.fn(() => chain()),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/services/schedule", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findScheduleById: vi.fn(async () => mocks.existing),
	createSchedule: mocks.createSchedule,
	updateSchedule: mocks.updateSchedule,
	deleteSchedule: mocks.deleteSchedule,
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: vi.fn(async (serverId: string) => ({
		serverId,
		organizationId: "org-2",
	})),
}));

vi.mock("@dokploy/server/services/admin", async (importOriginal) => ({
	...(await importOriginal<object>()),
	isRootOrganization: vi.fn(
		async (organizationId: string) => organizationId === mocks.rootOrganization,
	),
}));

vi.mock("@dokploy/server/index", async (importOriginal) => ({
	...(await importOriginal<object>()),
	runCommand: mocks.runCommand,
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { scheduleRouter } = await import("@/server/api/routers/schedule");
const { createCallerFactory } = await import("@/server/api/trpc");
const { isRootOrganization } = await import("@dokploy/server/services/admin");

// The caller is an admin of org-2.
const caller = () =>
	createCallerFactory(scheduleRouter)({
		user: { id: "user-1", email: "admin@test.com", role: "admin" },
		session: { activeOrganizationId: "org-2" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const schedule = (
	scheduleType: string,
	extra: Record<string, unknown> = {},
) => ({
	scheduleId: "sch-1",
	scheduleType,
	appName: "schedule-run-fast-bus-AbC123",
	applicationId: null,
	composeId: null,
	serverId: null,
	organizationId: scheduleType === "dokploy-server" ? "org-2" : null,
	cronExpression: "0 0 * * *",
	enabled: false,
	...extra,
});

const base = {
	name: "Nightly",
	cronExpression: "0 0 * * *",
	command: "echo hi",
	shellType: "bash" as const,
	enabled: false,
	scheduleId: "sch-1",
};

type Caller = ReturnType<typeof caller>;
const hostRoutes: [string, (c: Caller) => Promise<unknown>, () => unknown][] = [
	[
		"create",
		(c) => c.create({ ...base, scheduleType: "dokploy-server" }),
		() => mocks.createSchedule,
	],
	[
		"update",
		(c) => c.update({ ...base, scheduleType: "dokploy-server" }),
		() => mocks.updateSchedule,
	],
	[
		"delete",
		(c) => c.delete({ scheduleId: "sch-1" }),
		() => mocks.deleteSchedule,
	],
	[
		"runManually",
		(c) => c.runManually({ scheduleId: "sch-1" }),
		() => mocks.runCommand,
	],
	[
		"list",
		(c) => c.list({ id: "org-2", scheduleType: "dokploy-server" }),
		() => mocks.findMany,
	],
	// Reading has no effect to watch; the schedule is loaded either way.
	["one", (c) => c.one({ scheduleId: "sch-1" }), () => null],
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rootOrganization = "org-1";
	mocks.existing = schedule("dokploy-server");
	mocks.createSchedule.mockResolvedValue(schedule("dokploy-server"));
	mocks.updateSchedule.mockResolvedValue({
		scheduleId: "sch-1",
		name: "Nightly",
		enabled: false,
		cronExpression: "0 0 * * *",
	});
	mocks.findMany.mockResolvedValue([]);
	mocks.runCommand.mockResolvedValue({
		status: "done",
		deploymentId: "dep-1",
		logPath: "/tmp/x.log",
	});
});

describe("host schedules belong to the organization that owns the instance", () => {
	it.each(hostRoutes)(
		"%s refuses an admin of another organization",
		async (_name, run, effect) => {
			await expect(run(caller())).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owns this Dokploy instance"),
			});
			const watched = effect();
			if (watched) expect(watched).not.toHaveBeenCalled();
		},
	);

	it.each(hostRoutes)(
		"%s says so when the pinned id matches no organization",
		async (_name, run) => {
			vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-gone");
			try {
				await expect(run(caller())).rejects.toMatchObject({
					code: "FORBIDDEN",
					message: expect.stringContaining("DOKPLOY_ROOT_ORGANIZATION_ID"),
				});
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it.each(hostRoutes)(
		"%s lets the organization that owns the instance through",
		async (_name, run, effect) => {
			mocks.rootOrganization = "org-2";
			await run(caller());
			const watched = effect();
			if (watched) expect(watched).toHaveBeenCalled();
		},
	);

	it("lists every host schedule for the organization that owns the instance, and deletes a leftover one", async () => {
		mocks.rootOrganization = "org-2";
		mocks.existing = schedule("dokploy-server", { organizationId: "org-3" });

		await caller().list({ id: "org-2", scheduleType: "dokploy-server" });
		await caller().delete({ scheduleId: "sch-1" });

		expect(mocks.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.deleteSchedule).toHaveBeenCalledTimes(1);
	});

	it("does not let the organization that owns the instance edit or run a leftover one", async () => {
		mocks.rootOrganization = "org-2";
		mocks.existing = schedule("dokploy-server", { organizationId: "org-3" });

		await expect(
			caller().update({ ...base, scheduleType: "dokploy-server" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().runManually({ scheduleId: "sch-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
		expect(mocks.runCommand).not.toHaveBeenCalled();
	});

	it("refuses an update that turns another kind of schedule into a host schedule", async () => {
		mocks.existing = schedule("server", { serverId: "srv-1" });
		await expect(
			caller().update({
				...base,
				scheduleType: "dokploy-server",
				serverId: null,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateSchedule).not.toHaveBeenCalled();
	});

	it("leaves a server schedule of the caller's organization alone", async () => {
		mocks.existing = schedule("server", { serverId: "srv-1" });
		await caller().runManually({ scheduleId: "sch-1" });
		expect(mocks.runCommand).toHaveBeenCalledTimes(1);
		expect(isRootOrganization).not.toHaveBeenCalled();
	});

	it.each([
		["application", { applicationId: "app-1" }],
		["compose", { composeId: "comp-1" }],
	] as const)(
		"does not ask about the instance for a %s schedule",
		async (scheduleType, ids) => {
			mocks.existing = schedule(scheduleType, ids);
			await caller()
				.runManually({ scheduleId: "sch-1" })
				.catch(() => undefined);
			expect(isRootOrganization).not.toHaveBeenCalled();
		},
	);
});
