import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const { hashOAuthToken } = await import("@dokploy/server/services/mcp-oauth");
const { cleanupAfterMcpTokenGrant, retireSupersededMcpAccessTokens } =
	await import("@dokploy/server/services/mcp-refresh-cleanup");

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the two token tables. The service's WHERE clauses
 * and the expiry clamp are rendered to SQL and evaluated against the rows, so
 * the tests check what the queries would do, not how they are written.
 * Anything the evaluator does not understand throws instead of matching
 * nothing.
 */
const tables: Record<string, Row[]> = {
	oauth_refresh_token: [],
	oauth_provider_access_token: [],
};

const dialect = new PgDialect();
const PREDICATE = /^"(\w+)"\."(\w+)" (=|<>) \$(\d+)$/;

const evaluate = (where: SQL) => {
	const { sql, params } = dialect.sqlToQuery(where);
	const body = sql.replace(/^\((.*)\)$/, "$1");
	const predicates = body.split(" and ").map((part) => {
		const match = PREDICATE.exec(part);
		if (!match) throw new Error(`unsupported predicate: ${part}`);
		const [, table = "", column = "", op, index] = match;
		return { table, column, op, value: params[Number(index) - 1] };
	});
	const table = predicates[0]?.table ?? "";
	if (!tables[table] || predicates.some((p) => p.table !== table)) {
		throw new Error(`unsupported query: ${sql}`);
	}
	const matches = (row: Row) =>
		predicates.every((p) =>
			p.op === "=" ? row[p.column] === p.value : row[p.column] !== p.value,
		);
	return { table, matches };
};

const CLAMP =
	/^LEAST\("oauth_provider_access_token"\."expires_at", \$1::timestamp\)$/;

/** Applies `set({ expiresAt: LEAST(expires_at, $1::timestamp) })` to a row. */
const applySet = (values: Record<string, unknown>, row: Row) => {
	const keys = Object.keys(values);
	if (keys.length !== 1 || keys[0] !== "expiresAt") {
		throw new Error(`unsupported set: ${keys.join(", ")}`);
	}
	const { sql, params } = dialect.sqlToQuery(values.expiresAt as SQL);
	const until = params[0];
	// The driver only accepts a string here (see "never hands a Date").
	if (!CLAMP.test(sql) || typeof until !== "string") {
		throw new Error(`unsupported set: ${sql}`);
	}
	const untilMs = new Date(until).getTime();
	if (Number.isNaN(untilMs)) throw new Error(`unparsable timestamp: ${until}`);
	const current = row.expires_at as Date;
	if (untilMs < current.getTime()) row.expires_at = new Date(untilMs);
};

const toColumns = (row: Row) => ({
	id: row.id,
	clientId: row.client_id,
	userId: row.user_id,
	refreshId: row.refresh_id,
	rotatedAt: row.rotated_at,
});

const findFirst = vi.mocked(db.query.oauthAccessToken.findFirst);
const dbDelete = vi.mocked(db.delete);
const dbUpdate = vi.mocked(db.update);

const NOW = new Date("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;

const refreshRow = (
	id: string,
	token: string,
	clientId: string,
	rotated: boolean,
) => ({
	id,
	token: hashOAuthToken(token),
	client_id: clientId,
	user_id: "user-1",
	rotated_at: rotated ? new Date() : null,
});

const accessRow = (
	id: string,
	token: string,
	clientId: string,
	refreshId: string,
	userId = "user-1",
	expiresAt = new Date(NOW.getTime() + 720 * HOUR),
) => ({
	id,
	token: hashOAuthToken(token),
	client_id: clientId,
	user_id: userId,
	refresh_id: refreshId,
	expires_at: expiresAt,
});

const accessIds = () =>
	tables.oauth_provider_access_token?.map((row) => row.id).sort();

const expiryOf = (id: string) =>
	(
		tables.oauth_provider_access_token?.find((row) => row.id === id)
			?.expires_at as Date | undefined
	)?.toISOString();

const inHours = (hours: number) =>
	new Date(NOW.getTime() + hours * HOUR).toISOString();
const inSeconds = (seconds: number) =>
	new Date(NOW.getTime() + seconds * 1000).toISOString();

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	// Client A refreshed R1 into R2: A1 came with R1, A2 with R2. Client B has
	// its own grant, plus an older rotated row R3 with its access token B0.
	tables.oauth_refresh_token = [
		refreshRow("R1", "refresh-1", "client-a", true),
		refreshRow("R2", "refresh-2", "client-a", false),
		refreshRow("R3", "refresh-3", "client-b", true),
		refreshRow("R4", "refresh-4", "client-b", false),
	];
	tables.oauth_provider_access_token = [
		accessRow("A1", "access-1", "client-a", "R1"),
		accessRow("A2", "access-2", "client-a", "R2"),
		accessRow("B0", "access-b0", "client-b", "R3"),
		accessRow("B1", "access-b1", "client-b", "R4"),
	];

	findFirst.mockImplementation((async (query: { where: SQL }) => {
		const { table, matches } = evaluate(query.where);
		const row = tables[table]?.find(matches);
		return row ? toColumns(row) : undefined;
	}) as never);
	dbDelete.mockImplementation((() => ({
		where: (where: SQL) => ({
			returning: async () => {
				const { table, matches } = evaluate(where);
				const rows = tables[table] ?? [];
				const removed = rows.filter(matches);
				tables[table] = rows.filter((row) => !matches(row));
				return removed.map((row) => ({ id: row.id }));
			},
		}),
	})) as never);
	dbUpdate.mockImplementation((() => ({
		set: (values: Record<string, unknown>) => ({
			where: (where: SQL) => ({
				returning: async () => {
					const { table, matches } = evaluate(where);
					const updated = (tables[table] ?? []).filter(matches);
					for (const row of updated) applySet(values, row);
					return updated.map((row) => ({ id: row.id }));
				},
			}),
		}),
	})) as never);
});

describe("retireSupersededMcpAccessTokens with a grace window", () => {
	it("clamps the old token to the window and keeps every row", async () => {
		await expect(
			retireSupersededMcpAccessTokens("refresh-1", "access-2", 300),
		).resolves.toBe(1);
		expect(dbDelete).not.toHaveBeenCalled();
		expect(accessIds()).toEqual(["A1", "A2", "B0", "B1"]);
		expect(expiryOf("A1")).toBe(inSeconds(300));
	});

	it("leaves the new token and other clients' tokens as they were", async () => {
		await retireSupersededMcpAccessTokens("refresh-1", "access-2", 300);
		expect(expiryOf("A2")).toBe(inHours(720));
		// B0 also hangs off a rotated refresh row, but belongs to another grant.
		expect(expiryOf("B0")).toBe(inHours(720));
		expect(expiryOf("B1")).toBe(inHours(720));
	});

	it("never lengthens an expiry that is already shorter", async () => {
		tables.oauth_provider_access_token = [
			accessRow("A1", "access-1", "client-a", "R1", "user-1", NOW),
			accessRow(
				"A1b",
				"access-1b",
				"client-a",
				"R1",
				"user-1",
				new Date(NOW.getTime() + 60_000),
			),
			accessRow("A2", "access-2", "client-a", "R2"),
		];
		await expect(
			retireSupersededMcpAccessTokens("refresh-1", "access-2", 300),
		).resolves.toBe(2);
		expect(expiryOf("A1")).toBe(NOW.toISOString());
		expect(expiryOf("A1b")).toBe(inSeconds(60));
	});

	// Regression (as c850aeb67 for consumeRotatedRefreshToken): a Date
	// interpolated into the raw `sql` template skips drizzle's column mapping,
	// so postgres-js throws ERR_INVALID_ARG_TYPE and nothing is ever clamped.
	it("never hands a Date to the driver", async () => {
		const set = vi.fn((_values: Record<string, unknown>) => ({
			where: () => ({ returning: async () => [{ id: "A1" }] }),
		}));
		dbUpdate.mockReturnValueOnce({ set } as never);
		await retireSupersededMcpAccessTokens("refresh-1", "access-2", 300);
		expect(set).toHaveBeenCalledTimes(1);
		const values = set.mock.calls[0]?.[0] ?? {};
		const seen = new Set<object>();
		const containsDate = (value: unknown): boolean => {
			if (value instanceof Date) return true;
			if (!value || typeof value !== "object" || seen.has(value)) return false;
			seen.add(value);
			return Object.values(value).some(containsDate);
		};
		expect(containsDate(values)).toBe(false);
		const { params } = dialect.sqlToQuery(values.expiresAt as SQL);
		expect(params.some((param) => param instanceof Date)).toBe(false);
		expect(params).toEqual([inSeconds(300)]);
	});

	it("uses DOKPLOY_MCP_REFRESH_GRACE_SECONDS (300 by default)", async () => {
		await retireSupersededMcpAccessTokens("refresh-1", "access-2");
		expect(expiryOf("A1")).toBe(inSeconds(300));
	});
});

describe("retireSupersededMcpAccessTokens with no grace window", () => {
	it("deletes the access token of the rotated refresh row", async () => {
		await expect(
			retireSupersededMcpAccessTokens("refresh-1", "access-2", 0),
		).resolves.toBe(1);
		expect(dbUpdate).not.toHaveBeenCalled();
		expect(accessIds()).toEqual(["A2", "B0", "B1"]);
	});

	it("keeps the newly issued token and other clients' tokens", async () => {
		await retireSupersededMcpAccessTokens("refresh-1", "access-2", 0);
		const remaining = tables.oauth_provider_access_token ?? [];
		expect(remaining.find((row) => row.id === "A2")).toBeDefined();
		expect(
			remaining.filter((row) => row.client_id === "client-b").map((r) => r.id),
		).toEqual(["B0", "B1"]);
	});
});

describe("retireSupersededMcpAccessTokens guards", () => {
	it.each([0, 300])(
		"never touches the issued token, even if it points at the consumed row (grace %s)",
		async (grace) => {
			tables.oauth_provider_access_token?.push(
				accessRow("A3", "access-3", "client-a", "R1"),
			);
			await expect(
				retireSupersededMcpAccessTokens("refresh-1", "access-3", grace),
			).resolves.toBe(0);
			expect(accessIds()).toEqual(["A1", "A2", "A3", "B0", "B1"]);
			expect(expiryOf("A1")).toBe(inHours(720));
		},
	);

	it("does nothing for a refresh token that was not rotated", async () => {
		await expect(
			retireSupersededMcpAccessTokens("refresh-2", "access-2", 300),
		).resolves.toBe(0);
		expect(dbUpdate).not.toHaveBeenCalled();
		expect(dbDelete).not.toHaveBeenCalled();
	});

	it("does nothing when the issued token belongs to another client or user", async () => {
		await expect(
			retireSupersededMcpAccessTokens("refresh-1", "access-b1", 300),
		).resolves.toBe(0);
		tables.oauth_provider_access_token?.push(
			accessRow("U2", "access-u2", "client-a", "R2", "user-2"),
		);
		await expect(
			retireSupersededMcpAccessTokens("refresh-1", "access-u2", 0),
		).resolves.toBe(0);
		expect(dbUpdate).not.toHaveBeenCalled();
		expect(dbDelete).not.toHaveBeenCalled();
	});

	it("does nothing for unknown tokens", async () => {
		await expect(
			retireSupersededMcpAccessTokens("unknown", "access-2", 300),
		).resolves.toBe(0);
		await expect(
			retireSupersededMcpAccessTokens("refresh-1", "unknown", 300),
		).resolves.toBe(0);
		expect(accessIds()).toEqual(["A1", "A2", "B0", "B1"]);
		expect(expiryOf("A1")).toBe(inHours(720));
	});
});

describe("cleanupAfterMcpTokenGrant", () => {
	const refreshBody = {
		grant_type: "refresh_token",
		refresh_token: "refresh-1",
	};
	const refreshed = { access_token: "access-2", refresh_token: "refresh-2" };

	it("clamps the superseded token after a successful refresh", async () => {
		await cleanupAfterMcpTokenGrant(refreshBody, refreshed, 300);
		expect(accessIds()).toEqual(["A1", "A2", "B0", "B1"]);
		expect(expiryOf("A1")).toBe(inSeconds(300));
	});

	it("deletes the superseded token when the grace window is 0", async () => {
		await cleanupAfterMcpTokenGrant(refreshBody, refreshed, 0);
		expect(accessIds()).toEqual(["A2", "B0", "B1"]);
	});

	it("ignores other grants and failed responses", async () => {
		await cleanupAfterMcpTokenGrant(
			{ grant_type: "authorization_code", code: "c" },
			{ access_token: "access-2" },
		);
		await cleanupAfterMcpTokenGrant(refreshBody, {
			error: "invalid_grant",
		});
		await cleanupAfterMcpTokenGrant(refreshBody, undefined);
		expect(findFirst).not.toHaveBeenCalled();
		expect(accessIds()).toEqual(["A1", "A2", "B0", "B1"]);
		expect(expiryOf("A1")).toBe(inHours(720));
	});

	it("logs a failure instead of throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		findFirst.mockRejectedValueOnce(new Error("db down"));
		await expect(
			cleanupAfterMcpTokenGrant(refreshBody, { access_token: "access-2" }),
		).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith(
			"[mcp] failed to retire superseded access tokens",
			expect.any(Error),
		);
		error.mockRestore();
	});
});
