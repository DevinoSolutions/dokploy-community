import { destinations } from "@dokploy/server/db/schema";
import { getTableColumns } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `user.getBackups` (instance backups, admin only) used to load the destination
 * whole and the user's API keys. Its one consumer, the instance backup list,
 * reads the backups only.
 */

const mocks = vi.hoisted(() => ({ findMember: vi.fn() }));

vi.mock("@dokploy/server/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/db")>();
	return {
		...actual,
		db: {
			...actual.db,
			query: { ...actual.db.query, member: { findFirst: mocks.findMember } },
		},
	};
});

const { userRouter } = await import("@/server/api/routers/user");

const caller = userRouter.createCaller({
	user: { id: "user-1", email: "u@example.com", role: "admin" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

type Config = {
	with?: {
		user?: {
			with?: {
				backups?: {
					with?: { destination?: { columns?: Record<string, boolean> } | true };
				};
				apiKeys?: unknown;
			};
		};
	};
};

beforeEach(() => {
	mocks.findMember.mockReset();
	mocks.findMember.mockResolvedValue({ user: { id: "user-1", backups: [] } });
});

describe("user.getBackups", () => {
	it("does not load the user's API keys", async () => {
		await caller.getBackups();

		const config = mocks.findMember.mock.calls[0]?.[0] as Config;
		expect(config.with?.user?.with).not.toHaveProperty("apiKeys");
	});

	it("loads the destination without its keys, encryption passwords or rclone flags", async () => {
		await caller.getBackups();

		const config = mocks.findMember.mock.calls[0]?.[0] as Config;
		const destination = config.with?.user?.with?.backups?.with?.destination;
		const all = Object.keys(getTableColumns(destinations));
		const columns = destination === true ? undefined : destination?.columns;
		const wanted = Object.entries(columns ?? {}).filter(([, on]) => on);
		const loaded = !columns
			? all
			: wanted.length > 0
				? wanted.map(([key]) => key)
				: all.filter((key) => columns[key] !== false);

		for (const column of [
			"accessKey",
			"secretAccessKey",
			"encryptionKey",
			"encryptionPassword2",
			"additionalFlags",
		]) {
			expect(loaded).not.toContain(column);
		}
		expect(loaded).toEqual(expect.arrayContaining(["destinationId", "name"]));
	});
});
