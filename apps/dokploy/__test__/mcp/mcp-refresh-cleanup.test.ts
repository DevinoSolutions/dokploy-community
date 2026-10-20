import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const { hashOAuthToken } = await import("@dokploy/server/services/mcp-oauth");
const { cleanupAfterMcpTokenGrant, deleteSupersededMcpAccessTokens } =
	await import("@dokploy/server/services/mcp-refresh-cleanup");

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the two token tables. The service's WHERE clauses
 * are rendered to SQL and evaluated against the rows, so the tests check what
 * the queries would match, not how they are written. Anything the evaluator
 * does not understand throws instead of matching nothing.
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
		const [, table, column, op, index] = match;
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

const toColumns = (row: Row) => ({
	id: row.id,
	clientId: row.client_id,
	userId: row.user_id,
	refreshId: row.refresh_id,
	rotatedAt: row.rotated_at,
});

const findFirst = vi.mocked(db.query.oauthAccessToken.findFirst);
const dbDelete = vi.mocked(db.delete);

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
) => ({
	id,
	token: hashOAuthToken(token),
	client_id: clientId,
	user_id: userId,
	refresh_id: refreshId,
});

const accessIds = () =>
	tables.oauth_provider_access_token?.map((row) => row.id).sort();

beforeEach(() => {
	vi.clearAllMocks();
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
});

describe("deleteSupersededMcpAccessTokens", () => {
	it("deletes the access token of the rotated refresh row", async () => {
		await expect(
			deleteSupersededMcpAccessTokens("refresh-1", "access-2"),
		).resolves.toBe(1);
		expect(accessIds()).toEqual(["A2", "B0", "B1"]);
	});

	it("keeps the newly issued token and other clients' tokens", async () => {
		await deleteSupersededMcpAccessTokens("refresh-1", "access-2");
		const remaining = tables.oauth_provider_access_token ?? [];
		expect(remaining.find((row) => row.id === "A2")).toBeDefined();
		// B0 also hangs off a rotated refresh row, but belongs to another grant.
		expect(
			remaining.filter((row) => row.client_id === "client-b").map((r) => r.id),
		).toEqual(["B0", "B1"]);
	});

	it("never deletes the issued token, even if it points at the consumed row", async () => {
		tables.oauth_provider_access_token?.push(
			accessRow("A3", "access-3", "client-a", "R1"),
		);
		await expect(
			deleteSupersededMcpAccessTokens("refresh-1", "access-3"),
		).resolves.toBe(0);
		expect(accessIds()).toEqual(["A1", "A2", "A3", "B0", "B1"]);
	});

	it("does nothing for a refresh token that was not rotated", async () => {
		await expect(
			deleteSupersededMcpAccessTokens("refresh-2", "access-2"),
		).resolves.toBe(0);
		expect(dbDelete).not.toHaveBeenCalled();
	});

	it("does nothing when the issued token belongs to another client or user", async () => {
		await expect(
			deleteSupersededMcpAccessTokens("refresh-1", "access-b1"),
		).resolves.toBe(0);
		tables.oauth_provider_access_token?.push(
			accessRow("U2", "access-u2", "client-a", "R2", "user-2"),
		);
		await expect(
			deleteSupersededMcpAccessTokens("refresh-1", "access-u2"),
		).resolves.toBe(0);
		expect(dbDelete).not.toHaveBeenCalled();
	});

	it("does nothing for unknown tokens", async () => {
		await expect(
			deleteSupersededMcpAccessTokens("unknown", "access-2"),
		).resolves.toBe(0);
		await expect(
			deleteSupersededMcpAccessTokens("refresh-1", "unknown"),
		).resolves.toBe(0);
		expect(accessIds()).toEqual(["A1", "A2", "B0", "B1"]);
	});
});

describe("cleanupAfterMcpTokenGrant", () => {
	const refreshBody = { grant_type: "refresh_token", refresh_token: "refresh-1" };

	it("removes the superseded token after a successful refresh", async () => {
		await cleanupAfterMcpTokenGrant(refreshBody, {
			access_token: "access-2",
			refresh_token: "refresh-2",
		});
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
	});

	it("logs a failure instead of throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		findFirst.mockRejectedValueOnce(new Error("db down"));
		await expect(
			cleanupAfterMcpTokenGrant(refreshBody, { access_token: "access-2" }),
		).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith(
			"[mcp] failed to delete superseded access tokens",
			expect.any(Error),
		);
		error.mockRestore();
	});
});
