import { beforeEach, describe, expect, it, vi } from "vitest";

// The plugin's own /organization/delete endpoint is disabled, so its hook is
// reached by no request today; the test captures the options the organization
// plugin is given and runs the hook the way the plugin would.
const MESSAGE =
	"This organization owns the Dokploy instance and can't be deleted";

const mocks = vi.hoisted(() => ({
	options: null as null | {
		organizationHooks: {
			beforeDeleteOrganization: (data: {
				organization: { id: string };
			}) => Promise<void>;
		};
	},
	assertOrganizationDeletable: vi.fn(),
	removeOrganizationNotifications: vi.fn(),
}));

vi.mock("better-auth/plugins", () => ({
	admin: () => ({}),
	twoFactor: () => ({}),
	organization: (options: NonNullable<typeof mocks.options>) => {
		mocks.options = options;
		return {};
	},
}));

vi.mock("better-auth", () => ({ betterAuth: () => ({ api: {} }) }));
vi.mock("@better-auth/api-key", () => ({ apiKey: () => ({}) }));
vi.mock("@better-auth/oauth-provider", () => ({ oauthProvider: () => ({}) }));
vi.mock("@better-auth/passkey", () => ({ passkey: () => ({}) }));
vi.mock("@better-auth/scim", () => ({ scim: () => ({}) }));
vi.mock("@better-auth/sso", () => ({ sso: () => ({}) }));
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: () => ({}) }));
vi.mock("@dokploy/server/db", () => ({ db: {}, dbUrl: "postgres://mock" }));
vi.mock("@dokploy/server/services/proprietary/scim", () => ({
	scimOptions: () => ({}),
}));
vi.mock("@dokploy/server/services/admin", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/services/admin")>()),
	assertOrganizationDeletable: mocks.assertOrganizationDeletable,
}));
vi.mock("@dokploy/server/services/notification-channels", () => ({
	removeOrganizationNotifications: mocks.removeOrganizationNotifications,
}));

const { auth } = await import("@dokploy/server/lib/auth");

const hook = () => {
	// Creating the instance hands the plugin its options.
	void auth.handler;
	return mocks.options!.organizationHooks.beforeDeleteOrganization;
};

describe("better-auth organization delete hook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("refuses the root organization before cleaning anything up", async () => {
		mocks.assertOrganizationDeletable.mockRejectedValue(new Error(MESSAGE));

		await expect(
			hook()({ organization: { id: "org-root" } }),
		).rejects.toMatchObject({ status: "FORBIDDEN", message: MESSAGE });

		expect(mocks.removeOrganizationNotifications).not.toHaveBeenCalled();
	});

	it("cleans up any other organization as before", async () => {
		mocks.assertOrganizationDeletable.mockResolvedValue(undefined);

		await hook()({ organization: { id: "org-2" } });

		expect(mocks.removeOrganizationNotifications).toHaveBeenCalledWith("org-2");
	});
});
