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
 * The store functions the connection poll adds (accepted releases, supersede,
 * fail, rename, run cursor) against a real Postgres (PGlite) built from the
 * real migrations.
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
const watches = await import(
	"@dokploy/server/services/github-deployments/store"
);

type Client = {
	exec: (sql: string) => Promise<unknown>;
	query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
	close: () => Promise<void>;
};
let client: Client | null = null;
const ready = PGliteClass !== null;

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
	for (const file of [
		"0228_github_deployment_watch.sql",
		"0229_gha_connection.sql",
		"0230_gha_deploy_gate.sql",
		"0231_gha_release_source.sql",
	]) {
		for (const statement of migrationStatements(file)) await pg.exec(statement);
	}
}, 120_000);

afterAll(async () => {
	await client?.close();
});

beforeEach(async () => {
	if (!client) return;
	await client.exec(
		'TRUNCATE "gha_release", "gha_connection", "github_deployment_watch", "github_deployment_connection", "organization", "application", "compose" CASCADE',
	);
	await client.exec(`INSERT INTO "organization" ("id") VALUES ('org-a')`);
	await client.exec(
		`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","githubLogin","githubUserId","accessToken") VALUES ('gh-1','org-a','u1','amin','1','not-a-real-token')`,
	);
});

const connection = () =>
	store.createGhaConnection({
		organizationId: "org-a",
		serviceType: "compose",
		serviceId: "compose-1",
		githubConnectionId: "gh-1",
		repoId: 123,
		repoFullName: "acme/shop",
		trackedBranch: "main",
		environment: "production",
		serviceKey: "shop",
	});

const release = (
	ghaConnectionId: string,
	runId: number,
	status: "accepted" | "deployed" = "accepted",
	attempt = 1,
) => ({
	ghaConnectionId,
	manifestReleaseId: `gh-${runId}.${attempt}`,
	sha: "a".repeat(40),
	runId,
	runAttempt: attempt,
	delivery: "pull" as const,
	status,
	githubDeploymentId: runId + 1000,
	images: [{ name: "web", composeService: "web", ref: "r/web@sha256:1" }],
	digests: ["sha256:1"],
});

const status = async (runId: number) =>
	(
		await client?.query(
			`SELECT status, "settledAt" FROM "gha_release" WHERE "runId" = ${runId}`,
		)
	)?.rows[0];

describe.skipIf(!ready)("accepted releases", () => {
	it("lists only the accepted ones, newest run and attempt first", async () => {
		const c = await connection();
		await store.recordRelease(release(c.ghaConnectionId, 100));
		await store.recordRelease(release(c.ghaConnectionId, 200));
		await store.recordRelease(release(c.ghaConnectionId, 200, "accepted", 2));
		await store.recordRelease(release(c.ghaConnectionId, 300, "deployed"));
		const pending = await store.listPendingReleases(c.ghaConnectionId);
		expect(pending.map((r) => [r.runId, r.runAttempt])).toEqual([
			[200, 2],
			[200, 1],
			[100, 1],
		]);
		expect(pending[0]).toMatchObject({ settledAt: null, gateState: null });
	});

	it("keeps a repeated acceptance as one row", async () => {
		const c = await connection();
		await store.recordRelease(release(c.ghaConnectionId, 100));
		await store.recordRelease(release(c.ghaConnectionId, 100));
		expect(await store.listPendingReleases(c.ghaConnectionId)).toHaveLength(1);
	});

	it("supersedes accepted releases and never touches a deployed one", async () => {
		const c = await connection();
		await store.recordRelease(release(c.ghaConnectionId, 100));
		await store.recordRelease(release(c.ghaConnectionId, 200, "deployed"));
		const [accepted] = await store.listPendingReleases(c.ghaConnectionId);
		await store.supersedeReleases(c.ghaConnectionId, [
			accepted?.releaseId as string,
			"nope",
		]);
		await store.supersedeReleases(c.ghaConnectionId, []);
		expect(await status(100)).toMatchObject({ status: "superseded" });
		expect((await status(100))?.settledAt).not.toBeNull();
		expect(await status(200)).toMatchObject({ status: "deployed" });
		expect(await store.listPendingReleases(c.ghaConnectionId)).toEqual([]);
	});

	it("fails an accepted release once, and only for its own connection", async () => {
		const c = await connection();
		await store.recordRelease(release(c.ghaConnectionId, 100));
		const [accepted] = await store.listPendingReleases(c.ghaConnectionId);
		await store.failAcceptedRelease(
			"other-connection",
			accepted?.releaseId as string,
		);
		expect(await status(100)).toMatchObject({ status: "accepted" });
		await store.failAcceptedRelease(
			c.ghaConnectionId,
			accepted?.releaseId as string,
		);
		expect(await status(100)).toMatchObject({ status: "failed" });
	});

	it("a deployed release is no longer pending after settleRelease", async () => {
		const c = await connection();
		await store.recordRelease(release(c.ghaConnectionId, 100));
		await store.settleRelease(c.ghaConnectionId, 1100, "deployed");
		expect(await store.listPendingReleases(c.ghaConnectionId)).toEqual([]);
	});
});

describe.skipIf(!ready)("a renamed repository", () => {
	it("updates the connection and the owner and repo its watch polls under, keeping the cursor", async () => {
		const c = await connection();
		await watches.upsertGithubWatch({
			organizationId: "org-a",
			serviceType: "compose",
			serviceId: "compose-1",
			connectionId: "gh-1",
			owner: "acme",
			repo: "shop",
			environment: "production",
			enabled: true,
		});
		await watches.patchGithubWatch(
			(await watches.findGithubWatch("compose", "compose-1"))
				?.watchId as string,
			{ lastSeenDeploymentId: 55, etag: "e" },
		);
		expect(
			await store.renameGhaConnectionRepository(
				c.ghaConnectionId,
				"acme/shop-v2",
			),
		).toBe(true);
		expect(
			(await store.findGhaConnectionById(c.ghaConnectionId))?.repoFullName,
		).toBe("acme/shop-v2");
		expect(await watches.findGithubWatch("compose", "compose-1")).toMatchObject(
			{
				owner: "acme",
				repo: "shop-v2",
				lastSeenDeploymentId: 55,
			},
		);
	});

	it("refuses a name that is not owner/repo", async () => {
		const c = await connection();
		expect(
			await store.renameGhaConnectionRepository(c.ghaConnectionId, "nonsense"),
		).toBe(false);
	});
});

describe.skipIf(!ready)("the run cursor", () => {
	it("remembers the newest run seen and counts it as activity", async () => {
		const c = await connection();
		await store.recordRunSeen(c.ghaConnectionId, 900);
		const row = await store.findGhaConnectionById(c.ghaConnectionId);
		expect(row?.lastRunSeenId).toBe(900);
		expect(row?.lastActivityAt).not.toBeNull();
	});
});
