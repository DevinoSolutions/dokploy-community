import { fileURLToPath } from "node:url";
import { apiKey } from "@better-auth/api-key";
import * as schema from "@dokploy/server/db/schema";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * better-auth enforces per-key rate limits, key quotas and single-use 2FA
 * backup codes with a guarded `incrementOne`: the update may only apply while
 * a condition still holds (`requestCount < max`, `backupCodes = <old>`), so
 * concurrent requests cannot all win.
 *
 * On Postgres, @better-auth/drizzle-adapter 1.6.23 put those guards only in an
 * `id IN (subquery)`. A request that waits on the row lock is rechecked against
 * the new row version, but the subquery is not, so every waiting request won.
 * The fork patches the adapter (patches/@better-auth__drizzle-adapter@1.6.23.patch)
 * to repeat the guards on the outer WHERE. These tests pin that behaviour.
 *
 * They need a real Postgres. Set DOKPLOY_PG_RACE_ADMIN_URL to a superuser URL
 * (e.g. postgres://postgres:pw@127.0.0.1:55432/postgres); the suite creates a
 * throwaway database, migrates it and drops it afterwards. Skipped otherwise.
 */
const adminUrl = process.env.DOKPLOY_PG_RACE_ADMIN_URL;

const WAITERS = 12;
const USER_ID = "race-user";
const KEY_ID = "race-key";
const TWO_FACTOR_ID = "race-2fa";

describe.skipIf(!adminUrl)("better-auth guarded increments on Postgres", () => {
	const dbName = `dokploy_guard_race_${process.pid}_${Date.now()}`;
	let admin: postgres.Sql;
	let sql: postgres.Sql;
	let db: ReturnType<typeof drizzle<typeof schema>>;
	let adapter: {
		incrementOne: (input: {
			model: string;
			where: {
				field: string;
				value: unknown;
				operator?: "lt" | "gt" | "lte" | "eq";
			}[];
			increment: Record<string, number>;
			set?: Record<string, unknown>;
		}) => Promise<Record<string, unknown> | null>;
	};

	beforeAll(async () => {
		admin = postgres(adminUrl as string, { max: 1 });
		await admin.unsafe(`CREATE DATABASE "${dbName}"`);
		const url = new URL(adminUrl as string);
		url.pathname = `/${dbName}`;
		sql = postgres(url.toString(), { max: WAITERS + 2, onnotice: () => {} });
		db = drizzle(sql, { schema });
		await migrate(db, {
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle", import.meta.url),
			),
		});
		// Same adapter configuration as packages/server/src/lib/auth.ts.
		adapter = drizzleAdapter(db, { provider: "pg", schema })({
			plugins: [apiKey(), twoFactor()],
		} as never) as unknown as typeof adapter;
	}, 120_000);

	afterAll(async () => {
		await sql?.end({ timeout: 5 });
		await admin?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
		await admin?.end({ timeout: 5 });
	});

	beforeEach(async () => {
		await db.delete(schema.user);
		const now = new Date();
		await db.insert(schema.user).values({
			id: USER_ID,
			email: "race@example.com",
			emailVerified: true,
			updatedAt: now,
		});
		await db.insert(schema.apikey).values({
			id: KEY_ID,
			key: "hashed",
			referenceId: USER_ID,
			rateLimitEnabled: true,
			rateLimitTimeWindow: 60_000,
			rateLimitMax: 5,
			requestCount: 1,
			lastRequest: now,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.twoFactor).values({
			id: TWO_FACTOR_ID,
			secret: "s",
			backupCodes: "codes-v1",
			userId: USER_ID,
		});
	});

	/** The api-key plugin's in-window rate-limit claim (consumeRateLimit). */
	const claimRateLimitSlot = () =>
		adapter.incrementOne({
			model: "apikey",
			where: [
				{ field: "id", value: KEY_ID },
				{
					field: "lastRequest",
					operator: "gt",
					value: new Date(Date.now() - 60_000),
				},
				{ field: "requestCount", operator: "lt", value: 5 },
			],
			increment: { requestCount: 1 },
			set: { lastRequest: new Date() },
		});

	/** The two-factor plugin's backup-code consumption (compare-and-swap). */
	const spendBackupCode = (next: string) =>
		adapter.incrementOne({
			model: "twoFactor",
			where: [
				{ field: "id", value: TWO_FACTOR_ID },
				{ field: "backupCodes", value: "codes-v1" },
			],
			increment: {},
			set: { backupCodes: next },
		});

	/**
	 * Hold the row lock in another transaction, start `claims` while they read
	 * the pre-change row, then commit `change` so every claim must recheck.
	 */
	const raceBehindLock = async <T>(
		table: "apikey" | "two_factor",
		id: string,
		change: string,
		claims: () => Promise<T>[],
	) => {
		const holder = await sql.reserve();
		try {
			await holder.unsafe("BEGIN");
			await holder.unsafe(`UPDATE "${table}" SET ${change} WHERE id = $1`, [
				id,
			]);
			const pending = claims();
			// Commit only once every claim is blocked on the row lock. A claim that
			// arrived after the commit would see the new row and pass for the wrong
			// reason, without exercising the recheck this test is about.
			const deadline = Date.now() + 10_000;
			for (;;) {
				const [{ waiting }] = await sql<{ waiting: number }[]>`
					select count(*)::int as waiting from pg_stat_activity
					where datname = current_database() and wait_event_type = 'Lock'`;
				if (waiting >= pending.length) break;
				if (Date.now() > deadline) {
					throw new Error(
						`only ${waiting}/${pending.length} claims reached the row lock`,
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await holder.unsafe("COMMIT");
			return await Promise.all(pending);
		} finally {
			holder.release();
		}
	};

	it("rejects rate-limit claims that queued behind a request filling the window", async () => {
		const results = await raceBehindLock(
			"apikey",
			KEY_ID,
			"request_count = 5",
			() => Array.from({ length: WAITERS }, claimRateLimitSlot),
		);
		expect(results.filter(Boolean)).toHaveLength(0);
		const [row] =
			await sql`select request_count from apikey where id = ${KEY_ID}`;
		expect(row?.request_count).toBe(5);
	});

	it("never lets a burst push the request count past the max", async () => {
		const results = await Promise.all(
			Array.from({ length: WAITERS * 2 }, claimRateLimitSlot),
		);
		expect(results.filter(Boolean)).toHaveLength(4);
		const [row] =
			await sql`select request_count from apikey where id = ${KEY_ID}`;
		expect(row?.request_count).toBe(5);
	});

	it("spends a backup code at most once under concurrent sign-ins", async () => {
		const results = await Promise.all(
			Array.from({ length: WAITERS }, (_, i) =>
				spendBackupCode(`codes-v2-${i}`),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it("rejects backup-code claims that queued behind one already spent", async () => {
		const results = await raceBehindLock(
			"two_factor",
			TWO_FACTOR_ID,
			"backup_codes = 'codes-v2-other'",
			() =>
				Array.from({ length: WAITERS }, (_, i) => spendBackupCode(`late-${i}`)),
		);
		expect(results.filter(Boolean)).toHaveLength(0);
		const [row] =
			await sql`select backup_codes from two_factor where id = ${TWO_FACTOR_ID}`;
		expect(row?.backup_codes).toBe("codes-v2-other");
	});

	it("still applies an uncontended claim", async () => {
		expect(await claimRateLimitSlot()).toMatchObject({ requestCount: 2 });
		expect(await spendBackupCode("codes-v2")).toMatchObject({
			backupCodes: "codes-v2",
		});
	});
});
