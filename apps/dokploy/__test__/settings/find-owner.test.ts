import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// findOwner is the owner of the root organization, or the oldest owner when
// there is none, so the settings toggle and a restart attribute the web server
// Docker cleanup to the same organization.

const mocks = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	memberFindFirst: vi.fn(),
	scheduleDockerCleanup: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		query: {
			organization: { findFirst: mocks.orgFindFirst },
			member: { findFirst: mocks.memberFindFirst },
			backups: { findMany: vi.fn(async () => []) },
		},
	},
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => ({
		enableDockerCleanup: true,
		dockerCleanupCron: "0 4 * * *",
		logCleanupCron: "0 0 * * *",
	})),
}));

vi.mock("@dokploy/server/services/server", () => ({
	getAllServers: vi.fn(async () => []),
}));

vi.mock("@dokploy/server/utils/docker/cleanup-job", () => ({
	WEB_SERVER_CLEANUP_JOB: "docker-cleanup",
	scheduleDockerCleanup: mocks.scheduleDockerCleanup,
}));

vi.mock("@dokploy/server/utils/notifications/docker-cleanup", () => ({
	sendDockerCleanupNotifications: mocks.sendDockerCleanupNotifications,
}));

vi.mock("@dokploy/server/utils/access-log/handler", () => ({
	startLogCleanup: vi.fn(),
}));

vi.mock("@dokploy/server/utils/backups/utils", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/backups/utils")
	>()),
	scheduleBackup: vi.fn(),
}));

import { findOwner } from "@dokploy/server/services/admin";
import { initCronJobs } from "@dokploy/server/utils/backups";

type Row = { id: string; organizationId: string; role: string };

const dialect = new PgDialect();

// Two organizations, each with an owner; the second one's owner is older, so
// an unordered lookup (or one ordered by member) could return it.
const OWNERS: Row[] = [
	{ id: "m-b", organizationId: "org-b", role: "owner" },
	{ id: "m-a", organizationId: "org-a", role: "owner" },
];

// The member query: filtered by the params of its where clause, and in the
// order the caller asked for (the mock returns the first row of `rows`, which
// is how a database ordered by created_at would answer).
const members = (rows: Row[]) =>
	mocks.memberFindFirst.mockImplementation(
		async (query: {
			where: Parameters<PgDialect["sqlToQuery"]>[0];
			orderBy?: unknown;
		}) => {
			const { params } = dialect.sqlToQuery(query.where);
			const matching = rows.filter(
				(row) =>
					params.includes(row.role) &&
					(params.length === 1 || params.includes(row.organizationId)),
			);
			return matching[0] ? { ...matching[0], user: { id: "u" } } : undefined;
		},
	);

const organizations = (id: string | null) =>
	mocks.orgFindFirst.mockResolvedValue(id ? { id, name: id } : undefined);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("findOwner", () => {
	it("is the owner of the root organization on a multi-organization instance", async () => {
		organizations("org-a");
		members(OWNERS);

		await expect(findOwner()).resolves.toMatchObject({
			id: "m-a",
			organizationId: "org-a",
			user: { id: "u" },
		});
	});

	it("orders owners by creation, then id", async () => {
		organizations("org-a");
		members(OWNERS);

		await findOwner();

		const [query] = mocks.memberFindFirst.mock.calls[0] as [
			{ orderBy: (m: unknown, o: unknown) => unknown[] },
		];
		const asc = vi.fn((column: unknown) => column);
		query.orderBy({ createdAt: "createdAt", id: "id" }, { asc });
		expect(asc.mock.calls.map(([column]) => column)).toEqual([
			"createdAt",
			"id",
		]);
	});

	it("falls back to the oldest owner when there is no root organization", async () => {
		organizations(null);
		members(OWNERS);

		await expect(findOwner()).resolves.toMatchObject({ id: "m-b" });
		expect(mocks.memberFindFirst).toHaveBeenCalledTimes(1);
	});

	it("falls back to the oldest owner when the root organization has none", async () => {
		organizations("org-empty");
		members(OWNERS);

		await expect(findOwner()).resolves.toMatchObject({ id: "m-b" });
		expect(mocks.memberFindFirst).toHaveBeenCalledTimes(2);
	});

	it("answers NOT_FOUND when there is no owner at all", async () => {
		organizations(null);
		members([]);

		await expect(findOwner()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Admin not found",
		});
	});
});

describe("web server Docker cleanup attribution", () => {
	it("is the same organization for the settings toggle and a restart", async () => {
		organizations("org-a");
		members(OWNERS);

		// A restart.
		await initCronJobs();
		const restart = mocks.scheduleDockerCleanup.mock.calls[0]?.[0] as {
			afterCleanup: () => Promise<void>;
		};
		await restart.afterCleanup();

		// The toggle registers its job with the same lookup (settings.updateDockerCleanup).
		const { findOwner: toggleFindOwner } = await import(
			"@dokploy/server/services/admin"
		);
		const owner = await toggleFindOwner();

		expect(mocks.sendDockerCleanupNotifications).toHaveBeenCalledWith("org-a");
		expect(owner.organizationId).toBe("org-a");
	});
});
