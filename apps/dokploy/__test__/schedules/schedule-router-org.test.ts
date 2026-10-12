import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A dokploy-server schedule runs on the Dokploy host and has no service or
 * server to scope it by: its organizationId is the only thing tying it to a
 * caller. Every procedure that loads one by id must compare it with the
 * caller's active organization, and the organizationId must follow the
 * schedule type when it changes.
 */

const mocks = vi.hoisted(() => ({
	memberRole: "admin" as string,
	existing: null as Record<string, unknown> | null,
	createSchedule: vi.fn(),
	updateSchedule: vi.fn(),
	deleteSchedule: vi.fn(),
	runCommand: vi.fn(),
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
		organizationId: "org-1",
	})),
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

const caller = () =>
	createCallerFactory(scheduleRouter)({
		user: { id: "user-1", email: "admin@test.com", role: "admin" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const hostSchedule = (organizationId: string | null) => ({
	scheduleId: "sch-1",
	scheduleType: "dokploy-server",
	appName: "schedule-run-fast-bus-AbC123",
	applicationId: null,
	composeId: null,
	serverId: null,
	organizationId,
	cronExpression: "0 0 * * *",
	enabled: false,
});

const base = {
	name: "Nightly",
	cronExpression: "0 0 * * *",
	command: "echo hi",
	shellType: "bash" as const,
	enabled: false,
	scheduleId: "sch-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.memberRole = "admin";
	mocks.existing = null;
	mocks.updateSchedule.mockResolvedValue({
		scheduleId: "sch-1",
		name: "Nightly",
		enabled: false,
		cronExpression: "0 0 * * *",
	});
	mocks.runCommand.mockResolvedValue({
		status: "done",
		deploymentId: "dep-1",
		logPath: "/tmp/x.log",
	});
});

describe("dokploy-server schedules belong to one organization", () => {
	it.each([
		["another organization", "org-2"],
		["no organization", null],
	])("rejects every procedure for a schedule owned by %s", async (_label, organizationId) => {
		mocks.existing = hostSchedule(organizationId);

		await expect(
			caller().update({ ...base, scheduleType: "dokploy-server" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().delete({ scheduleId: "sch-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().one({ scheduleId: "sch-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller().runManually({ scheduleId: "sch-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.updateSchedule).not.toHaveBeenCalled();
		expect(mocks.deleteSchedule).not.toHaveBeenCalled();
		expect(mocks.runCommand).not.toHaveBeenCalled();
	});

	it("allows the same procedures for a schedule of the active organization", async () => {
		mocks.existing = hostSchedule("org-1");

		await caller().update({ ...base, scheduleType: "dokploy-server" });
		await caller().delete({ scheduleId: "sch-1" });
		await caller().one({ scheduleId: "sch-1" });
		await caller().runManually({ scheduleId: "sch-1" });

		expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
		expect(mocks.deleteSchedule).toHaveBeenCalledTimes(1);
		expect(mocks.runCommand).toHaveBeenCalledTimes(1);
	});

	it("keeps the script of a host schedule from members", async () => {
		mocks.memberRole = "member";
		mocks.existing = hostSchedule("org-1");
		await expect(
			caller().one({ scheduleId: "sch-1" }),
		).rejects.toBeDefined();
	});
});

describe("organizationId follows the schedule type", () => {
	it("is set from the session when a schedule becomes dokploy-server", async () => {
		mocks.existing = {
			...hostSchedule(null),
			scheduleType: "server",
			serverId: "srv-1",
		};
		await caller().update({
			...base,
			scheduleType: "dokploy-server",
			serverId: null,
		});
		expect(mocks.updateSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});

	it("is cleared when a schedule stops being dokploy-server", async () => {
		mocks.existing = hostSchedule("org-1");
		await caller().update({
			...base,
			scheduleType: "server",
			serverId: "srv-1",
		});
		expect(mocks.updateSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("leaves a schedule that was never dokploy-server alone", async () => {
		mocks.existing = {
			...hostSchedule(null),
			scheduleType: "server",
			serverId: "srv-1",
		};
		await caller().update({ ...base, scheduleType: "server" });
		expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
		expect(mocks.updateSchedule.mock.calls[0]?.[0]).not.toHaveProperty(
			"organizationId",
		);
	});
});
