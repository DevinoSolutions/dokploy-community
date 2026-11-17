import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretComposeRow } from "../env-keys/fixtures";

/**
 * `compose.one` returns the compose with its backups. A compose backup's
 * `metadata` holds database credentials, so (like `backup.one`) only a caller
 * who may update the service's backups reads them. The destination of each
 * backup is covered by service-finder-destination.test.ts.
 */

const state = vi.hoisted(() => ({ compose: null as unknown }));
const mocks = vi.hoisted(() => ({ checkServicePermissionAndAccess: vi.fn() }));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkServiceAccess: vi.fn(async () => undefined),
		checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	};
});

vi.mock("@dokploy/server/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/index")>();
	return { ...actual, findComposeById: vi.fn(async () => state.compose) };
});

vi.mock("@dokploy/server/services/git-provider", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/git-provider")
		>();
	return { ...actual, canEditDeployGitSource: vi.fn(async () => true) };
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "u@example.com", role: "owner", ownerId: "o" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

const metadataOf = (result: { backups: Array<{ metadata?: unknown }> }) =>
	result.backups[0]?.metadata;

beforeEach(() => {
	state.compose = secretComposeRow();
	mocks.checkServicePermissionAndAccess.mockReset();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
});

describe("compose.one backup metadata", () => {
	it("is returned to a caller who may update the service's backups", async () => {
		const result = await caller.compose.one({ composeId: "comp-1" });

		expect(metadataOf(result)).toEqual({
			mariadb: { databaseUser: "u", databasePassword: "SECRET-meta-pass" },
			mysql: { databaseRootPassword: "SECRET-meta-root" },
		});
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"comp-1",
			{ backup: ["update"] },
		);
	});

	it("is blanked for a caller who may only read", async () => {
		mocks.checkServicePermissionAndAccess.mockRejectedValue(new Error("no"));

		const result = await caller.compose.one({ composeId: "comp-1" });

		expect(JSON.stringify(result.backups)).not.toContain("SECRET-meta-");
		expect(metadataOf(result)).toEqual({
			mariadb: { databaseUser: "u", databasePassword: "" },
			mysql: { databaseRootPassword: "" },
		});
		// What the backups list needs is still there.
		expect(result.backups[0]).toMatchObject({
			backupId: "bk-1",
			schedule: "0 0 * * *",
		});
	});
});
