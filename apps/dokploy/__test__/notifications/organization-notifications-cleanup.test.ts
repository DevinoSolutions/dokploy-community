import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A notification points at its provider row, so the provider row (API key,
 * webhook) outlives the notification when an organization is deleted. The
 * cleanup removes the provider rows of every notification of the organization.
 */

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	deletes: [] as { table: string; bound: unknown[] }[],
	transactions: 0,
}));

const tableName = (table: unknown) => {
	const symbols = Object.getOwnPropertySymbols(table as object);
	const nameSymbol = symbols.find((s) => s.toString().includes("Name"));
	return nameSymbol
		? String((table as Record<symbol, unknown>)[nameSymbol])
		: "unknown";
};

const boundValues = (node: unknown): unknown[] => {
	if (!node || typeof node !== "object") return [];
	if (Array.isArray(node)) return node.flatMap(boundValues);
	const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
	if (Array.isArray(chunks)) return chunks.flatMap(boundValues);
	const value = (node as { value?: unknown }).value;
	if (Array.isArray(value)) return value.flatMap(boundValues);
	return "value" in node ? [value] : [];
};

vi.mock("@dokploy/server/db", () => {
	const executor = {
		select: () => ({ from: () => ({ where: async () => mocks.rows }) }),
		delete: (table: unknown) => ({
			where: async (condition: unknown) => {
				mocks.deletes.push({
					table: tableName(table),
					bound: boundValues(condition),
				});
			},
		}),
	};
	return {
		db: {
			...executor,
			transaction: vi.fn(async (run: (tx: unknown) => unknown) => {
				mocks.transactions++;
				return run(executor);
			}),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

const { removeOrganizationNotifications } = await import(
	"@dokploy/server/services/notification-channels"
);

const row = (overrides: Record<string, unknown>) => ({
	slackId: null,
	telegramId: null,
	discordId: null,
	emailId: null,
	resendId: null,
	gotifyId: null,
	ntfyId: null,
	mattermostId: null,
	customId: null,
	larkId: null,
	pushoverId: null,
	teamsId: null,
	sendlyId: null,
	notiflyId: null,
	uptimelyChannelId: null,
	...overrides,
});

beforeEach(() => {
	mocks.rows = [];
	mocks.deletes = [];
	mocks.transactions = 0;
});

describe("removeOrganizationNotifications", () => {
	it("deletes the notifications, then the notifly, sendly and uptimely channel rows", async () => {
		mocks.rows = [
			row({ sendlyId: "s-1" }),
			row({ sendlyId: "s-2" }),
			row({ notiflyId: "n-1" }),
			row({ uptimelyChannelId: "u-1" }),
			row({ slackId: "sl-1" }),
		];

		await expect(removeOrganizationNotifications("org-1")).resolves.toBe(5);

		const byTable = Object.fromEntries(
			mocks.deletes.map((d) => [d.table, d.bound]),
		);
		expect(mocks.deletes[0]?.table).toBe("notification");
		expect(byTable.sendly).toEqual(["s-1", "s-2"]);
		expect(byTable.notifly).toEqual(["n-1"]);
		expect(byTable.uptimely_channel).toEqual(["u-1"]);
		expect(byTable.slack).toEqual(["sl-1"]);
		// Providers nobody uses are not touched.
		expect(byTable.telegram).toBeUndefined();
	});

	it("does nothing for an organization without notifications", async () => {
		await expect(removeOrganizationNotifications("org-1")).resolves.toBe(0);
		expect(mocks.deletes).toEqual([]);
	});

	it("runs on the given transaction handle", async () => {
		mocks.rows = [row({ sendlyId: "s-1" })];
		const { db } = await import("@dokploy/server/db");

		await db.transaction(async (tx) => {
			await removeOrganizationNotifications("org-1", tx as never);
		});

		expect(mocks.transactions).toBe(1);
		expect(mocks.deletes.map((d) => d.table)).toEqual([
			"notification",
			"sendly",
		]);
	});
});
