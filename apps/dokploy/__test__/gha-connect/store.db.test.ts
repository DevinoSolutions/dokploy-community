import { eq as drizzleEq, getTableColumns } from "drizzle-orm";
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
 * Migrations 0229 and 0230 and the gha-connect store against a real Postgres (PGlite): the real 0228, 0229 and 0230
 * files create the tables with their constraints (0229 is applied twice, as an update that replays
 * it would), then the cascades, the unique keys and the store's real SQL run.
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

const ALL_FILES = [
	"0228_github_deployment_watch.sql",
	"0229_gha_connection.sql",
	"0230_gha_deploy_gate.sql",
	"0231_gha_release_source.sql",
	// A second run of each: every statement is guarded, a replay is a no-op.
	"0228_github_deployment_watch.sql",
	"0229_gha_connection.sql",
	"0230_gha_deploy_gate.sql",
	"0231_gha_release_source.sql",
];

beforeAll(async () => {
	if (!PGliteClass) return;
	const pg = new PGliteClass() as unknown as Client;
	client = pg;
	holder.db = drizzle(pg as never, { schema });
	await pg.exec('CREATE TABLE "organization" ("id" text PRIMARY KEY)');
	// Only the key of each service table: the store asks whether a service exists.
	await pg.exec(
		'CREATE TABLE "application" ("applicationId" text PRIMARY KEY)',
	);
	await pg.exec('CREATE TABLE "compose" ("composeId" text PRIMARY KEY)');
	for (const file of ALL_FILES) {
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
	await client.exec(
		`INSERT INTO "organization" ("id") VALUES ('org-a'), ('org-b')`,
	);
	await client.exec(
		`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","githubLogin","githubUserId","accessToken") VALUES ('gh-1','org-a','u1','amin','1','not-a-real-token')`,
	);
});

const baseRow = (overrides: Record<string, unknown> = {}) => ({
	organizationId: "org-a",
	serviceType: "compose" as const,
	serviceId: "compose-1",
	githubConnectionId: "gh-1",
	repoId: 123,
	repoFullName: "DevinoSolutions/voicelabs",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "voicekit-web",
	...overrides,
});

const count = async (table: string) =>
	Number(
		(await client?.query(`SELECT count(*)::int AS n FROM "${table}"`))?.rows[0]
			?.n,
	);

describe.skipIf(!ready)("migration 0229 applied on top of 0228, twice", () => {
	it("created both tables and the one index", async () => {
		const tables = (
			await client?.query(
				`SELECT table_name FROM information_schema.tables WHERE table_name IN ('gha_connection','gha_release') ORDER BY 1`,
			)
		)?.rows.map((row) => row.table_name);
		expect(tables).toEqual(["gha_connection", "gha_release"]);
		const index = (
			await client?.query(
				`SELECT indexname FROM pg_indexes WHERE tablename = 'gha_release' AND indexname = 'gha_release_connection_created_idx'`,
			)
		)?.rows;
		expect(index).toHaveLength(1);
	});

	it("has every constraint exactly once, none cut at the 63 byte limit", async () => {
		const rows = (
			await client?.query(
				`SELECT conname FROM pg_constraint WHERE conrelid IN ('gha_connection'::regclass, 'gha_release'::regclass) AND contype IN ('u','f') ORDER BY 1`,
			)
		)?.rows;
		const names = (rows ?? []).map((row) => String(row.conname));
		expect(names).toEqual([
			"gha_connection_github_connection_fk",
			"gha_connection_organizationId_organization_id_fk",
			"gha_connection_repo_key_unique",
			"gha_connection_service_unique",
			"gha_release_ghaConnectionId_gha_connection_ghaConnectionId_fk",
			"gha_release_run_unique",
		]);
		for (const name of names) {
			expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
		}
	});

	it("every column of the drizzle schema exists in the migrated table", async () => {
		for (const [table, definition] of [
			["gha_connection", schema.ghaConnection],
			["gha_release", schema.ghaRelease],
		] as const) {
			const expected = Object.values(getTableColumns(definition)).map(
				(column) => column.name,
			);
			const actual = (
				await client?.query(
					`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`,
				)
			)?.rows.map((row) => String(row.column_name));
			expect(actual?.sort(), table).toEqual([...expected].sort());
		}
	});
});

describe.skipIf(!ready)("the constraints", () => {
	it("allow one connection per service and one per repository, environment and key", async () => {
		await store.createGhaConnection(baseRow());
		await expect(store.createGhaConnection(baseRow())).rejects.toMatchObject({
			cause: { code: "23505" },
		});
		// Same service key on another service of the same repository and environment.
		await expect(
			store.createGhaConnection(baseRow({ serviceId: "compose-2" })),
		).rejects.toMatchObject({ cause: { code: "23505" } });
		// Another key, another environment: fine.
		await store.createGhaConnection(
			baseRow({ serviceId: "compose-2", serviceKey: "voicekit-api" }),
		);
		await store.createGhaConnection(
			baseRow({
				serviceId: "compose-3",
				environment: "production",
				trackedBranch: "main",
			}),
		);
		expect(await count("gha_connection")).toBe(3);
	});

	it("refuses to delete a GitHub account that a connection uses, and counts them", async () => {
		const row = await store.createGhaConnection(baseRow());
		expect(await store.countGhaConnectionsForGithubConnection("gh-1")).toBe(1);
		expect(await store.countGhaConnectionsForGithubConnection("gh-none")).toBe(
			0,
		);
		await expect(
			client?.exec(
				`DELETE FROM "github_deployment_connection" WHERE "connectionId" = 'gh-1'`,
			),
		).rejects.toMatchObject({ code: "23503" });
		expect(await count("github_deployment_connection")).toBe(1);
		expect(await count("gha_connection")).toBe(1);
		// Once the service is disconnected the account can go.
		await store.deleteGhaConnection("compose", "compose-1");
		expect(row.ghaConnectionId).toBeTruthy();
		await client?.exec(
			`DELETE FROM "github_deployment_connection" WHERE "connectionId" = 'gh-1'`,
		);
		expect(await count("github_deployment_connection")).toBe(0);
	});

	it("deleting the organization still removes its connections, releases and GitHub accounts together", async () => {
		await client?.exec(
			`INSERT INTO "github_deployment_connection" ("connectionId","organizationId","githubLogin","githubUserId","accessToken") VALUES ('gh-2','org-b','x','2','t')`,
		);
		const row = await store.createGhaConnection(
			baseRow({ organizationId: "org-b", githubConnectionId: "gh-2" }),
		);
		await store.recordRelease({
			ghaConnectionId: row.ghaConnectionId,
			manifestReleaseId: "gh-1.1",
			sha: "a".repeat(40),
			runId: 1,
			runAttempt: 1,
			delivery: "pull",
			status: "accepted",
			githubDeploymentId: 10,
			images: [],
			digests: [],
		});
		expect(await count("gha_release")).toBe(1);
		await client?.exec(`DELETE FROM "organization" WHERE "id" = 'org-b'`);
		expect(await count("gha_connection")).toBe(0);
		expect(await count("gha_release")).toBe(0);
		expect(await count("github_deployment_connection")).toBe(1);
	});

	it("deleting a connection removes its releases", async () => {
		const row = await store.createGhaConnection(baseRow());
		await store.recordRelease({
			ghaConnectionId: row.ghaConnectionId,
			manifestReleaseId: "gh-1.1",
			sha: "a".repeat(40),
			runId: 1,
			runAttempt: 1,
			delivery: "pull",
			status: "accepted",
			githubDeploymentId: 10,
			images: [],
			digests: [],
		});
		await store.deleteGhaConnection("compose", "compose-1");
		expect(await count("gha_release")).toBe(0);
	});

	it("refuses a connection that names a GitHub account which does not exist", async () => {
		await expect(
			store.createGhaConnection(baseRow({ githubConnectionId: "nope" })),
		).rejects.toMatchObject({ cause: { code: "23503" } });
	});
});

describe.skipIf(!ready)("the store", () => {
	it("starts a connection waiting, with an empty handled-run list and the defaults of the design", async () => {
		const row = await store.createGhaConnection(baseRow());
		expect(row).toMatchObject({
			state: "waiting",
			protectionMode: "environment",
			gateMode: "image",
			workflowPath: ".github/workflows/dokploy.yml",
			processed: [],
			previousSource: null,
		});
	});

	it("applies an event under a row lock and moves stateSince only when the state changes", async () => {
		const row = await store.createGhaConnection(baseRow());
		const before = await store.findGhaConnectionById(row.ghaConnectionId);
		await new Promise((resolve) => setTimeout(resolve, 15));
		await store.applyConnectionEvent(row.ghaConnectionId, {
			type: "release-refused",
			message: "wrong registry",
			block: true,
		});
		const blocked = await store.findGhaConnectionById(row.ghaConnectionId);
		expect(blocked?.state).toBe("blocked");
		expect(blocked?.stateSince.getTime()).toBeGreaterThan(
			before?.stateSince.getTime() ?? 0,
		);
		await new Promise((resolve) => setTimeout(resolve, 15));
		await store.applyConnectionEvent(
			row.ghaConnectionId,
			{ type: "release-refused", message: "still wrong", block: true },
			"still wrong",
		);
		const again = await store.findGhaConnectionById(row.ghaConnectionId);
		expect(again?.state).toBe("blocked");
		expect(again?.stateSince.getTime()).toBe(blocked?.stateSince.getTime());
		expect(again?.lastError).toBe("still wrong");
	});

	it("keeps one history row per run and attempt, and a settled release becomes the deployed one", async () => {
		const row = await store.createGhaConnection(baseRow());
		const input = {
			ghaConnectionId: row.ghaConnectionId,
			manifestReleaseId: "gh-1.1",
			sha: "b".repeat(40),
			runId: 55,
			runAttempt: 1,
			delivery: "pull" as const,
			status: "accepted" as const,
			githubDeploymentId: 77,
			images: [
				{
					name: "web",
					composeService: "web",
					ref: "x@sha256:" + "c".repeat(64),
				},
			],
			digests: ["sha256:" + "c".repeat(64)],
		};
		await store.recordRelease(input);
		await store.recordRelease(input);
		expect(await count("gha_release")).toBe(1);
		await store.settleRelease(row.ghaConnectionId, 77, "deployed");
		await store.settleRelease(row.ghaConnectionId, 77, "deployed");
		const after = await store.findGhaConnectionById(row.ghaConnectionId);
		expect(after).toMatchObject({
			deployedSha: "b".repeat(40),
			deployedRunId: 55,
			deployedRunAttempt: 1,
		});
		const [release] = await store.listReleases(row.ghaConnectionId);
		expect(release?.status).toBe("deployed");
		expect(release?.settledAt).not.toBeNull();
	});
});

const insertWatch = (serviceType: string, serviceId: string) =>
	client?.exec(
		`INSERT INTO "github_deployment_watch" ("watchId","organizationId","serviceType","serviceId","connectionId","owner","repo","enabled") VALUES ('w-${serviceId}','org-a','${serviceType}','${serviceId}','gh-1','o','r',false)`,
	);

describe.skipIf(!ready)("services that are deleted", () => {
	it("removeGhaConnectionsForServices removes the connection and its watch, in the transaction that deletes the service", async () => {
		await client?.exec(
			`INSERT INTO "compose" ("composeId") VALUES ('compose-1'), ('compose-2')`,
		);
		await store.createGhaConnection(baseRow());
		await store.createGhaConnection(
			baseRow({ serviceId: "compose-2", serviceKey: "other" }),
		);
		await insertWatch("compose", "compose-1");
		await insertWatch("compose", "compose-2");
		const db = holder.db as {
			transaction: (
				fn: (tx: {
					delete: (table: unknown) => {
						where: (clause: unknown) => Promise<unknown>;
					};
				}) => Promise<void>,
			) => Promise<void>;
		};
		await db.transaction(async (tx) => {
			await tx
				.delete(schema.compose)
				.where(drizzleEq(schema.compose.composeId, "compose-1"));
			await store.removeGhaConnectionsForServices(
				[{ serviceType: "compose", serviceId: "compose-1" }],
				tx as never,
			);
		});
		expect(await count("compose")).toBe(1);
		expect(await count("gha_connection")).toBe(1);
		expect(await count("github_deployment_watch")).toBe(1);
		const left = await store.findGhaConnection("compose", "compose-2");
		expect(left?.serviceId).toBe("compose-2");
	});

	it("leaves a plain GitHub Deployments watch to the poller's service-gone path, and removes only connection-owned ones", async () => {
		await client?.exec(
			`INSERT INTO "compose" ("composeId") VALUES ('compose-1'), ('compose-plain')`,
		);
		await store.createGhaConnection(baseRow());
		await insertWatch("compose", "compose-1");
		await insertWatch("compose", "compose-plain");
		await store.removeGhaConnectionsForServices([
			{ serviceType: "compose", serviceId: "compose-1" },
			{ serviceType: "compose", serviceId: "compose-plain" },
		]);
		const left = (
			await client?.query(
				`SELECT "serviceId" FROM github_deployment_watch ORDER BY 1`,
			)
		)?.rows.map((row) => row.serviceId);
		expect(left).toEqual(["compose-plain"]);
		expect(await count("gha_connection")).toBe(0);
	});

	it("a failure rolls the connection removal back with the service delete", async () => {
		await client?.exec(
			`INSERT INTO "compose" ("composeId") VALUES ('compose-1')`,
		);
		await store.createGhaConnection(baseRow());
		await insertWatch("compose", "compose-1");
		const db = holder.db as {
			transaction: (fn: (tx: never) => Promise<void>) => Promise<void>;
		};
		await expect(
			db.transaction(async (tx) => {
				await store.removeGhaConnectionsForServices(
					[{ serviceType: "compose", serviceId: "compose-1" }],
					tx as never,
				);
				throw new Error("the service delete failed");
			}),
		).rejects.toThrow("the service delete failed");
		expect(await count("gha_connection")).toBe(1);
		expect(await count("github_deployment_watch")).toBe(1);
	});

	it("serviceRowExists tells applications and compose stacks apart", async () => {
		await client?.exec(
			`INSERT INTO "application" ("applicationId") VALUES ('app-1')`,
		);
		expect(await store.serviceRowExists("application", "app-1")).toBe(true);
		expect(await store.serviceRowExists("compose", "app-1")).toBe(false);
		expect(await store.serviceRowExists("application", "nope")).toBe(false);
	});

	it("pruneOrphanedGhaConnections drops only the connections whose service is gone, so the account can be removed", async () => {
		await client?.exec(
			`INSERT INTO "compose" ("composeId") VALUES ('compose-live')`,
		);
		await store.createGhaConnection(baseRow({ serviceId: "compose-gone" }));
		await store.createGhaConnection(
			baseRow({ serviceId: "compose-live", serviceKey: "live" }),
		);
		await insertWatch("compose", "compose-gone");
		await insertWatch("compose", "compose-live");
		expect(await store.pruneOrphanedGhaConnections("gh-1")).toBe(1);
		expect(await store.countGhaConnectionsForGithubConnection("gh-1")).toBe(1);
		expect(await store.findGhaConnection("compose", "compose-gone")).toBeNull();
		expect(await count("github_deployment_watch")).toBe(1);
		// A live service still blocks the account.
		await expect(
			client?.exec(
				`DELETE FROM "github_deployment_connection" WHERE "connectionId" = 'gh-1'`,
			),
		).rejects.toMatchObject({ code: "23503" });
		await store.deleteGhaConnection("compose", "compose-live");
		expect(await store.pruneOrphanedGhaConnections("gh-1")).toBe(0);
	});
});

describe.skipIf(!ready)(
	"migration 0231: where the manifest was read from",
	() => {
		const release = (overrides: Record<string, unknown> = {}) => ({
			manifestReleaseId: "gh-1.1",
			sha: "b".repeat(40),
			runId: 55,
			runAttempt: 1,
			delivery: "pull" as const,
			status: "accepted" as const,
			githubDeploymentId: 77,
			images: [
				{
					name: "web",
					composeService: "web",
					ref: `x@sha256:${"c".repeat(64)}`,
				},
			],
			digests: [`sha256:${"c".repeat(64)}`],
			...overrides,
		});

		it("defaults to the artifact and stores the job log when told", async () => {
			const row = await store.createGhaConnection(baseRow());
			await store.recordRelease({
				...release(),
				ghaConnectionId: row.ghaConnectionId,
			});
			await store.recordRelease({
				...release({ runId: 56, manifestSource: "job-log" }),
				ghaConnectionId: row.ghaConnectionId,
			});
			const rows = await client?.query(
				'SELECT "runId", "manifestSource" FROM "gha_release" ORDER BY "runId"',
			);
			expect(rows?.rows).toEqual([
				{ runId: 55, manifestSource: "artifact" },
				{ runId: 56, manifestSource: "job-log" },
			]);
		});

		it("is NOT NULL with an artifact default, so rows from before the column read as artifact", async () => {
			const column = (
				await client?.query(
					`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'gha_release' AND column_name = 'manifestSource'`,
				)
			)?.rows[0];
			expect(column).toMatchObject({ is_nullable: "NO" });
			expect(String(column?.column_default)).toContain("'artifact'");
		});
	},
);
