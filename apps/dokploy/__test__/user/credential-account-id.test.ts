import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// better-auth's email sign-in only accepts a credential account whose
// accountId is the user id, so a user created with initial credentials must
// get exactly that, and rows created without it are repaired at startup.

const mocks = vi.hoisted(() => ({
	inserted: [] as { table: unknown; values: Record<string, unknown> }[],
	findFirst: vi.fn(),
	returning: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({ auth: {} }));

vi.mock("bcrypt", () => ({
	hashSync: vi.fn(() => "hashed"),
	compare: vi.fn(),
	hash: vi.fn(),
}));

vi.mock("@dokploy/server/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/db")>();
	const tx = {
		query: { user: { findFirst: mocks.findFirst } },
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				mocks.inserted.push({ table, values });
				return {
					returning: async () => [{ id: "user-1", email: values.email }],
				};
			},
		}),
		update: () => ({ set: () => ({ where: async () => undefined }) }),
	};
	return {
		...actual,
		db: {
			transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
			update: () => ({
				set: mocks.set.mockReturnValue({
					where: mocks.where.mockReturnValue({ returning: mocks.returning }),
				}),
			}),
		},
	};
});

const { createOrganizationUserWithCredentials, repairCredentialAccountIds } =
	await import("@dokploy/server/services/user");
const { account } = await import("@dokploy/server/db/schema");

const dialect = new PgDialect();

beforeEach(() => {
	vi.clearAllMocks();
	mocks.inserted.length = 0;
	mocks.findFirst.mockResolvedValue(undefined);
});

describe("createOrganizationUserWithCredentials", () => {
	it("gives the credential account the user id as accountId", async () => {
		const created = await createOrganizationUserWithCredentials({
			organizationId: "org-1",
			email: "New.User@Example.com",
			password: "correct horse battery",
			role: "member",
		});

		expect(created.userId).toBe("user-1");
		const credential = mocks.inserted.find((i) => i.table === account);
		expect(credential?.values).toMatchObject({
			userId: "user-1",
			accountId: "user-1",
			providerId: "credential",
			password: "hashed",
		});
	});
});

describe("repairCredentialAccountIds", () => {
	it("only touches credential accounts whose accountId differs from the user id", async () => {
		mocks.returning.mockResolvedValue([{ id: "a" }, { id: "b" }]);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(repairCredentialAccountIds()).resolves.toBe(2);

		const set = dialect.sqlToQuery(mocks.set.mock.calls[0][0].accountId);
		expect(set.sql).toBe('"account"."user_id"');
		const where = dialect.sqlToQuery(mocks.where.mock.calls[0][0]);
		expect(where.sql).toBe(
			'("account"."provider_id" = $1 and "account"."account_id" <> "account"."user_id")',
		);
		expect(where.params).toEqual(["credential"]);
		expect(log).toHaveBeenCalledTimes(1);
		log.mockRestore();
	});

	it("is silent and returns 0 when nothing needs repair", async () => {
		mocks.returning.mockResolvedValue([]);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(repairCredentialAccountIds()).resolves.toBe(0);
		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
	});

	it("rejects on a database failure so the startup call can log it", async () => {
		mocks.returning.mockRejectedValue(new Error("db down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Same shape as the call in server.ts: a failure only logs.
		await repairCredentialAccountIds().catch((e) => {
			console.error("Failed to repair credential accounts:", e);
		});
		expect(error).toHaveBeenCalledTimes(1);
		error.mockRestore();
	});
});
