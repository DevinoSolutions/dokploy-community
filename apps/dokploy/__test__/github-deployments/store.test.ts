import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectRows: [] as unknown[],
	/** Answers for consecutive selects; when empty, `selectRows` answers. */
	selectQueue: [] as unknown[][],
	selectCalls: 0,
	upsertSet: null as Record<string, unknown> | null,
	updates: [] as Array<{ values: Record<string, unknown>; cond: unknown }>,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		select: () => {
			mocks.selectCalls += 1;
			return {
				from: () => ({
					where: async () => mocks.selectQueue.shift() ?? mocks.selectRows,
				}),
			};
		},
		insert: () => ({
			values: (values: Record<string, unknown>) => ({
				onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
					mocks.upsertSet = set;
					return { returning: async () => [{ ...values, ...set }] };
				},
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async (cond: unknown) => {
					mocks.updates.push({ values, cond });
				},
			}),
		}),
	},
}));

import {
	listGithubWatchesForOrganization,
	loadGhcrCredentials,
	patchGithubWatch,
	presentGithubWatch,
	upsertGithubWatch,
} from "@dokploy/server/services/github-deployments/store";

const dialect = new PgDialect();
const existing = (overrides: Record<string, unknown> = {}) => ({
	watchId: "w1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
	enabled: true,
	postLogUrl: false,
	lastSeenDeploymentId: 90,
	etag: 'W/"x"',
	inflightDeploymentId: null,
	inflightStartedAt: null,
	lastCheckedAt: null,
	lastError: null,
	createdAt: new Date(0),
	...overrides,
});
const input = {
	organizationId: "org-a",
	serviceType: "application" as const,
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
	enabled: true,
};

beforeEach(() => {
	mocks.selectRows = [];
	mocks.selectQueue = [];
	mocks.selectCalls = 0;
	mocks.upsertSet = null;
	mocks.updates = [];
});

describe("the cursor of a watch", () => {
	it("is reset when a disabled watch is turned back on, so the backlog never replays", async () => {
		mocks.selectRows = [existing({ enabled: false })];
		await upsertGithubWatch(input);
		expect(mocks.upsertSet).toMatchObject({
			enabled: true,
			lastSeenDeploymentId: null,
			etag: null,
			inflightDeploymentId: null,
			inflightStartedAt: null,
		});
	});

	it.each([
		["repository", { repo: "other" }],
		["owner", { owner: "Other" }],
		["environment", { environment: "staging" }],
		["connection", { connectionId: "conn-2" }],
	])("is reset when the %s changes", async (_name, change) => {
		mocks.selectRows = [existing()];
		await upsertGithubWatch({ ...input, ...change });
		expect(mocks.upsertSet).toMatchObject({ lastSeenDeploymentId: null });
	});

	it("is kept when nothing that selects deployments changed", async () => {
		mocks.selectRows = [existing()];
		await upsertGithubWatch({ ...input, postLogUrl: true });
		expect(mocks.upsertSet).not.toHaveProperty("lastSeenDeploymentId");
		expect(mocks.upsertSet).toMatchObject({ postLogUrl: true });
	});

	it("is kept when a disabled watch stays disabled", async () => {
		mocks.selectRows = [existing({ enabled: false })];
		await upsertGithubWatch({ ...input, enabled: false });
		expect(mocks.upsertSet).not.toHaveProperty("lastSeenDeploymentId");
	});

	it("starts empty for a new watch", async () => {
		mocks.selectRows = [];
		await upsertGithubWatch(input);
		expect(mocks.upsertSet).toMatchObject({ lastSeenDeploymentId: null });
	});

	it("never moves backwards: lastSeen is written only where it is empty or lower", async () => {
		await patchGithubWatch("w1", { lastSeenDeploymentId: 120 });
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]?.values).toEqual({ lastSeenDeploymentId: 120 });
		const query = dialect.sqlToQuery(mocks.updates[0]?.cond as never);
		expect(query.sql).toMatch(/"lastSeenDeploymentId" is null/);
		expect(query.sql).toMatch(/"lastSeenDeploymentId" < \$/);
		expect(query.params).toContain(120);
		expect(query.params).toContain("w1");
	});

	it("saves the other fields unconditionally and lastSeen conditionally", async () => {
		await patchGithubWatch("w1", {
			lastSeenDeploymentId: 130,
			lastError: null,
			etag: 'W/"n"',
		});
		expect(mocks.updates).toHaveLength(2);
		expect(mocks.updates[0]?.values).toEqual({
			lastError: null,
			etag: 'W/"n"',
		});
		expect(mocks.updates[1]?.values).toEqual({ lastSeenDeploymentId: 130 });
	});

	it("a patch without a cursor does not touch it", async () => {
		await patchGithubWatch("w1", { lastCheckedAt: new Date(0) });
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]?.values).not.toHaveProperty("lastSeenDeploymentId");
	});
});

describe("listing watches", () => {
	it("returns nothing, without a query, for a member with no services", async () => {
		expect(await listGithubWatchesForOrganization("org-a", [])).toEqual([]);
		expect(mocks.selectCalls).toBe(0);
	});

	it("queries for an owner or admin (null) and for a member with services", async () => {
		mocks.selectRows = [existing()];
		expect(await listGithubWatchesForOrganization("org-a", null)).toHaveLength(
			1,
		);
		expect(
			await listGithubWatchesForOrganization("org-a", ["app-1"]),
		).toHaveLength(1);
		expect(mocks.selectCalls).toBe(2);
	});

	it("presents the opt-in flag but never a token", () => {
		const presented = presentGithubWatch(
			existing({ postLogUrl: true }) as never,
		);
		expect(presented.postLogUrl).toBe(true);
		expect(JSON.stringify(presented)).not.toMatch(/token/i);
	});
});

describe("the ghcr credentials", () => {
	it("name the watch and its owner, which scope the login", async () => {
		// findGithubWatch, then the connection row
		mocks.selectQueue = [
			[existing()],
			[{ githubLogin: "amin", accessToken: "gho_x", status: "active" }],
		];
		const credentials = await loadGhcrCredentials("application", "app-1");
		expect(credentials).toMatchObject({
			watchId: "w1",
			owner: "DevinoSolutions",
			registryUrl: "ghcr.io",
			username: "amin",
		});
	});
});
