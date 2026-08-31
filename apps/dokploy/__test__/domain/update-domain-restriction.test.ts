import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: `createDomain` has always enforced the domain-restriction
 * allow-list, but `updateDomainById` did not — so renaming an existing domain
 * to a host outside the allow-list succeeded and the restriction was trivially
 * bypassable through the edit dialog.
 */
const mocks = vi.hoisted(() => ({
	webServerSettingsFindFirst: vi.fn(),
	updateSet: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: vi.fn(() => ({
			set: (values: unknown) => {
				mocks.updateSet(values);
				return {
					where: () => ({
						returning: () => Promise.resolve([{ domainId: "domain-1" }]),
					}),
				};
			},
		})),
		insert: vi.fn(() => ({
			values: () => ({ returning: () => Promise.resolve([{}]) }),
		})),
		query: {
			webServerSettings: { findFirst: mocks.webServerSettingsFindFirst },
		},
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

const { updateDomainById } = await import("@dokploy/server/services/domain");

const restriction = (config: unknown) => {
	mocks.webServerSettingsFindFirst.mockResolvedValue({
		serverIp: "203.0.113.10",
		domainRestrictionConfig: config,
	});
};

beforeEach(() => {
	vi.clearAllMocks();
	restriction({ enabled: true, allowedWildcards: ["*.allowed.example.com"] });
});

describe("updateDomainById enforces the domain restriction allow-list", () => {
	it("refuses a host outside the allow-list and writes nothing", async () => {
		await expect(
			updateDomainById("domain-1", { host: "evil.example.com" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("refuses a host that only differs by surrounding whitespace", async () => {
		await expect(
			updateDomainById("domain-1", { host: "  evil.example.com  " }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateSet).not.toHaveBeenCalled();
	});

	it("accepts a host that matches the allow-list and lowercases it", async () => {
		await expect(
			updateDomainById("domain-1", { host: "App.Allowed.Example.com" }),
		).resolves.toMatchObject({ domainId: "domain-1" });
		expect(mocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ host: "app.allowed.example.com" }),
		);
	});

	it("does not consult the allow-list for updates that leave the host alone", async () => {
		await expect(
			updateDomainById("domain-1", { enabled: false }),
		).resolves.toMatchObject({ domainId: "domain-1" });
		expect(mocks.webServerSettingsFindFirst).not.toHaveBeenCalled();
		expect(mocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false }),
		);
	});

	it("is a no-op guard when the restriction is disabled", async () => {
		restriction({ enabled: false, allowedWildcards: [] });

		await expect(
			updateDomainById("domain-1", { host: "anything.example.com" }),
		).resolves.toMatchObject({ domainId: "domain-1" });
		expect(mocks.updateSet).toHaveBeenCalled();
	});
});
