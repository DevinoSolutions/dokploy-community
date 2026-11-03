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
 * Connections made before GitHub Actions became a provider (T-13879) are given its source type at start: the real
 * update statements run on a real Postgres. Only services with a connection row and an old source type change, and a
 * second run changes nothing.
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
const { adoptConnectedServices } = await import(
	"@dokploy/server/services/gha-connect/adopt"
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
	await pg.exec(
		`CREATE TYPE "public"."sourceType" AS ENUM ('docker','git','github','gitlab','bitbucket','gitea','drop','github-actions');
		 CREATE TYPE "public"."sourceTypeCompose" AS ENUM ('git','github','gitlab','bitbucket','gitea','raw','github-actions');
		 CREATE TABLE "organization" ("id" text PRIMARY KEY);
		 CREATE TABLE "application" ("applicationId" text PRIMARY KEY, "sourceType" "sourceType" NOT NULL DEFAULT 'github');
		 CREATE TABLE "compose" ("composeId" text PRIMARY KEY, "sourceType" "sourceTypeCompose" NOT NULL DEFAULT 'github');`,
	);
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
		`TRUNCATE "gha_release", "gha_connection", "github_deployment_watch", "github_deployment_connection", "organization", "application", "compose" CASCADE`,
	);
	await client.exec(
		`INSERT INTO "organization" ("id") VALUES ('org-a');
		 INSERT INTO "github_deployment_connection" ("connectionId","organizationId","createdByUserId","githubLogin","githubUserId","accessToken") VALUES ('gh-1','org-a','u1','amin','1','not-a-real-token');
		 INSERT INTO "application" ("applicationId","sourceType") VALUES ('waiting-git','github'), ('flipped-image','docker'), ('plain-git','github'), ('plain-image','docker'), ('dropped','drop'), ('already','github-actions');
		 INSERT INTO "compose" ("composeId","sourceType") VALUES ('stack-raw','raw'), ('plain-raw','raw'), ('stack-git','github');`,
	);
	const connect = (serviceType: string, serviceId: string, key: string) =>
		client?.exec(
			`INSERT INTO "gha_connection" ("ghaConnectionId","organizationId","serviceType","serviceId","githubConnectionId","repoId","repoFullName","trackedBranch","environment","serviceKey") VALUES ('gc-${key}','org-a','${serviceType}','${serviceId}','gh-1',1,'acme/shop','dev','development','${key}')`,
		);
	await connect("application", "waiting-git", "a");
	await connect("application", "flipped-image", "b");
	await connect("application", "dropped", "c");
	await connect("application", "already", "d");
	await connect("compose", "stack-raw", "e");
	await connect("compose", "stack-git", "f");
});

const types = async (table: string, key: string) =>
	Object.fromEntries(
		(
			await client?.query(
				`SELECT "${key}" AS id, "sourceType"::text AS t FROM "${table}"`,
			)
		)?.rows.map((row) => [row.id, row.t]) ?? [],
	);

describe.skipIf(!ready)("adoptConnectedServices", () => {
	it("moves connected services on an old source type, and only them", async () => {
		const result = await adoptConnectedServices();
		expect(result).toEqual({ applications: 2, composes: 1 });
		expect(await types("application", "applicationId")).toEqual({
			"waiting-git": "github-actions",
			"flipped-image": "github-actions",
			"plain-git": "github",
			"plain-image": "docker",
			dropped: "drop",
			already: "github-actions",
		});
		expect(await types("compose", "composeId")).toEqual({
			"stack-raw": "github-actions",
			"plain-raw": "raw",
			"stack-git": "github",
		});
	});

	it("changes nothing the second time", async () => {
		await adoptConnectedServices();
		expect(await adoptConnectedServices()).toEqual({
			applications: 0,
			composes: 0,
		});
	});
});
