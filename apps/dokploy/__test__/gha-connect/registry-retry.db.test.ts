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
 * T-15783: a pull release whose image the registry does not serve yet is retried, not failed. The real migrations
 * 0228 to 0233 create the tables, then the store's real SQL runs: the schedule (60, 120, 240, 300 seconds), the
 * repeat of a call that already scheduled, a retry that ran out, any other error, a newer release that supersedes a
 * waiting one and a retry that finally deploys.
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
const store = await import("@dokploy/server/services/gha-connect/store");

type Client = {
	exec: (sql: string) => Promise<unknown>;
	query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
	close: () => Promise<void>;
};
let client: Client | null = null;
const ready = PGliteClass !== null;

const FILES = [
	"0228_github_deployment_watch.sql",
	"0229_gha_connection.sql",
	"0230_gha_deploy_gate.sql",
	"0231_gha_release_source.sql",
	"0233_gha_release_registry_retry.sql",
	// A second run: every statement is guarded, a replay is a no-op.
	"0233_gha_release_registry_retry.sql",
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
	for (const file of FILES) {
		for (const statement of migrationStatements(file)) await pg.exec(statement);
	}
}, 120_000);

afterAll(async () => {
	await client?.close();
});

// What the poll tells the store: the registry refused the image (true), or any other failure (false).
const DENIED = true;
const CRASH = false;

const T0 = new Date("2026-11-08T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let connectionId = "";

beforeEach(async () => {
	if (!client) return;
	await client.exec(
		'TRUNCATE "gha_release", "gha_connection", "github_deployment_watch", "github_deployment_connection", "organization", "application", "compose" CASCADE',
	);
	await client.exec(`INSERT INTO "organization" ("id") VALUES ('org-a')`);
	await client.exec(
		`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","githubLogin","githubUserId","accessToken") VALUES ('gh-1','org-a','u1','amin','1','not-a-real-token')`,
	);
	const row = await store.createGhaConnection({
		organizationId: "org-a",
		serviceType: "application",
		serviceId: "app-1",
		githubConnectionId: "gh-1",
		repoId: 123,
		repoFullName: "DevinoSolutions/voicelabs",
		trackedBranch: "main",
		environment: "production",
		serviceKey: "landing",
	});
	connectionId = row.ghaConnectionId;
});

const accept = async (runId: number, deploymentId: number) => {
	await store.recordRelease({
		ghaConnectionId: connectionId,
		manifestReleaseId: `gh-${runId}.1`,
		sha: String(runId).padEnd(40, "b"),
		runId,
		runAttempt: 1,
		delivery: "pull",
		status: "accepted",
		githubDeploymentId: deploymentId,
		images: [
			{
				name: "landing",
				composeService: "landing",
				ref: `x@sha256:${"c".repeat(64)}`,
			},
		],
		digests: [`sha256:${"c".repeat(64)}`],
	});
};

const releaseOf = async (deploymentId: number) => {
	const rows = await store.listReleases(connectionId);
	const row = rows.find((r) => r.githubDeploymentId === deploymentId);
	if (!row) throw new Error("no release");
	return row;
};

describe.skipIf(!ready)("a release the registry refuses is retried", () => {
	it("adds the two columns, with a default that leaves old rows untouched", async () => {
		await accept(100, 11);
		const row = await releaseOf(11);
		expect(row.retryAt).toBeNull();
		expect(row.retryAttempt).toBe(0);
	});

	it("registry error: stays accepted with retryAt and attempt, not failed", async () => {
		await accept(100, 11);
		const verdict = await store.settleReleaseFailure(
			connectionId,
			11,
			DENIED,
			T0,
		);
		expect(verdict).toEqual({
			kind: "retry",
			text: "Image not readable at the registry yet; retrying in 60 s (1/4)",
		});
		const row = await releaseOf(11);
		expect(row.status).toBe("accepted");
		expect(row.settledAt).toBeNull();
		expect(row.retryAttempt).toBe(1);
		expect(row.retryAt?.getTime()).toBe(at(60).getTime());
		// The connection stays polled at the active cadence.
		const connection = await store.findGhaConnectionById(connectionId);
		expect(connection?.lastActivityAt?.getTime()).toBe(T0.getTime());
		expect(connection?.deployedSha).toBeNull();
	});

	it("backs off 60, 120, 240 and 300 seconds, then settles failed with the note", async () => {
		await accept(100, 11);
		const delays: number[] = [];
		let now = T0;
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const verdict = await store.settleReleaseFailure(
				connectionId,
				11,
				DENIED,
				now,
			);
			expect(verdict.kind).toBe("retry");
			const row = await releaseOf(11);
			expect(row.retryAttempt).toBe(attempt);
			delays.push(((row.retryAt as Date).getTime() - now.getTime()) / 1000);
			// The retry starts (the poller clears the time when it claims the release) and fails again.
			await client?.exec(`UPDATE "gha_release" SET "retryAt" = NULL`);
			now = new Date((row.retryAt as Date).getTime());
		}
		expect(delays).toEqual([60, 120, 240, 300]);
		const last = await store.settleReleaseFailure(
			connectionId,
			11,
			DENIED,
			now,
		);
		expect(last).toEqual({
			kind: "exhausted",
			note: expect.stringContaining("after 4 retries"),
		});
		const row = await releaseOf(11);
		expect(row.status).toBe("failed");
		expect(row.settledAt).not.toBeNull();
		expect(row.retryAt).toBeNull();
		expect(
			(await store.findGhaConnectionById(connectionId))?.deployedSha,
		).toBeNull();
	});

	it("any other error settles failed at once", async () => {
		await accept(100, 11);
		const verdict = await store.settleReleaseFailure(
			connectionId,
			11,
			CRASH,
			T0,
		);
		expect(verdict).toEqual({ kind: "settled" });
		const row = await releaseOf(11);
		expect(row).toMatchObject({
			status: "failed",
			retryAttempt: 0,
			retryAt: null,
		});
	});

	it("a repeat of the call that scheduled the retry answers the same and schedules nothing more", async () => {
		await accept(100, 11);
		await store.settleReleaseFailure(connectionId, 11, DENIED, T0);
		const again = await store.settleReleaseFailure(
			connectionId,
			11,
			DENIED,
			at(20),
		);
		expect(again).toEqual({
			kind: "retry",
			text: "Image not readable at the registry yet; retrying in 40 s (1/4)",
		});
		const row = await releaseOf(11);
		expect(row.retryAttempt).toBe(1);
		expect(row.retryAt?.getTime()).toBe(at(60).getTime());
	});

	it("a newer release supersedes the waiting one and its retry is dropped", async () => {
		await accept(100, 11);
		await store.settleReleaseFailure(connectionId, 11, DENIED, T0);
		await accept(200, 12);
		const waiting = await releaseOf(11);
		await store.supersedeReleases(connectionId, [waiting.releaseId]);
		const row = await releaseOf(11);
		expect(row).toMatchObject({ status: "superseded", retryAt: null });
		expect(row.settledAt).not.toBeNull();
		expect((await releaseOf(12)).status).toBe("accepted");
	});

	it("a retry that succeeds deploys the release and becomes the deployed one", async () => {
		await accept(100, 11);
		await store.settleReleaseFailure(connectionId, 11, DENIED, T0);
		await store.settleRelease(connectionId, 11, "deployed");
		const row = await releaseOf(11);
		expect(row).toMatchObject({ status: "deployed", retryAt: null });
		expect(row.settledAt).not.toBeNull();
		const connection = await store.findGhaConnectionById(connectionId);
		expect(connection).toMatchObject({
			deployedSha: String(100).padEnd(40, "b"),
			deployedRunId: 100,
		});
	});

	it("a failed accepted release that could not be started drops its retry time", async () => {
		await accept(100, 11);
		await store.settleReleaseFailure(connectionId, 11, DENIED, T0);
		const waiting = await releaseOf(11);
		await store.failAcceptedRelease(connectionId, waiting.releaseId);
		expect(await releaseOf(11)).toMatchObject({
			status: "failed",
			retryAt: null,
		});
	});

	it("only a pending release with a retry time is listed as waiting", async () => {
		await accept(100, 11);
		await store.settleReleaseFailure(connectionId, 11, DENIED, T0);
		const pending = await store.listPendingReleases(connectionId);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ retryAttempt: 1 });
	});
});
