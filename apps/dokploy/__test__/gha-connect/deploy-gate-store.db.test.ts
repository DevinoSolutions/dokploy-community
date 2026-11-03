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

describe.skipIf(!ready)("the store the gate writes through", () => {
	it("marks and clears the start, and records the outcome with the learned set once", async () => {
		const connection = await connect();
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		const releaseId = String(
			await row("gha_release", "runId", "100", "releaseId"),
		);
		const at = new Date("2026-11-03T11:00:00Z");
		await gate.dbDeployGateStore.markGateStarted(
			connection.ghaConnectionId,
			at,
		);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toEqual(at);
		await gate.dbDeployGateStore.recordGateOutcome(releaseId, {
			gateState: "waiting",
			gateReason: "Waiting for test",
			checkedAt: at,
			gateExpected: { source: "required", names: ["build", "test"] },
		});
		// A later outcome without a set leaves the learned one alone.
		await gate.dbDeployGateStore.recordGateOutcome(releaseId, {
			gateState: "passed",
			gateReason: null,
			checkedAt: at,
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release).toMatchObject({
			gateState: "passed",
			gateReason: null,
			gateExpected: { source: "required", names: ["build", "test"] },
		});
		await gate.dbDeployGateStore.clearGateStart(connection.ghaConnectionId);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toBeNull();
	});

	it("blocks and unblocks the connection through the state machine", async () => {
		const connection = await connect({ deployedSha: SHA_B });
		await gate.dbDeployGateStore.blockConnection(
			connection.ghaConnectionId,
			"Check test failed",
		);
		let current = await base.findGhaConnectionById(connection.ghaConnectionId);
		expect(current).toMatchObject({
			state: "blocked",
			stateDetail: "Check test failed",
			lastError: "Check test failed",
		});
		await gate.dbDeployGateStore.unblockConnection(
			connection.ghaConnectionId,
			true,
		);
		current = await base.findGhaConnectionById(connection.ghaConnectionId);
		expect(current).toMatchObject({ state: "connected", lastError: null });
		// Without a release yet it goes back to waiting; and unblocking a connection that is not blocked does nothing.
		await gate.dbDeployGateStore.blockConnection(
			connection.ghaConnectionId,
			"x",
		);
		await gate.dbDeployGateStore.unblockConnection(
			connection.ghaConnectionId,
			false,
		);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))?.state,
		).toBe("waiting");
		await gate.dbDeployGateStore.unblockConnection(
			connection.ghaConnectionId,
			false,
		);
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))?.state,
		).toBe("waiting");
	});
});

describe.skipIf(!ready)("updateGateSettings", () => {
	const blockedConnection = async () => {
		const connection = await connect({
			state: "blocked",
			stateDetail: "Check test failed",
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await client?.exec(
			`UPDATE "gha_release" SET "gateState" = 'blocked', "gateReason" = 'Check test failed', "gateExpected" = '{"source":"required","names":["test"]}' WHERE "runId" = 100`,
		);
		return connection;
	};

	it("a mode change clears Blocked, the start, and the gate state of waiting releases", async () => {
		const connection = await blockedConnection();
		const result = await gate.updateGateSettings(connection.ghaConnectionId, {
			gateMode: "workflows",
			gateWorkflows: ["CI"],
		});
		expect(result).toEqual({ gateMode: "workflows", restarted: true });
		expect(
			await base.findGhaConnectionById(connection.ghaConnectionId),
		).toMatchObject({
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateStartedAt: null,
			state: "waiting",
			lastError: null,
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release).toMatchObject({
			gateState: null,
			gateReason: null,
			gateExpected: null,
		});
	});

	it("changing the workflows of the workflows gate starts over, the same list does not", async () => {
		const connection = await connect({
			gateMode: "workflows",
			gateWorkflows: ["CI"],
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		expect(
			await gate.updateGateSettings(connection.ghaConnectionId, {
				gateWorkflows: ["CI"],
			}),
		).toEqual({ gateMode: "workflows", restarted: false });
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).not.toBeNull();
		expect(
			await gate.updateGateSettings(connection.ghaConnectionId, {
				gateWorkflows: ["CI", "Lint"],
			}),
		).toEqual({ gateMode: "workflows", restarted: true });
		expect(
			(await base.findGhaConnectionById(connection.ghaConnectionId))
				?.gateStartedAt,
		).toBeNull();
	});

	it("a timeout change alone keeps the blocked state, the start and the gate state", async () => {
		const connection = await blockedConnection();
		const result = await gate.updateGateSettings(connection.ghaConnectionId, {
			gateTimeoutMinutes: 120,
		});
		expect(result).toEqual({ gateMode: "checks", restarted: false });
		expect(
			await base.findGhaConnectionById(connection.ghaConnectionId),
		).toMatchObject({
			gateTimeoutMinutes: 120,
			state: "blocked",
		});
		const [release] = await base.listReleases(connection.ghaConnectionId);
		expect(release?.gateState).toBe("blocked");
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
	it("marks the newest accepted release, keeps who/when/why, and unblocks", async () => {
		const connection = await connect({
			state: "blocked",
			stateDetail: "Check test failed",
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
		});
		await accept(connection.ghaConnectionId, SHA_A, 100, "2026-11-03 10:00:00");
		await accept(connection.ghaConnectionId, SHA_B, 101, "2026-11-03 10:05:00");
		const override = {
			by: "amin@devino.ca",
			at: "2026-11-03T11:00:00.000Z",
			reason: "hotfix",
		};
		const result = await gate.overrideGate(
			connection.ghaConnectionId,
			override,
		);
		expect(result?.sha).toBe(SHA_B);
		const releases = await base.listReleases(connection.ghaConnectionId);
		const newest = releases.find((r) => r.sha === SHA_B);
		const older = releases.find((r) => r.sha === SHA_A);
		expect(newest).toMatchObject({
			gateState: "overridden",
			gateReason: "Deployed anyway by amin@devino.ca",
			gateOverride: override,
		});
		expect(older?.gateState).toBeNull();
		expect(
			await base.findGhaConnectionById(connection.ghaConnectionId),
		).toMatchObject({
			gateStartedAt: null,
			state: "waiting",
		});
	});

	it("is null when no release is waiting", async () => {
		const connection = await connect();
		expect(
			await gate.overrideGate(connection.ghaConnectionId, {
				by: "a",
				at: new Date().toISOString(),
				reason: null,
			}),
		).toBeNull();
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
