import { describe, expect, it, vi } from "vitest";

const {
	getScimCredentialHashSecret,
	reconcileScimLifecycle,
	reconcileScimMembership,
	SCIM_DEPROVISIONED_BAN_REASON,
} = await import("@dokploy/server/services/proprietary/scim");

type Where = { field: string; value: unknown }[];

/**
 * In-memory stand-in for the transaction adapter the SCIM plugin hands to its
 * callbacks. It rejects fields the better-auth schema does not declare, as
 * the real adapter does ("Field X not found in model Y").
 */
const fakeDatabase = (rows: Record<string, Record<string, unknown>[]>) => {
	const known: Record<string, string[]> = {
		member: ["id", "userId", "organizationId", "role", "createdAt", "isDefault"],
		user: ["id", "banned", "banReason"],
	};
	const assertFields = (model: string, fields: string[]) => {
		for (const field of fields) {
			if (!known[model]?.includes(field)) {
				throw new Error(`Field ${field} not found in model ${model}`);
			}
		}
	};
	const matches = (row: Record<string, unknown>, where: Where) =>
		where.every((w) => row[w.field] === w.value);
	return {
		findOne: vi.fn(async ({ model, where }: { model: string; where: Where }) => {
			assertFields(model, where.map((w) => w.field));
			return (rows[model] ?? []).find((row) => matches(row, where)) ?? null;
		}),
		create: vi.fn(async ({ model, data }: { model: string; data: Record<string, unknown> }) => {
			assertFields(model, Object.keys(data));
			const row = { id: `id-${(rows[model] ?? []).length}`, ...data };
			rows[model] = [...(rows[model] ?? []), row];
			return row;
		}),
		update: vi.fn(
			async ({ model, where, update }: { model: string; where: Where; update: Record<string, unknown> }) => {
				assertFields(model, Object.keys(update));
				const row = (rows[model] ?? []).find((r) => matches(r, where));
				if (row) Object.assign(row, update);
				return row ?? null;
			},
		),
	};
};

const ctx = (database: ReturnType<typeof fakeDatabase>) =>
	({ database }) as unknown as Parameters<typeof reconcileScimMembership>[1];

describe("SCIM membership projection", () => {
	it("adds an active user to the organization with its default role, as the default org when it is the first", async () => {
		const rows: Record<string, Record<string, unknown>[]> = { member: [] };
		const database = fakeDatabase(rows);
		await reconcileScimMembership(
			{ provisioningDomainId: "org-1", userId: "user-1", active: true },
			ctx(database),
		);
		expect(rows.member).toHaveLength(1);
		expect(rows.member?.[0]).toMatchObject({
			organizationId: "org-1",
			userId: "user-1",
			role: "member",
			isDefault: true,
		});
	});

	it("never changes an existing membership", async () => {
		const rows: Record<string, Record<string, unknown>[]> = {
			member: [{ id: "m1", userId: "user-1", organizationId: "org-1", role: "admin", isDefault: true }],
		};
		const database = fakeDatabase(rows);
		await reconcileScimMembership(
			{ provisioningDomainId: "org-1", userId: "user-1", active: true },
			ctx(database),
		);
		expect(database.create).not.toHaveBeenCalled();
		expect(rows.member?.[0]?.role).toBe("admin");
	});

	it("does not mark a second organization as the default", async () => {
		const rows: Record<string, Record<string, unknown>[]> = {
			member: [{ id: "m1", userId: "user-1", organizationId: "org-0", role: "member", isDefault: true }],
		};
		await reconcileScimMembership(
			{ provisioningDomainId: "org-1", userId: "user-1", active: true },
			ctx(fakeDatabase(rows)),
		);
		expect(rows.member?.[1]).toMatchObject({ organizationId: "org-1", isDefault: false });
	});

	it("ignores inactive users", async () => {
		const database = fakeDatabase({ member: [] });
		await reconcileScimMembership(
			{ provisioningDomainId: "org-1", userId: "user-1", active: false },
			ctx(database),
		);
		expect(database.findOne).not.toHaveBeenCalled();
	});
});

describe("SCIM lifecycle", () => {
	it("bans a deactivated user and lifts only its own ban", async () => {
		const rows: Record<string, Record<string, unknown>[]> = {
			user: [{ id: "user-1", banned: false, banReason: null }],
		};
		const database = fakeDatabase(rows);
		await reconcileScimLifecycle({ userId: "user-1", active: false }, ctx(database));
		expect(rows.user?.[0]).toMatchObject({ banned: true, banReason: SCIM_DEPROVISIONED_BAN_REASON });
		await reconcileScimLifecycle({ userId: "user-1", active: true }, ctx(database));
		expect(rows.user?.[0]).toMatchObject({ banned: false, banReason: null });
	});

	it("leaves a ban an administrator set", async () => {
		const rows: Record<string, Record<string, unknown>[]> = {
			user: [{ id: "user-1", banned: true, banReason: "Abuse" }],
		};
		await reconcileScimLifecycle({ userId: "user-1", active: true }, ctx(fakeDatabase(rows)));
		expect(rows.user?.[0]).toMatchObject({ banned: true, banReason: "Abuse" });
	});
});

describe("SCIM credential hash secret", () => {
	it("prefers a long enough explicit secret and derives one otherwise", () => {
		const explicit = "x".repeat(32);
		expect(getScimCredentialHashSecret({ DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET: explicit })).toBe(explicit);
		const derived = getScimCredentialHashSecret({ DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET: "short" });
		expect(derived).toMatch(/^[0-9a-f]{64}$/);
		expect(getScimCredentialHashSecret({})).toBe(derived);
	});
});
