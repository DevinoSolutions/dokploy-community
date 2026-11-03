import { drizzle } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	migrationStatements,
	PGliteClass,
} from "../helpers/pglite-deployments";

/**
 * The deploy gate's storage against a real Postgres (PGlite): migration 0230 on top of 0229 (applied
 * twice), the defaults an existing connection gets, and the real SQL of the settings change, Deploy
 * anyway and the store `runDeployGate` writes through.
 */

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@dokploy/server/db", () => ({
	db: new Proxy(
		{},
		{
			get: (_target, key) => (holder.db as Record<PropertyKey, unknown>)[key],
		},
	),
}));

const schema = await import("@dokploy/server/db/schema");
const base = await import("@dokploy/server/services/gha-connect/store");
const gate = await import(
	"@dokploy/server/services/gha-connect/deploy-gate-store"
);

type Client = {
	exec: (sql: string) => Promise<unknown>;
	query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
	close: () => Promise<void>;
};
let client: Client | null = null;
const ready = PGliteClass !== null;

const FILES_BEFORE_GATE = [
	"0228_github_deployment_watch.sql",
	"0229_gha_connection.sql",
];

beforeAll(async () => {
	if (!PGliteClass) return;
	const pg = new PGliteClass() as unknown as Client;
	client = pg;
	holder.db = drizzle(pg as never, { schema });
	await pg.exec('CREATE TABLE "organization" ("id" text PRIMARY KEY)');
	await pg.exec(
		'CREATE TABLE "application" ("applicationId" text PRIMARY KEY)',
	);
	await pg.exec('CREATE TABLE "compose" ("composeId" text PRIMARY KEY)');
	for (const file of FILES_BEFORE_GATE) {
		for (const statement of migrationStatements(file)) await pg.exec(statement);
	}
	// A connection that exists before the gate migration, as on an updated install.
	await pg.exec(`INSERT INTO "organization" ("id") VALUES ('org-a')`);
	await pg.exec(
		`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","githubLogin","githubUserId","accessToken") VALUES ('gh-1','org-a','u1','amin','1','not-a-real-token')`,
	);
	await pg.exec(
		`INSERT INTO "gha_connection" ("ghaConnectionId","organizationId","serviceType","serviceId","githubConnectionId","repoId","repoFullName","trackedBranch","environment","serviceKey") VALUES ('legacy','org-a','compose','legacy-svc','gh-1',1,'a/b','main','production','legacy')`,
	);
	await pg.exec(
		`INSERT INTO "gha_release" ("releaseId","ghaConnectionId","manifestReleaseId","sha","runId","runAttempt","delivery","status","images","digests") VALUES ('legacy-rel','legacy','gh-1.1','${"1".repeat(40)}',1,1,'pull','deployed','[]','[]')`,
	);
	// 0230, then again: every statement is guarded.
	for (const file of ["0230_gha_deploy_gate.sql", "0230_gha_deploy_gate.sql"]) {
		for (const statement of migrationStatements(file)) await pg.exec(statement);
	}
}, 120_000);

afterAll(async () => {
	await client?.close();
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

beforeEach(async () => {
	if (!client) return;
	await client.exec(
		`DELETE FROM "gha_release" WHERE "releaseId" <> 'legacy-rel'`,
	);
	await client.exec(
		`DELETE FROM "gha_connection" WHERE "ghaConnectionId" <> 'legacy'`,
	);
});

const connect = (overrides: Record<string, unknown> = {}) =>
	base.createGhaConnection({
		organizationId: "org-a",
		serviceType: "compose",
		serviceId: "svc-1",
		githubConnectionId: "gh-1",
		repoId: 10,
		repoFullName: "acme/shop",
		trackedBranch: "main",
		environment: "production",
		serviceKey: "shop",
		gateMode: "checks",
		...overrides,
	});

const accept = async (
	ghaConnectionId: string,
	sha: string,
	runId: number,
	createdAt: string,
) => {
	await base.recordRelease({
		ghaConnectionId,
		manifestReleaseId: `gh-${runId}.1`,
		sha,
		runId,
		runAttempt: 1,
		delivery: "pull",
		status: "accepted",
		githubDeploymentId: runId,
		images: [],
		digests: [],
	});
	await client?.exec(
		`UPDATE "gha_release" SET "createdAt" = '${createdAt}' WHERE "runId" = ${runId}`,
	);
};

const row = async (table: string, key: string, id: string, column: string) =>
	(
		await client?.query(
			`SELECT "${column}" AS v FROM "${table}" WHERE "${key}" = '${id}'`,
		)
	)?.rows[0]?.v;

describe.skipIf(!ready)("migration 0230", () => {
	it("gives a connection that existed before it the old behaviour", async () => {
		const legacy = await row(
			"gha_connection",
			"ghaConnectionId",
			"legacy",
			"gateMode",
		);
		expect(legacy).toBe("image");
		expect(
			await row("gha_connection", "ghaConnectionId", "legacy", "gateWorkflows"),
		).toEqual([]);
		expect(
			await row(
				"gha_connection",
				"ghaConnectionId",
				"legacy",
				"gateTimeoutMinutes",
			),
		).toBe(60);
		for (const column of [
			"gateState",
			"gateReason",
			"gateCheckedAt",
			"gateExpected",
			"gateOverride",
		]) {
			expect(
				await row("gha_release", "releaseId", "legacy-rel", column),
				column,
			).toBeNull();
		}
	});

	it("added each column once, so a replay changed nothing", async () => {
		const columns = (
			await client?.query(
				`SELECT column_name FROM information_schema.columns WHERE table_name IN ('gha_connection','gha_release') AND column_name LIKE 'gate%' ORDER BY 1`,
			)
		)?.rows.map((r) => String(r.column_name));
		expect(columns).toEqual([
			"gateBlocked",
			"gateCheckedAt",
			"gateExpected",
			"gateMode",
			"gateOverride",
			"gateReason",
			"gateStartedAt",
			"gateState",
			"gateTimeoutMinutes",
			"gateWorkflows",
		]);
	});
});

const outcome = (
	overrides: Partial<Parameters<typeof gate.dbDeployGateStore.recordGateOutcome>[2]> = {},
) => ({
	gateState: "waiting" as const,
	gateReason: "Waiting for test",
	checkedAt: new Date("2026-11-03T11:00:00Z"),
	previousCheckedAt: null,
	gateStart: "keep" as const,
	connection: "keep" as const,
	hasRelease: false,
	...overrides,
});

const releaseIdOf = async (runId: number) =>
	String(await row("gha_release", "runId", String(runId), "releaseId"));

describe.skipIf(!ready)("the store the gate writes through", () => {
	it("records the outcome with the learned set once, marks and clears the start", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = await releaseIdOf(100);
		const at = new Date("2026-11-03T11:00:00Z");
		expect(
			await gate.dbDeployGateStore.recordGateOutcome(
				connection.ghaConnectionId,
				releaseId,
				outcome({
					gateExpected: { source: "required", names: ["build", "test"] },
					gateStart: "mark",
				}),
			),
		).toBe(true);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toEqual(at);
		// The next evaluation read gateCheckedAt = at; it leaves the learned set alone.
		expect(
			await gate.dbDeployGateStore.recordGateOutcome(
				connection.ghaConnectionId,
				releaseId,
				outcome({
					gateState: "passed",
					gateReason: null,
					previousCheckedAt: at,
					checkedAt: new Date("2026-11-03T11:01:00Z"),
					gateStart: "clear",
				}),
			),
		).toBe(true);
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release).toMatchObject({
			gateState: "passed",
			gateReason: null,
			gateExpected: { source: "required", names: ["build", "test"] },
		});
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toBeNull();
	});

	it("never overwrites an override from a Deploy anyway that came in meanwhile", async () => {
		const connection = await connect({
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = await releaseIdOf(100);
		await gate.overrideGate(connection.ghaConnectionId, releaseId, {
			by: "amin@devino.ca",
			at: "2026-11-03T11:00:00.000Z",
			reason: null,
		});
		const wrote = await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({
				gateState: "blocked",
				gateReason: "Check test failed",
				connection: "block",
				gateStart: "mark",
			}),
		);
		expect(wrote).toBe(false);
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release).toMatchObject({ gateState: "overridden" });
		// And it did not block the connection or move its start either.
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			state: "waiting",
			gateBlocked: false,
			gateStartedAt: null,
		});
	});

	it("is a compare-and-set on gateCheckedAt: a stale evaluation writes nothing", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = await releaseIdOf(100);
		const first = new Date("2026-11-03T11:00:00Z");
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({ checkedAt: first }),
		);
		// Another evaluation read gateCheckedAt = null before the first one wrote.
		expect(
			await gate.dbDeployGateStore.recordGateOutcome(
				connection.ghaConnectionId,
				releaseId,
				outcome({ gateState: "passed", gateReason: null, previousCheckedAt: null }),
			),
		).toBe(false);
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release?.gateState).toBe("waiting");
	});

	it("writes nothing for a release that is no longer accepted", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await client?.exec(
			`UPDATE "gha_release" SET "status" = 'deployed' WHERE "runId" = 100`,
		);
		expect(
			await gate.dbDeployGateStore.recordGateOutcome(
				connection.ghaConnectionId,
				await releaseIdOf(100),
				outcome(),
			),
		).toBe(false);
	});

	it("blocks the connection, marking the block as the gate's, and lifts only that", async () => {
		const connection = await connect({ deployedSha: SHA_B });
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = await releaseIdOf(100);
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({
				gateState: "blocked",
				gateReason: "Check test failed",
				connection: "block",
			}),
		);
		let current = await base.findGhaConnectionById(connection.ghaConnectionId);
		expect(current).toMatchObject({
			state: "blocked",
			stateDetail: "Check test failed",
			lastError: "Check test failed",
			gateBlocked: true,
		});
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({
				gateState: "passed",
				gateReason: null,
				previousCheckedAt: new Date("2026-11-03T11:00:00Z"),
				checkedAt: new Date("2026-11-03T11:05:00Z"),
				connection: "unblock",
				hasRelease: true,
			}),
		);
		current = await base.findGhaConnectionById(connection.ghaConnectionId);
		expect(current).toMatchObject({
			state: "connected",
			lastError: null,
			gateBlocked: false,
		});
	});

	it("without a release yet, unblocking goes back to waiting", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = await releaseIdOf(100);
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({ gateState: "blocked", connection: "block" }),
		);
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({
				previousCheckedAt: new Date("2026-11-03T11:00:00Z"),
				checkedAt: new Date("2026-11-03T11:05:00Z"),
				connection: "unblock",
				hasRelease: false,
			}),
		);
		expect((await base.findGhaConnectionById(connection.ghaConnectionId))?.state).toBe(
			"waiting",
		);
	});

	it("never touches a block the gate did not set", async () => {
		const connection = await connect({
			state: "blocked",
			stateDetail: "Digest not in the registry",
			gateBlocked: false,
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = await releaseIdOf(100);
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({ gateState: "blocked", connection: "block" }),
		);
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			state: "blocked",
			stateDetail: "Digest not in the registry",
			gateBlocked: false,
		});
		await gate.dbDeployGateStore.recordGateOutcome(
			connection.ghaConnectionId,
			releaseId,
			outcome({
				previousCheckedAt: new Date("2026-11-03T11:00:00Z"),
				checkedAt: new Date("2026-11-03T11:05:00Z"),
				connection: "unblock",
			}),
		);
		expect((await base.findGhaConnectionById(connection.ghaConnectionId))?.state).toBe(
			"blocked",
		);
	});

	it("clearGateStart clears the start", async () => {
		const connection = await connect({
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		await gate.dbDeployGateStore.clearGateStart(connection.ghaConnectionId);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toBeNull();
	});
});

describe.skipIf(!ready)("updateGateSettings", () => {
	const blockedByGate = async (overrides: Record<string, unknown> = {}) => {
		const connection = await connect({
			state: "blocked",
			stateDetail: "Check test failed",
			gateBlocked: true,
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
			...overrides,
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await client?.exec(
			`UPDATE "gha_release" SET "gateState" = 'blocked', "gateReason" = 'Check test failed', "gateCheckedAt" = '2026-11-03 10:30:00', "gateExpected" = '{"source":"required","names":["test"]}' WHERE "runId" = 100`,
		);
		return connection;
	};

	it("a mode change clears the gate's block, the start, and the gate state of waiting releases", async () => {
		const connection = await blockedByGate();
		const result = await gate.updateGateSettings(connection.ghaConnectionId, {
			gateMode: "workflows",
			gateWorkflows: ["CI"],
		});
		expect(result?.restarted).toBe(true);
		expect(result?.before).toEqual({
			gateMode: "checks",
			gateWorkflows: [],
			gateTimeoutMinutes: 60,
		});
		expect(result?.after).toEqual({
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateTimeoutMinutes: 60,
		});
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateStartedAt: null,
			state: "waiting",
			gateBlocked: false,
			lastError: null,
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release).toMatchObject({
			gateState: null,
			gateReason: null,
			gateCheckedAt: null,
			gateExpected: null,
		});
	});

	it("does not clear a block the gate did not set", async () => {
		const connection = await blockedByGate({ gateBlocked: false });
		await gate.updateGateSettings(connection.ghaConnectionId, {
			gateMode: "image",
		});
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			state: "blocked",
			stateDetail: "Check test failed",
		});
	});

	it("does not null a release that was told to Deploy anyway", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await gate.overrideGate(connection.ghaConnectionId, await releaseIdOf(100), {
			by: "amin@devino.ca",
			at: "2026-11-03T11:00:00.000Z",
			reason: null,
		});
		await gate.updateGateSettings(connection.ghaConnectionId, {
			gateMode: "workflows",
			gateWorkflows: ["CI"],
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release).toMatchObject({
			gateState: "overridden",
			gateOverride: { by: "amin@devino.ca" },
		});
	});

	it("changing the workflows of the workflows gate starts over, the same list does not", async () => {
		const connection = await connect({
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		expect(
			(
				await gate.updateGateSettings(connection.ghaConnectionId, {
					gateWorkflows: ["CI"],
				})
			)?.restarted,
		).toBe(false);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).not.toBeNull();
		expect(
			(
				await gate.updateGateSettings(connection.ghaConnectionId, {
					gateWorkflows: ["CI", "Lint"],
				})
			)?.restarted,
		).toBe(true);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toBeNull();
	});

	it("a longer wait restarts the timer and lifts the gate's block, keeping the gate state", async () => {
		const connection = await blockedByGate();
		const result = await gate.updateGateSettings(connection.ghaConnectionId, {
			gateTimeoutMinutes: 120,
		});
		expect(result?.restarted).toBe(true);
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			gateTimeoutMinutes: 120,
			gateStartedAt: null,
			state: "waiting",
			gateBlocked: false,
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		// The compare-and-set value is gone, so an evaluation in flight is discarded.
		expect(release).toMatchObject({
			gateState: "blocked",
			gateCheckedAt: null,
			gateExpected: { source: "required", names: ["test"] },
		});
	});

	it("a shorter wait changes nothing else", async () => {
		const connection = await blockedByGate();
		const result = await gate.updateGateSettings(connection.ghaConnectionId, {
			gateTimeoutMinutes: 30,
		});
		expect(result?.restarted).toBe(false);
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			gateTimeoutMinutes: 30,
			state: "blocked",
			gateBlocked: true,
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release?.gateState).toBe("blocked");
		expect(release?.gateCheckedAt).not.toBeNull();
	});

	it("leaves releases that already went out alone", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await client?.exec(
			`UPDATE "gha_release" SET "status" = 'deployed', "gateState" = 'passed' WHERE "runId" = 100`,
		);
		await gate.updateGateSettings(connection.ghaConnectionId, {
			gateMode: "image",
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release?.gateState).toBe("passed");
	});

	it("returns null for a connection that is gone", async () => {
		expect(
			await gate.updateGateSettings("nope", { gateMode: "image" }),
		).toBeNull();
	});
});

describe.skipIf(!ready)("overrideGate (deploy anyway)", () => {
	const override = {
		by: "amin@devino.ca",
		at: "2026-11-03T11:00:00.000Z",
		reason: "hotfix",
	};

	it("marks the named release when it is the newest accepted one, keeps who/when/why, and lifts the gate's block", async () => {
		const connection = await connect({
			state: "blocked",
			stateDetail: "Check test failed",
			gateBlocked: true,
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await accept(connection.ghaConnectionId, SHA_B, 101, "2026-11-03 10:05:00");
		const result = await gate.overrideGate(
			connection.ghaConnectionId,
			await releaseIdOf(101),
			override,
		);
		expect(result).toMatchObject({ kind: "ok", sha: SHA_B });
		const releases = await base.listReleases(connection.ghaConnectionId);
		const newest = releases.find((r) => r.sha === SHA_B);
		const older = releases.find((r) => r.sha === SHA_A);
		expect(newest).toMatchObject({
			gateState: "overridden",
			gateReason: "Deployed anyway by amin@devino.ca",
			gateOverride: override,
		});
		expect(older?.gateState).toBeNull();
		expect(await base.findGhaConnectionById(connection.ghaConnectionId)).toMatchObject({
			gateStartedAt: null,
			state: "waiting",
			gateBlocked: false,
		});
	});

	it("refuses a release that is not the newest accepted one, and changes nothing", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await accept(connection.ghaConnectionId, SHA_B, 101, "2026-11-03 10:05:00");
		const result = await gate.overrideGate(
			connection.ghaConnectionId,
			await releaseIdOf(100),
			override,
		);
		expect(result).toMatchObject({ kind: "conflict", newestSha: SHA_B });
		const releases = await base.listReleases(connection.ghaConnectionId);
		expect(releases.every((r) => r.gateState === null)).toBe(true);
	});

	it("leaves a block the gate did not set", async () => {
		const connection = await connect({
			state: "blocked",
			stateDetail: "Digest not in the registry",
			gateBlocked: false,
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await gate.overrideGate(
			connection.ghaConnectionId,
			await releaseIdOf(100),
			override,
		);
		expect((await base.findGhaConnectionById(connection.ghaConnectionId))?.state).toBe(
			"blocked",
		);
	});

	it("says none when no release is waiting", async () => {
		const connection = await connect();
		expect(
			await gate.overrideGate(connection.ghaConnectionId, "nope", override),
		).toEqual({ kind: "none" });
	});

	it("findGatedRelease is the newest accepted one", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await accept(connection.ghaConnectionId, SHA_B, 101, "2026-11-03 10:05:00");
		expect((await gate.findGatedRelease(connection.ghaConnectionId))?.sha).toBe(
			SHA_B,
		);
	});
});
