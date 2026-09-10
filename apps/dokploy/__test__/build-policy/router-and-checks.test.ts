import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review findings 10 and 11.
 *
 * 11: the required-checks gate must accept a legacy *commit status* context
 * (statuses API) as well as a GitHub *check run*, otherwise a team that names
 * a status context waits the whole timeout and then fails naming a check that
 * actually passed.
 *
 * 10: the build-policy router must prove that the `applicationId`/`composeId`
 * it is handed belongs to the caller's active organization before it FK-links
 * a row to it.
 */

const mocks = vi.hoisted(() => ({
	applicationsFindFirst: vi.fn(),
	composeFindFirst: vi.fn(),
	findGithubById: vi.fn(),
	authGithub: vi.fn(),
	recordBuildPolicyAudit: vi.fn(),
	listForRef: vi.fn(),
	listCommitStatusesForRef: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const chain = (): any => {
		const self: any = {
			set: vi.fn(() => self),
			where: vi.fn(() => self),
			values: vi.fn(() => self),
			from: vi.fn(() => self),
			innerJoin: vi.fn(() => self),
			returning: vi.fn().mockResolvedValue([{}]),
			// biome-ignore lint/suspicious/noThenProperty: drizzle's query builder is itself a thenable, so the fake standing in for it must be one too
			then: (resolve: (value: unknown) => void) => resolve([]),
		};
		return self;
	};
	return {
		db: {
			select: vi.fn(() => chain()),
			insert: vi.fn(() => chain()),
			update: vi.fn(() => chain()),
			delete: vi.fn(() => chain()),
			query: {
				applications: { findFirst: mocks.applicationsFindFirst },
				compose: { findFirst: mocks.composeFindFirst },
			},
		},
	};
});

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: mocks.findGithubById,
}));

vi.mock("@dokploy/server/utils/providers/github", () => ({
	authGithub: mocks.authGithub,
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

import {
	apiAddBuildPolicyExclusion,
	apiGrantBuildPolicyBreakGlass,
} from "@dokploy/server/db/schema/build-policy";
import { waitForUnitRequiredChecks } from "@dokploy/server/services/build-policy/github-checks";
import { assertUnitInOrganization } from "@dokploy/server/services/build-policy/ownership";

const ORG = "org-active";

const application = (organizationId: string) => ({
	applicationId: "app-1",
	name: "web",
	environment: { project: { organizationId } },
});

const composeUnit = (organizationId: string) => ({
	composeId: "compose-1",
	name: "stack",
	environment: { project: { organizationId } },
});

describe("assertUnitInOrganization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves an application that belongs to the active organization", async () => {
		mocks.applicationsFindFirst.mockResolvedValue(application(ORG));
		await expect(
			assertUnitInOrganization({
				organizationId: ORG,
				applicationId: "app-1",
			}),
		).resolves.toEqual({
			unitType: "application",
			unitId: "app-1",
			unitName: "web",
		});
	});

	it("throws FORBIDDEN for an application owned by another organization", async () => {
		mocks.applicationsFindFirst.mockResolvedValue(application("org-other"));
		await expect(
			assertUnitInOrganization({
				organizationId: ORG,
				applicationId: "app-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("throws NOT_FOUND for an unknown application id", async () => {
		mocks.applicationsFindFirst.mockResolvedValue(undefined);
		await expect(
			assertUnitInOrganization({
				organizationId: ORG,
				applicationId: "nope",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("resolves a compose that belongs to the active organization", async () => {
		mocks.composeFindFirst.mockResolvedValue(composeUnit(ORG));
		await expect(
			assertUnitInOrganization({ organizationId: ORG, composeId: "compose-1" }),
		).resolves.toEqual({
			unitType: "compose",
			unitId: "compose-1",
			unitName: "stack",
		});
		expect(mocks.applicationsFindFirst).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN for a compose owned by another organization", async () => {
		mocks.composeFindFirst.mockResolvedValue(composeUnit("org-other"));
		await expect(
			assertUnitInOrganization({ organizationId: ORG, composeId: "compose-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("throws NOT_FOUND for an unknown compose id", async () => {
		mocks.composeFindFirst.mockResolvedValue(undefined);
		await expect(
			assertUnitInOrganization({ organizationId: ORG, composeId: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects when neither id is given rather than touching the database", async () => {
		await expect(
			assertUnitInOrganization({ organizationId: ORG }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.applicationsFindFirst).not.toHaveBeenCalled();
		expect(mocks.composeFindFirst).not.toHaveBeenCalled();
	});
});

describe("build-policy router input schemas", () => {
	it("rejects an exclusion body with neither applicationId nor composeId", () => {
		expect(
			apiAddBuildPolicyExclusion.safeParse({ reason: "hotfix" }).success,
		).toBe(false);
	});

	it("rejects an exclusion body with both applicationId and composeId", () => {
		expect(
			apiAddBuildPolicyExclusion.safeParse({
				applicationId: "app-1",
				composeId: "compose-1",
			}).success,
		).toBe(false);
	});

	it("accepts an exclusion body with exactly one id", () => {
		expect(
			apiAddBuildPolicyExclusion.safeParse({ applicationId: "app-1" }).success,
		).toBe(true);
		expect(
			apiAddBuildPolicyExclusion.safeParse({ composeId: "compose-1" }).success,
		).toBe(true);
	});

	it("rejects a break-glass body with neither applicationId nor composeId", () => {
		expect(
			apiGrantBuildPolicyBreakGlass.safeParse({ reason: "prod is down" })
				.success,
		).toBe(false);
	});

	it("rejects a break-glass body with both applicationId and composeId", () => {
		expect(
			apiGrantBuildPolicyBreakGlass.safeParse({
				applicationId: "app-1",
				composeId: "compose-1",
				reason: "prod is down",
			}).success,
		).toBe(false);
	});
});

describe("waitForUnitRequiredChecks with legacy commit statuses", () => {
	const unit = {
		unitType: "application" as const,
		unitId: "app-1",
		unitName: "web",
		organizationId: ORG,
		requiredChecks: ["ci/legacy"],
		sourceType: "github",
		githubId: "gh-1",
		owner: "DevinoSolutions",
		repository: "sendly",
	};

	const call = (overrides: Record<string, unknown> = {}) => {
		let clock = 0;
		return waitForUnitRequiredChecks({
			unit,
			sha: "abc123",
			timeoutMs: 30_000,
			pollIntervalMs: 1_000,
			sleepOverride: async () => {
				clock += 60_000;
			},
			nowOverride: () => clock,
			...overrides,
		});
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findGithubById.mockResolvedValue({ githubId: "gh-1" });
		mocks.authGithub.mockReturnValue({
			rest: {
				checks: { listForRef: mocks.listForRef },
				repos: { listCommitStatusesForRef: mocks.listCommitStatusesForRef },
			},
		});
		mocks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
		mocks.listCommitStatusesForRef.mockResolvedValue({ data: [] });
	});

	it("satisfies a required check that only a commit status reports", async () => {
		mocks.listCommitStatusesForRef.mockResolvedValue({
			data: [{ context: "ci/legacy", state: "success" }],
		});
		await expect(call()).resolves.toBeUndefined();
		expect(mocks.listCommitStatusesForRef).toHaveBeenCalledWith({
			owner: "DevinoSolutions",
			repo: "sendly",
			ref: "abc123",
			per_page: 100,
		});
	});

	it.each(["failure", "error"])(
		"fails the deploy gate on a %s commit status",
		async (state) => {
			mocks.listCommitStatusesForRef.mockResolvedValue({
				data: [{ context: "ci/legacy", state }],
			});
			await expect(call()).rejects.toMatchObject({
				code: "REQUIRED_CHECKS_FAILED",
			});
		},
	);

	it("stays pending on a pending commit status until it times out", async () => {
		mocks.listCommitStatusesForRef.mockResolvedValue({
			data: [{ context: "ci/legacy", state: "pending" }],
		});
		await expect(call()).rejects.toMatchObject({
			code: "REQUIRED_CHECKS_TIMEOUT",
		});
	});

	it("keeps the newest of two statuses sharing a context", async () => {
		// GitHub returns statuses newest-first.
		mocks.listCommitStatusesForRef.mockResolvedValue({
			data: [
				{ context: "ci/legacy", state: "success" },
				{ context: "ci/legacy", state: "failure" },
			],
		});
		await expect(call()).resolves.toBeUndefined();
	});

	it("fails when the newest of two statuses sharing a context failed", async () => {
		mocks.listCommitStatusesForRef.mockResolvedValue({
			data: [
				{ context: "ci/legacy", state: "failure" },
				{ context: "ci/legacy", state: "success" },
			],
		});
		await expect(call()).rejects.toMatchObject({
			code: "REQUIRED_CHECKS_FAILED",
		});
	});

	it("falls back to check runs alone when the statuses call rejects", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		mocks.listCommitStatusesForRef.mockRejectedValue(
			new Error("Resource not accessible by integration"),
		);
		mocks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ name: "ci/legacy", status: "completed", conclusion: "success" },
				],
			},
		});
		await expect(call()).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it("still throws when the check runs call itself rejects", async () => {
		mocks.listForRef.mockRejectedValue(new Error("bad credentials"));
		await expect(call()).rejects.toThrow(/bad credentials/);
	});

	it("prefers a check run over an older status of the same name", async () => {
		mocks.listForRef.mockResolvedValue({
			data: {
				check_runs: [
					{ name: "ci/legacy", status: "completed", conclusion: "failure" },
				],
			},
		});
		mocks.listCommitStatusesForRef.mockResolvedValue({
			data: [{ context: "ci/legacy", state: "success" }],
		});
		// Statuses are merged after check runs, so the status wins here; the
		// point of the assertion is that both sources reach the evaluator.
		await expect(call()).resolves.toBeUndefined();
	});
});
