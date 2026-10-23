import * as bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `user.update` writes the caller's own row. It used to spread a partial of the
// whole user table onto it, so a user could set columns such as id,
// emailVerified or the licence and billing fields. It now takes the profile
// fields the account form sends and nothing else (T-6895).
const mocks = vi.hoisted(() => ({
	updateUser: vi.fn(),
	findAccount: vi.fn(),
	dbUpdate: vi.fn(),
	dbDelete: vi.fn(),
	accountSet: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		updateUser: mocks.updateUser,
	};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (typeof key === "string" && key in named) {
				return named[key];
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		query: { account: { findFirst: mocks.findAccount } },
		update: mocks.dbUpdate,
		delete: mocks.dbDelete,
	},
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

const schema = await import("@dokploy/server/db/schema");

const ctx = {
	session: { id: "session-1", activeOrganizationId: "org-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

const callerOf = async () => {
	const module = await import("@/server/api/routers/user");
	return module.userRouter.createCaller(ctx as never);
};

const PROFILE_FIELDS = [
	"email",
	"image",
	"firstName",
	"lastName",
	"allowImpersonation",
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateUser.mockResolvedValue({ id: "user-1" });
	mocks.accountSet.mockReturnValue({ where: vi.fn(async () => undefined) });
	mocks.dbUpdate.mockReturnValue({ set: mocks.accountSet });
	mocks.dbDelete.mockReturnValue({ where: vi.fn(async () => undefined) });
});

describe("apiUpdateUser", () => {
	it("keeps the profile fields and the password pair", () => {
		const parsed = schema.apiUpdateUser.parse({
			email: "me@example.com",
			image: "/avatars/avatar-1.png",
			firstName: "Me",
			lastName: "Myself",
			allowImpersonation: true,
			password: "new-password",
			currentPassword: "old-password",
		});

		expect(Object.keys(parsed).sort()).toEqual(
			[...PROFILE_FIELDS, "password", "currentPassword"].sort(),
		);
	});

	it("drops every column outside the profile", () => {
		const parsed = schema.apiUpdateUser.parse({
			firstName: "Me",
			id: "someone-else",
			emailVerified: true,
			role: "owner",
			banned: false,
			banReason: "x",
			twoFactorEnabled: false,
			enableEnterpriseFeatures: true,
			enablePaidFeatures: true,
			isValidEnterpriseLicense: true,
			licenseKey: "key",
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_1",
			serversQuantity: 100,
			isRegistered: true,
			expirationDate: "2999-01-01",
			trustedOrigins: ["https://evil.example"],
		});

		expect(parsed).toEqual({ firstName: "Me" });
	});
});

describe("user.update", { timeout: 60_000 }, () => {
	it("never writes a column outside the profile allow-list", async () => {
		const caller = await callerOf();

		await caller.update({
			firstName: "Me",
			id: "someone-else",
			emailVerified: true,
			banned: false,
			twoFactorEnabled: false,
			enableEnterpriseFeatures: true,
			licenseKey: "key",
			stripeCustomerId: "cus_1",
			serversQuantity: 100,
		} as never);

		expect(mocks.updateUser).toHaveBeenCalledTimes(1);
		const [userId, written] = mocks.updateUser.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(userId).toBe("user-1");
		expect(written.firstName).toBe("Me");
		for (const key of Object.keys(written)) {
			expect(PROFILE_FIELDS).toContain(key);
		}
		for (const key of [
			"id",
			"emailVerified",
			"banned",
			"twoFactorEnabled",
			"enableEnterpriseFeatures",
			"licenseKey",
			"stripeCustomerId",
			"serversQuantity",
		]) {
			expect(written).not.toHaveProperty(key);
		}
	});

	it("updates the profile fields the account form sends", async () => {
		const caller = await callerOf();

		await caller.update({
			email: "me@example.com",
			image: "/avatars/avatar-2.png",
			firstName: "Me",
			lastName: "Myself",
			allowImpersonation: true,
		});

		expect(mocks.updateUser).toHaveBeenCalledWith("user-1", {
			email: "me@example.com",
			image: "/avatars/avatar-2.png",
			firstName: "Me",
			lastName: "Myself",
			allowImpersonation: true,
		});
	});

	it("changes the password on the account row and keeps it out of the user row", async () => {
		mocks.findAccount.mockResolvedValue({
			password: bcrypt.hashSync("old-password", 4),
		});
		const caller = await callerOf();

		await caller.update({
			password: "new-password",
			currentPassword: "old-password",
			firstName: "Me",
		});

		expect(mocks.accountSet).toHaveBeenCalledTimes(1);
		const { password } = mocks.accountSet.mock.calls[0]?.[0] as {
			password: string;
		};
		expect(bcrypt.compareSync("new-password", password)).toBe(true);
		const [, written] = mocks.updateUser.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(written).not.toHaveProperty("password");
		expect(written).not.toHaveProperty("currentPassword");
	});

	it("refuses a password change with the wrong current password", async () => {
		mocks.findAccount.mockResolvedValue({
			password: bcrypt.hashSync("old-password", 4),
		});
		const caller = await callerOf();

		await expect(
			caller.update({
				password: "new-password",
				currentPassword: "not-the-password",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateUser).not.toHaveBeenCalled();
		expect(mocks.accountSet).not.toHaveBeenCalled();
	});

	it("changes the password on a password-only payload and writes no user row", async () => {
		mocks.findAccount.mockResolvedValue({
			password: bcrypt.hashSync("old-password", 4),
		});
		const caller = await callerOf();

		await expect(
			caller.update({
				password: "new-password",
				currentPassword: "old-password",
			}),
		).resolves.not.toThrow();

		expect(mocks.accountSet).toHaveBeenCalledTimes(1);
		// updateUser would end in an empty `set()` ("No values to set") with nothing
		// but undefined profile fields
		expect(mocks.updateUser).not.toHaveBeenCalled();
	});

	it("still writes the user row when a profile field comes with the password", async () => {
		mocks.findAccount.mockResolvedValue({
			password: bcrypt.hashSync("old-password", 4),
		});
		const caller = await callerOf();

		await caller.update({
			password: "new-password",
			currentPassword: "old-password",
			allowImpersonation: false,
		});

		expect(mocks.updateUser).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({ allowImpersonation: false }),
		);
	});
});
