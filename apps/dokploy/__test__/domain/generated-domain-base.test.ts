import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveGeneratedDomainBase` decides which base domain a generated host is
 * appended to. The precedence chain is load-bearing for multi-server installs:
 * an organization wildcard points at ONE machine's IP, so a server that declared
 * its own `defaultDomain` has to win over it.
 */
vi.mock("@dokploy/server/services/project", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/project")>();
	return {
		...actual,
		findProjectWildcardConfig: vi.fn(async () => projectRow),
	};
});

vi.mock("@dokploy/server/services/server", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/server")>();
	return {
		...actual,
		findServerById: vi.fn(async () => serverRow),
	};
});

let projectRow: Record<string, unknown> | null = null;
let serverRow: Record<string, unknown> = {};

const { resolveGeneratedDomainBase } = await import(
	"@dokploy/server/services/domain"
);
const { generateRandomDomain } = await import("@dokploy/server/templates");
const {
	formatWildcardBaseDomain,
	normalizeWildcardBaseDomain,
	WILDCARD_BASE_PREFIX_PATTERN_MESSAGE,
	WILDCARD_BASE_MULTI_LEVEL_MESSAGE,
} = await import("@dokploy/server/utils/wildcard-domain-base");

const setProject = (
	overrides: Partial<{
		wildcardDomain: string | null;
		useOrganizationWildcard: boolean;
		organizationWildcardDomain: string | null;
	}> | null,
) => {
	if (overrides === null) {
		projectRow = null;
		return;
	}
	projectRow = {
		projectId: "project-1",
		organizationId: "org-1",
		wildcardDomain: overrides.wildcardDomain ?? null,
		useOrganizationWildcard: overrides.useOrganizationWildcard ?? true,
		organization: {
			wildcardDomain: overrides.organizationWildcardDomain ?? null,
		},
	};
};

const setServerDefaultDomain = (defaultDomain: string | null) => {
	serverRow = {
		serverId: "srv-1",
		organizationId: "org-1",
		ipAddress: "203.0.113.10",
		defaultDomain,
	};
};

const originalDefaultDomain = process.env.DEFAULT_DOMAIN;

beforeEach(() => {
	vi.clearAllMocks();
	setProject(null);
	setServerDefaultDomain(null);
	process.env.DEFAULT_DOMAIN = originalDefaultDomain;
	// biome-ignore lint/performance/noDelete: env vars must be absent, not "undefined"
	delete process.env.DEFAULT_DOMAIN;
});

describe("resolveGeneratedDomainBase precedence", () => {
	it("rung 1: the project override wins over everything", async () => {
		setProject({
			wildcardDomain: "apps.project.example",
			organizationWildcardDomain: "apps.org.example",
		});
		setServerDefaultDomain("apps.server.example");
		process.env.DEFAULT_DOMAIN = "apps.env.example";

		await expect(
			resolveGeneratedDomainBase({
				projectId: "project-1",
				serverId: "srv-1",
			}),
		).resolves.toEqual({
			baseDomain: "apps.project.example",
			source: "project",
		});
	});

	it("rung 2: server.defaultDomain beats the organization wildcard", async () => {
		setProject({ organizationWildcardDomain: "apps.org.example" });
		setServerDefaultDomain("apps.server.example");

		await expect(
			resolveGeneratedDomainBase({
				projectId: "project-1",
				serverId: "srv-1",
			}),
		).resolves.toEqual({
			baseDomain: "apps.server.example",
			source: "server",
		});
	});

	it("rung 3: the organization wildcard is used when no closer base exists", async () => {
		setProject({ organizationWildcardDomain: "apps.org.example" });

		await expect(
			resolveGeneratedDomainBase({ projectId: "project-1" }),
		).resolves.toEqual({
			baseDomain: "apps.org.example",
			source: "organization",
		});
	});

	it("rung 3 is blocked by useOrganizationWildcard = false", async () => {
		setProject({
			organizationWildcardDomain: "apps.org.example",
			useOrganizationWildcard: false,
		});
		process.env.DEFAULT_DOMAIN = "apps.env.example";

		await expect(
			resolveGeneratedDomainBase({ projectId: "project-1" }),
		).resolves.toEqual({
			baseDomain: "apps.env.example",
			source: "environment",
		});
	});

	it("rung 4: DEFAULT_DOMAIN is used for the manager host", async () => {
		process.env.DEFAULT_DOMAIN = "apps.env.example";

		await expect(resolveGeneratedDomainBase({})).resolves.toEqual({
			baseDomain: "apps.env.example",
			source: "environment",
		});
	});

	it("rung 4 is NOT applied to a remote server (pre-existing behaviour)", async () => {
		process.env.DEFAULT_DOMAIN = "apps.env.example";
		setServerDefaultDomain(null);

		await expect(
			resolveGeneratedDomainBase({ serverId: "srv-1" }),
		).resolves.toEqual({ baseDomain: null, source: "none" });
	});

	it("rung 5: nothing configured falls through to the sslip.io path", async () => {
		await expect(resolveGeneratedDomainBase({})).resolves.toEqual({
			baseDomain: null,
			source: "none",
		});
	});

	it("a missing project row does not throw, it just skips rungs 1 and 3", async () => {
		setProject(null);
		setServerDefaultDomain("apps.server.example");

		await expect(
			resolveGeneratedDomainBase({
				projectId: "does-not-exist",
				serverId: "srv-1",
			}),
		).resolves.toEqual({
			baseDomain: "apps.server.example",
			source: "server",
		});
	});
});

describe("normalizeWildcardBaseDomain", () => {
	it("stores the bare base and strips a leading '*.'", () => {
		expect(normalizeWildcardBaseDomain("*.apps.example.com")).toEqual({
			base: "apps.example.com",
		});
	});

	it("accepts a bare base domain unchanged", () => {
		expect(normalizeWildcardBaseDomain("apps.example.com")).toEqual({
			base: "apps.example.com",
		});
	});

	it("trims and lowercases", () => {
		expect(normalizeWildcardBaseDomain("  *.Apps.Example.COM  ")).toEqual({
			base: "apps.example.com",
		});
	});

	it("treats empty input as cleared", () => {
		expect(normalizeWildcardBaseDomain("")).toEqual({ base: null });
		expect(normalizeWildcardBaseDomain(null)).toEqual({ base: null });
		expect(normalizeWildcardBaseDomain(undefined)).toEqual({ base: null });
	});

	it("rejects prefix wildcard patterns with a dedicated message", () => {
		expect(normalizeWildcardBaseDomain("*-apps.example.com")).toEqual({
			error: WILDCARD_BASE_PREFIX_PATTERN_MESSAGE,
		});
	});

	it("rejects multi-level wildcards", () => {
		expect(normalizeWildcardBaseDomain("**.example.com")).toEqual({
			error: WILDCARD_BASE_MULTI_LEVEL_MESSAGE,
		});
	});

	it("rejects a misplaced asterisk", () => {
		const result = normalizeWildcardBaseDomain("apps.*.example.com");
		expect(result.base).toBeUndefined();
		expect(result.error).toBeTruthy();
	});

	it("rejects underscores and other invalid hostnames", () => {
		expect(normalizeWildcardBaseDomain("*.bad_host.example.com").error).toBeTruthy();
		expect(normalizeWildcardBaseDomain("*.-example.com").error).toBeTruthy();
	});

	it("rejects a single-label base", () => {
		expect(normalizeWildcardBaseDomain("*.localhost").error).toBeTruthy();
	});

	it("round-trips through the display form", () => {
		const stored = normalizeWildcardBaseDomain("*.apps.example.com");
		expect(formatWildcardBaseDomain(stored.base)).toBe("*.apps.example.com");
		expect(formatWildcardBaseDomain(null)).toBe("");
	});
});

describe("generateRandomDomain label ceiling", () => {
	it("keeps the leading DNS label within 63 bytes for a long app name and base", () => {
		const longAppName = "a".repeat(120);
		const longBase = `${"sub".repeat(20)}.example.com`;

		const domain = generateRandomDomain({
			serverIp: "203.0.113.10",
			projectName: longAppName,
			baseDomain: longBase,
		});

		const label = domain.split(".")[0] as string;
		expect(label.length).toBeLessThanOrEqual(63);
		expect(domain.endsWith(`.${longBase}`)).toBe(true);
	});

	it("keeps the leading label within 63 bytes on the sslip.io fallback", () => {
		const domain = generateRandomDomain({
			serverIp: "203.0.113.10",
			projectName: "b".repeat(120),
			baseDomain: null,
		});

		const label = domain.split(".")[0] as string;
		expect(label.length).toBeLessThanOrEqual(63);
		expect(domain.endsWith(".sslip.io")).toBe(true);
	});
});
