import { beforeEach, describe, expect, it, vi } from "vitest";

const MESSAGE =
	"This organization owns the Dokploy instance and can't be deleted";

const mocks = vi.hoisted(() => ({
	isCloud: false,
	root: { id: "org-root" } as { id: string } | undefined,
	owned: [] as { id: string }[],
	order: [] as string[],
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	get IS_CLOUD() {
		return mocks.isCloud;
	},
}));

vi.mock("@dokploy/server/db", () => {
	const executor = {
		delete: () => ({
			where: () => {
				mocks.order.push("delete user");
				const result = Promise.resolve([]) as Promise<unknown> & {
					returning: () => Promise<unknown>;
				};
				result.returning = async () => [];
				return result;
			},
		}),
		update: () => ({
			set: () => ({ where: async () => mocks.order.push("scrub") }),
		}),
		select: () => ({ from: () => ({ where: async () => mocks.owned }) }),
	};
	return {
		db: {
			...executor,
			query: {
				organization: { findFirst: vi.fn(async () => mocks.root) },
			},
			transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
				run(executor),
			),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/services/notification-channels", () => ({
	removeOrganizationNotifications: vi.fn(async () => {
		mocks.order.push("notifications");
	}),
}));

const { assertOrganizationDeletable, removeUserById } = await import(
	"@dokploy/server/services/admin"
);

beforeEach(() => {
	mocks.isCloud = false;
	mocks.root = { id: "org-root" };
	mocks.owned = [];
	mocks.order = [];
});

describe("assertOrganizationDeletable", () => {
	it("refuses the root organization", async () => {
		await expect(assertOrganizationDeletable("org-root")).rejects.toMatchObject(
			{ code: "FORBIDDEN", message: MESSAGE },
		);
	});

	it("lets any other organization through", async () => {
		await expect(assertOrganizationDeletable("org-2")).resolves.toBeUndefined();
	});

	it("has no root organization on Dokploy Cloud", async () => {
		mocks.isCloud = true;

		await expect(
			assertOrganizationDeletable("org-root"),
		).resolves.toBeUndefined();
	});
});

describe("removeUserById and the root organization", () => {
	it("refuses to delete the user who owns it, before anything is removed", async () => {
		mocks.owned = [{ id: "org-2" }, { id: "org-root" }];

		await expect(removeUserById("user-1")).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: MESSAGE,
		});

		expect(mocks.order).toEqual([]);
	});

	it("still deletes a user who owns other organizations only", async () => {
		mocks.owned = [{ id: "org-2" }, { id: "org-3" }];

		await removeUserById("user-1");

		expect(mocks.order).toEqual([
			"notifications",
			"notifications",
			"scrub",
			"delete user",
		]);
	});

	it("still deletes a user who owns no organization", async () => {
		await removeUserById("user-1");

		expect(mocks.order).toEqual(["scrub", "delete user"]);
	});
});
