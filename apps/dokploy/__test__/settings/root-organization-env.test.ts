import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The organization that owns the instance is the one named by
// DOKPLOY_ROOT_ORGANIZATION_ID, otherwise the first one created. A pinned id
// that matches nothing leaves no root, so every host-level guard refuses.

const state = vi.hoisted(() => ({ isCloud: false }));
const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }));

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		query: {
			organization: { findFirst: mocks.findFirst, findMany: mocks.findMany },
		},
	},
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	get IS_CLOUD() {
		return state.isCloud;
	},
}));

vi.mock("@dokploy/server", async () => ({
	...(await vi.importActual<typeof import("@dokploy/server/services/admin")>(
		"@dokploy/server/services/admin",
	)),
	get IS_CLOUD() {
		return state.isCloud;
	},
}));

// A fresh copy of the module for each test: it reports a missing pinned id once.
let findRootOrganization: typeof import("@dokploy/server/services/admin").findRootOrganization;
let isRootOrganization: typeof import("@dokploy/server/services/admin").isRootOrganization;
let logRootOrganization: typeof import("@dokploy/server/services/admin").logRootOrganization;
let isSingleOrganizationInstance: typeof import("@dokploy/server/services/admin").isSingleOrganizationInstance;
let assertLocalHostAccess: typeof import("@/server/api/utils/local-host-access").assertLocalHostAccess;

const FIRST = { id: "org-first", name: "First" };
const PINNED = { id: "org-pinned", name: "Pinned" };

// The organization query: by id when asked for one, the oldest otherwise.
const organizations = (rows: { id: string; name: string }[]) =>
	mocks.findFirst.mockImplementation(
		async (query: { where?: Parameters<PgDialect["sqlToQuery"]>[0] }) => {
			if (!query.where) {
				return rows[0];
			}
			const { params } = new PgDialect().sqlToQuery(query.where);
			return rows.find((row) => params.includes(row.id));
		},
	);

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	vi.resetModules();
	mocks.findFirst.mockReset();
	mocks.findMany.mockReset();
	state.isCloud = false;
	vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "");
	log = vi.spyOn(console, "log").mockImplementation(() => {});
	error = vi.spyOn(console, "error").mockImplementation(() => {});
	({
		findRootOrganization,
		isRootOrganization,
		logRootOrganization,
		isSingleOrganizationInstance,
	} = await import("@dokploy/server/services/admin"));
	({ assertLocalHostAccess } = await import(
		"@/server/api/utils/local-host-access"
	));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("the organization that owns the instance", () => {
	it("is the first one created when nothing is pinned", async () => {
		organizations([FIRST, PINNED]);

		await expect(findRootOrganization()).resolves.toEqual(FIRST);
		await expect(isRootOrganization("org-first")).resolves.toBe(true);
		await expect(isRootOrganization("org-pinned")).resolves.toBe(false);
	});

	it("is the pinned one when DOKPLOY_ROOT_ORGANIZATION_ID is set", async () => {
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-pinned");
		organizations([FIRST, PINNED]);

		await expect(findRootOrganization()).resolves.toEqual(PINNED);
		await expect(isRootOrganization("org-pinned")).resolves.toBe(true);
		await expect(isRootOrganization("org-first")).resolves.toBe(false);
	});

	it("is the first one created when the variable is empty or blank", async () => {
		for (const value of ["", "   "]) {
			vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", value);
			organizations([FIRST, PINNED]);

			await expect(findRootOrganization()).resolves.toEqual(FIRST);
		}
	});

	it("is nobody when the pinned id matches no organization, and the guards refuse", async () => {
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-gone");
		organizations([FIRST, PINNED]);

		await expect(findRootOrganization()).resolves.toBeNull();
		await expect(isRootOrganization("org-first")).resolves.toBe(false);
		await expect(isRootOrganization("org-pinned")).resolves.toBe(false);
		for (const organizationId of ["org-first", "org-pinned", undefined]) {
			await expect(
				assertLocalHostAccess(undefined, organizationId),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});

	it("reports a pinned id that matches nothing once", async () => {
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-gone");
		organizations([FIRST]);

		await isRootOrganization("org-first");
		await isRootOrganization("org-first");

		expect(error).toHaveBeenCalledTimes(1);
	});
});

describe("a host schedule with no organization", () => {
	it("is attributed to the owner only on a one-organization instance", async () => {
		organizations([FIRST]);
		mocks.findMany.mockResolvedValue([{ id: "org-first" }]);

		await expect(isSingleOrganizationInstance()).resolves.toBe(true);

		mocks.findMany.mockResolvedValue([{ id: "org-first" }, { id: "org-2" }]);

		await expect(isSingleOrganizationInstance()).resolves.toBe(false);
	});

	it("is attributed to nobody when the pinned id matches no organization", async () => {
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-gone");
		organizations([FIRST]);
		mocks.findMany.mockResolvedValue([{ id: "org-first" }]);

		await expect(isSingleOrganizationInstance()).resolves.toBe(false);
	});
});

describe("the root organization line at startup", () => {
	it("names the first organization created", async () => {
		organizations([FIRST, PINNED]);

		await logRootOrganization();

		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			'root organization: org-first "First" (source: first-created)',
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("names the pinned organization", async () => {
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-pinned");
		organizations([FIRST, PINNED]);

		await logRootOrganization();

		expect(log).toHaveBeenCalledWith(
			'root organization: org-pinned "Pinned" (source: env)',
		);
		expect(error).not.toHaveBeenCalled();
	});

	it("keeps a line break in the organization name out of the log", async () => {
		organizations([{ id: "org-first", name: "First\nroot organization: x" }]);

		await logRootOrganization();

		const [line] = log.mock.calls[0] ?? [];
		expect(line).not.toMatch(/[\r\n]/);
	});

	it("says the pinned id was not found and that host-level settings are refused", async () => {
		vi.stubEnv("DOKPLOY_ROOT_ORGANIZATION_ID", "org-gone");
		organizations([FIRST, PINNED]);

		await logRootOrganization();

		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith(
			"root organization: org-gone not found (source: env), host-level settings are refused",
		);
		expect(log).not.toHaveBeenCalled();
	});

	it("says nothing on Dokploy Cloud", async () => {
		state.isCloud = true;
		organizations([FIRST]);

		await logRootOrganization();

		expect(log).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});
});
