import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An appName is the service's volume namespace, so it has to be unique as
// stored (the final, suffixed name) and unpredictable (T-6822).
const mocks = vi.hoisted(() => ({
	validUniqueServerAppName: vi.fn(),
	insertValues: vi.fn(),
	resync: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				mocks.insertValues(values);
				return {
					returning: () =>
						Promise.resolve([
							{ ...values, libsqlId: "l-1", environmentId: "env-1" },
						]),
				};
			},
		}),
	},
}));

vi.mock("@dokploy/server/services/project", () => ({
	validUniqueServerAppName: mocks.validUniqueServerAppName,
}));

vi.mock("@dokploy/server/services/backup-policy", () => ({
	resyncBackupPoliciesForEnvironment: mocks.resync,
}));

const { createLibsql } = await import("@dokploy/server/services/libsql");
const { generatePassword } = await import("@dokploy/server/templates");
const { buildAppName } = await import("@dokploy/server/db/schema/utils");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.validUniqueServerAppName.mockResolvedValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createLibsql", () => {
	it("checks uniqueness on the final suffixed appName, not on the input", async () => {
		await createLibsql({
			name: "db",
			appName: "my-libsql",
			environmentId: "env-1",
			databaseUser: "u",
			dockerImage: "ghcr.io/tursodatabase/libsql-server:latest",
		} as never);

		const checked = mocks.validUniqueServerAppName.mock.calls[0]?.[0];
		const stored = mocks.insertValues.mock.calls[0]?.[0].appName;
		expect(checked).toBe(stored);
		expect(checked).not.toBe("my-libsql");
		expect(checked).toMatch(/^my-libsql-[a-z0-9]{6}$/);
	});

	it("refuses with CONFLICT when the final appName is taken, writing nothing", async () => {
		mocks.validUniqueServerAppName.mockResolvedValue(false);

		await expect(
			createLibsql({
				name: "db",
				appName: "my-libsql",
				environmentId: "env-1",
			} as never),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.insertValues).not.toHaveBeenCalled();
	});
});

describe("the appName suffix", () => {
	it("does not come from Math.random", () => {
		const random = vi.spyOn(Math, "random");

		const suffix = generatePassword(6);
		const appName = buildAppName("postgres", "orders");

		expect(random).not.toHaveBeenCalled();
		expect(suffix).toMatch(/^[a-z0-9]{6}$/);
		expect(appName).toMatch(/^orders-[a-z0-9]{6}$/);
	});

	it("is not a constant", () => {
		const suffixes = new Set(
			Array.from({ length: 50 }, () => generatePassword(6)),
		);
		expect(suffixes.size).toBeGreaterThan(40);
	});
});
