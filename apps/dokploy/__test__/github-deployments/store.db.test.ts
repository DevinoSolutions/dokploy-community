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
	createTableSql,
	enumSql,
	migrationStatements,
	PGliteClass,
} from "../helpers/pglite-deployments";

/**
 * The GitHub Deployments store against a real Postgres (PGlite): the real 0228
 * migration creates the two tables (and is applied twice, as an update that
 * replays it would), then the connection ownership reads and the "another
 * deployer on this service" query run their real SQL.
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
const store = await import("@dokploy/server/services/github-deployments/store");

type Client = {
	exec: (sql: string) => Promise<unknown>;
	query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
	close: () => Promise<void>;
};
let client: Client | null = null;
const ready = PGliteClass !== null;

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
	if (!PGliteClass) return;
	const pg = new PGliteClass() as unknown as Client;
	client = pg;
	holder.db = drizzle(pg as never, { schema });
	const { statements, names } = enumSql(schema);
	for (const statement of statements) await pg.exec(statement);
	await pg.exec('CREATE TABLE "organization" ("id" text PRIMARY KEY)');
	await pg.exec(
		'CREATE TABLE "member" ("id" text PRIMARY KEY, "organization_id" text, "user_id" text, "role" text)',
	);
	await pg.exec(createTableSql(schema.deployments, names));
	for (const file of [
		"0227_deployment_live_github_run.sql",
		"0228_github_deployment_watch.sql",
		// A second run: the migration is guarded, a replay is a no-op.
		"0228_github_deployment_watch.sql",
		"0236_gha_watch_creator.sql",
		"0236_gha_watch_creator.sql",
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
		'TRUNCATE "deployment", "github_deployment_watch", "github_deployment_connection", "organization", "member" CASCADE',
	);
	await client.exec(
		`INSERT INTO "organization" ("id") VALUES ('org-a'), ('org-b')`,
	);
});

const insertConnection = (
	id: string,
	owner: string | null,
	extra: { shared?: boolean; org?: string } = {},
) =>
	client?.exec(
		`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","sharedWithOrganization","githubLogin","githubUserId","accessToken") VALUES ('${id}','${extra.org ?? "org-a"}',${owner ? `'${owner}'` : "NULL"},${extra.shared ? "true" : "false"},'login-${id}','gh-${id}','not-a-real-token')`,
	);

const insertDeployment = (
	id: string,
	title: string,
	createdAt: number,
	extra: { origin?: string; externalBuildOnly?: boolean; app?: string } = {},
) =>
	client?.exec(
		`INSERT INTO "deployment" ("deploymentId","title","applicationId","createdAt","buildOrigin","externalBuildOnly") VALUES ('${id}','${title}','${extra.app ?? "app-1"}','${new Date(createdAt).toISOString()}',${extra.origin ? `'${extra.origin}'` : "NULL"},${extra.externalBuildOnly ? "true" : "false"})`,
	);

describe.skipIf(!ready)("migration 0228", () => {
	it("names every constraint within Postgres's 63 byte limit, so none is truncated", async () => {
		const rows = (
			await client?.query(
				`SELECT conname FROM pg_constraint WHERE conrelid IN ('github_deployment_connection'::regclass, 'github_deployment_watch'::regclass)`,
			)
		)?.rows;
		const names = (rows ?? []).map((row) => String(row.conname));
		expect(names).toContain("github_deployment_watch_connectionId_fk");
		for (const name of names) {
			expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
		}
	});

	it("has the sharing flag, off by default", async () => {
		await insertConnection("c1", "u1");
		const row = (
			await client?.query(
				`SELECT "sharedWithOrganization" AS s FROM github_deployment_connection WHERE "connectionId" = 'c1'`,
			)
		)?.rows[0];
		expect(row?.s).toBe(false);
	});

	it("deleting a connection removes its watches (the cascade survived the rename)", async () => {
		await insertConnection("c1", "u1");
		await client?.exec(
			`INSERT INTO "github_deployment_watch" ("watchId","organizationId","serviceType","serviceId","connectionId","owner","repo") VALUES ('w1','org-a','application','app-1','c1','o','r')`,
		);
		await client?.exec(
			`DELETE FROM "github_deployment_connection" WHERE "connectionId" = 'c1'`,
		);
		const left = await client?.query(
			"SELECT count(*)::int AS n FROM github_deployment_watch",
		);
		expect(left?.rows[0]?.n).toBe(0);
	});
});

describe.skipIf(!ready)("connection reads", () => {
	it("returns the owner for the access check and the sharing flag, never the token", async () => {
		await insertConnection("c1", "u1", { shared: true });
		const found = await store.findGithubConnectionInOrganization("c1", "org-a");
		expect(found).toMatchObject({
			connectionId: "c1",
			createdByUserId: "u1",
			sharedWithOrganization: true,
		});
		expect(JSON.stringify(found)).not.toContain("not-a-real-token");
		expect(found).not.toHaveProperty("accessToken");
	});

	it("does not find a connection through another organization", async () => {
		await insertConnection("c1", "u1");
		expect(await store.findGithubConnectionInOrganization("c1", "org-b")).toBe(
			null,
		);
	});

	it("lists the organization's connections only", async () => {
		await insertConnection("c1", "u1");
		await insertConnection("c2", "u2");
		await insertConnection("c3", "u3", { org: "org-b" });
		const ids = (await store.listGithubConnectionRecords("org-a"))
			.map((c) => c.connectionId)
			.sort();
		expect(ids).toEqual(["c1", "c2"]);
	});

	it("setGithubConnectionShared flips the flag inside the organization only", async () => {
		await insertConnection("c1", "u1");
		expect(
			await store.setGithubConnectionShared("c1", "org-b", true),
		).toBeNull();
		expect(
			(await store.findGithubConnectionInOrganization("c1", "org-a"))
				?.sharedWithOrganization,
		).toBe(false);
		const shared = await store.setGithubConnectionShared("c1", "org-a", true);
		expect(shared?.sharedWithOrganization).toBe(true);
		expect(shared).not.toHaveProperty("accessToken");
	});
});

describe.skipIf(!ready)("findRecentOtherGithubDeployer", () => {
	const find = (service = "app-1") =>
		store.findRecentOtherGithubDeployer("application", service, NOW);

	it("finds a GitHub Actions deployment of the last 24 hours", async () => {
		await insertDeployment(
			"d1",
			"GHA production 0123abcd [run 9.1]",
			NOW - 2 * HOUR,
			{
				origin: "github-actions",
			},
		);
		expect((await find())?.title).toBe("GHA production 0123abcd [run 9.1]");
	});

	it("finds a live row registered while GitHub builds (external build only)", async () => {
		await insertDeployment(
			"d1",
			"GHA production 0123abcd [run 9.1]",
			NOW - HOUR,
			{
				externalBuildOnly: true,
			},
		);
		expect(await find()).not.toBeNull();
	});

	it("ignores older rows, other services and builds that did not come from the action", async () => {
		await insertDeployment("d1", "GHA production old", NOW - 25 * HOUR, {
			origin: "github-actions",
		});
		await insertDeployment("d2", "GHA production other service", NOW - HOUR, {
			origin: "github-actions",
			app: "app-2",
		});
		await insertDeployment("d3", "Manual deploy", NOW - HOUR, {
			origin: "dokploy",
		});
		await insertDeployment("d4", "No origin", NOW - HOUR);
		expect(await find()).toBeNull();
	});

	it("ignores the deployments the GitHub Deployments poller itself started", async () => {
		await insertDeployment(
			"d1",
			"GHA production 0123abcd [deployment #120]",
			NOW - HOUR,
			{ origin: "github-actions" },
		);
		expect(await find()).toBeNull();
	});
});

const insertWatch = (
	id: string,
	connectionId: string,
	creator: string | null,
	service = `app-${id}`,
) =>
	client?.exec(
		`INSERT INTO "github_deployment_watch" ("watchId","organizationId","serviceType","serviceId","connectionId","createdByUserId","owner","repo") VALUES ('${id}','org-a','application','${service}','${connectionId}',${creator ? `'${creator}'` : "NULL"},'o','r')`,
	);

const creatorOf = async (watchId: string) =>
	(
		await client?.query(
			`SELECT "createdByUserId" AS c FROM github_deployment_watch WHERE "watchId" = '${watchId}'`,
		)
	)?.rows[0]?.c;

describe.skipIf(!ready)("migration 0236 (who saved a watch, T-13796)", () => {
	const rerun = async () => {
		for (const statement of migrationStatements("0236_gha_watch_creator.sql")) {
			await client?.exec(statement);
		}
	};

	it("gives a watch on a connection that is not shared the connection's owner, and leaves the rest unknown", async () => {
		await client?.exec(
			'ALTER TABLE "github_deployment_watch" DROP COLUMN "createdByUserId"',
		);
		await insertConnection("private", "owner-1");
		await insertConnection("shared", "owner-2", { shared: true });
		await insertConnection("ownerless", null);
		await client?.exec(
			`INSERT INTO "github_deployment_watch" ("watchId","organizationId","serviceType","serviceId","connectionId","owner","repo") VALUES
			('w-private','org-a','application','a1','private','o','r'),
			('w-shared','org-a','application','a2','shared','o','r'),
			('w-ownerless','org-a','application','a3','ownerless','o','r')`,
		);
		await rerun();
		expect(await creatorOf("w-private")).toBe("owner-1");
		expect(await creatorOf("w-shared")).toBeNull();
		expect(await creatorOf("w-ownerless")).toBeNull();
		// A replay is a no-op, and never overwrites a creator that was saved since.
		await client?.exec(
			`UPDATE "github_deployment_watch" SET "createdByUserId" = 'someone-else' WHERE "watchId" = 'w-private'`,
		);
		await rerun();
		expect(await creatorOf("w-private")).toBe("someone-else");
	});
});

describe.skipIf(!ready)("who a connection's token may serve", () => {
	const watchOf = async (watchId: string) => {
		const watch = await store.findGithubWatch("application", `app-${watchId}`);
		if (!watch) throw new Error(`no watch ${watchId}`);
		return watch;
	};

	it("serves the owner's own watch, and anyone's while the connection is shared", async () => {
		await insertConnection("c1", "owner-1");
		await insertWatch("w-own", "c1", "owner-1");
		await insertWatch("w-other", "c1", "member-2");
		expect(
			(await store.checkGithubWatchAccess(await watchOf("w-own"))).allowed,
		).toBe(true);
		expect(
			(await store.checkGithubWatchAccess(await watchOf("w-other"))).allowed,
		).toBe(false);
		await store.setGithubConnectionShared("c1", "org-a", true);
		expect(
			(await store.checkGithubWatchAccess(await watchOf("w-other"))).allowed,
		).toBe(true);
		// Taking the share back stops it again, and sharing again resumes it: no row is changed.
		await store.setGithubConnectionShared("c1", "org-a", false);
		expect(
			(await store.checkGithubWatchAccess(await watchOf("w-other"))).allowed,
		).toBe(false);
	});

	it("serves a watch an organization owner or admin saved, but not one whose saver left or is only a member", async () => {
		await insertConnection("c1", "owner-1");
		await client?.exec(
			`INSERT INTO "member" ("id","organization_id","user_id","role") VALUES ('m1','org-a','admin-1','admin'),('m2','org-a','member-2','member'),('m3','org-b','admin-3','admin')`,
		);
		await insertWatch("w-admin", "c1", "admin-1");
		await insertWatch("w-member", "c1", "member-2");
		await insertWatch("w-gone", "c1", "left-4");
		await insertWatch("w-otherorg", "c1", "admin-3");
		const allowed = async (id: string) =>
			(await store.checkGithubWatchAccess(await watchOf(id))).allowed;
		expect(await allowed("w-admin")).toBe(true);
		expect(await allowed("w-member")).toBe(false);
		expect(await allowed("w-gone")).toBe(false);
		// An admin of another organization is not an admin here.
		expect(await allowed("w-otherorg")).toBe(false);
	});

	it("stops serving a watch whose admin saver is later demoted, and serves it again if promoted back", async () => {
		await insertConnection("c1", "owner-1");
		await client?.exec(
			`INSERT INTO "member" ("id","organization_id","user_id","role") VALUES ('m1','org-a','admin-1','admin')`,
		);
		await insertWatch("w-admin", "c1", "admin-1");
		const allowed = async () =>
			(await store.checkGithubWatchAccess(await watchOf("w-admin"))).allowed;
		expect(await allowed()).toBe(true);
		await client?.exec(
			`UPDATE "member" SET "role" = 'member' WHERE "id" = 'm1'`,
		);
		expect(await allowed()).toBe(false);
		await client?.exec(
			`UPDATE "member" SET "role" = 'owner' WHERE "id" = 'm1'`,
		);
		expect(await allowed()).toBe(true);
	});

	it("fails closed for a watch with no known saver on an unshared connection, with a message that names the fix", async () => {
		await insertConnection("c1", "owner-1");
		await insertWatch("w-null", "c1", null);
		const access = await store.checkGithubWatchAccess(await watchOf("w-null"));
		expect(access).toMatchObject({ allowed: false, reason: "creator-unknown" });
		expect(access.allowed === false && access.message).toMatch(
			/owner must save the watch again/,
		);
	});

	it("lets the poll fail on its own when the connection is gone (it cannot be, the cascade removes the watch)", async () => {
		expect(
			await store.checkGithubWatchAccess({
				organizationId: "org-a",
				connectionId: "nope",
				createdByUserId: "u1",
			}),
		).toEqual({ allowed: true });
	});

	it("also stops the registry login of a watch it does not serve", async () => {
		await client?.exec(
			`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","githubLogin","githubUserId","accessToken","scopes") VALUES ('c1','org-a','owner-1','login','gh-1','tok','repo_deployment,read:packages')`,
		);
		await insertWatch("w-other", "c1", "member-2", "app-x");
		expect(await store.loadGhcrCredentials("application", "app-x")).toBeNull();
		await store.setGithubConnectionShared("c1", "org-a", true);
		expect(
			await store.loadGhcrCredentials("application", "app-x"),
		).toMatchObject({
			username: "login",
		});
	});

	it("records the saver on save, keeps it when the poller turns the watch on, and lets the owner claim it", async () => {
		await insertConnection("c1", "owner-1", { shared: true });
		const save = (user: string | null | undefined) =>
			store.upsertGithubWatch({
				organizationId: "org-a",
				serviceType: "application",
				serviceId: "app-1",
				connectionId: "c1",
				owner: "o",
				repo: "r",
				environment: "production",
				enabled: true,
				createdByUserId: user,
			});
		expect((await save("member-2")).createdByUserId).toBe("member-2");
		// No saver given (the poller's own re-save): the recorded one stays.
		expect((await save(undefined)).createdByUserId).toBe("member-2");
		// The owner saving it claims it.
		expect((await save("owner-1")).createdByUserId).toBe("owner-1");
	});
});
