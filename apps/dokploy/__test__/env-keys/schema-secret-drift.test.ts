import * as schema from "@dokploy/server/db/schema";
import {
	isSecretKey,
	NESTED_SECRET_FIELDS,
	redactRegistryAwsKeys,
	SECRET_ROW_FIELDS,
} from "@dokploy/server/services/service-secrets";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
	REVIEWED_NOT_SECRET,
	SECRET_OWN_SURFACE,
} from "./schema-secret-drift.reviewed";

/**
 * Drift guard for the redaction lists in `services/service-secrets.ts`.
 *
 * Those lists name columns by hand, so a credential column added to the schema
 * (an upstream sync adds them) is returned by the service reads until someone
 * names it. `awsSecretAccessKey` shipped that way. This test walks every
 * column of every table and fails on one whose name looks like a secret and is
 * neither named by the redaction that applies to its table, nor listed in
 * schema-secret-drift.reviewed.ts with the reason it needs no redaction.
 *
 * A name on a list is not proof that a route applies it, so the last block of
 * this file loads the real application and compose finders and checks, column
 * by column, that nothing on `NESTED_SECRET_FIELDS` leaves the finder (a git
 * provider) or is blanked by `redactRegistryAwsKeys` (a registry).
 *
 * Which list applies to a table:
 * - the service tables (`application`, `compose`, the databases) are read as a
 *   row: `SECRET_ROW_FIELDS`;
 * - the tables a service read nests (registries, git providers, destinations,
 *   SSH keys, basic-auth entries): `NESTED_SECRET_FIELDS`;
 * - every other table can only reach a client inside some tool result:
 *   `MCP_SECRET_KEYS` (via `isSecretKey`).
 */

type FindArgs = {
	with?: Record<string, true | { columns?: Record<string, boolean> }>;
};

// A db whose rows are built from the query: each relation the finder asks for
// comes back with exactly the columns drizzle would select, every value a
// SECRET- marker, so the test sees what the real finder loads.
const finderState = vi.hoisted(() => ({
	columnsOf: {} as Record<string, string[]>,
	tableOf: {} as Record<string, string>,
}));

vi.mock("@dokploy/server/db", () => {
	const build = (args: FindArgs) => {
		const row: Record<string, unknown> = {};
		for (const [relation, config] of Object.entries(args.with ?? {})) {
			const table = finderState.tableOf[relation];
			if (!table) continue;
			const all = finderState.columnsOf[table] ?? [];
			const columns = config === true ? undefined : config.columns;
			const wanted = columns
				? Object.entries(columns).filter(([, on]) => on)
				: [];
			const loaded =
				wanted.length > 0
					? wanted.map(([name]) => name)
					: all.filter((name) => !columns || columns[name] !== false);
			row[relation] = Object.fromEntries(
				loaded.map((name) => [name, `SECRET-${relation}.${name}`]),
			);
		}
		return row;
	};
	return {
		db: {
			query: {
				applications: { findFirst: async (args: FindArgs) => build(args) },
				compose: { findFirst: async (args: FindArgs) => build(args) },
			},
		},
	};
});

const ROW_TABLES = new Set([
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

const NESTED_TABLES = new Set([
	"registry",
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
	"destination",
	"ssh-key",
	"security",
]);

// A name that contains one of these words, or is `key` / ends in `Key`
// (`licenseKey`, `heartbeatKey`, `userKey`, `accessKey`, ...). Wider on purpose:
// a false positive costs one line in the reviewed list, a miss costs a leak.
// The names after `secretkey` are columns that hold secrets without a secret
// word in their name: cookies and JWTs, 2FA backup codes, raw rclone flags, SSO
// and telemetry config blobs. Only column names are matched: what a JSON column
// holds is not inspected, so a secret nested in a config blob is reviewed by hand.
const SECRET_WORD =
	/password|passwd|secret|token|credential|passphrase|privatekey|signingkey|encryptionkey|webhook|hmac|digest|salt|accesskey|apikey|secretkey|dsn|cookie|jwt|bearer|authorization|backupcode|connectionstring|additionalflags|oidcconfig|samlconfig|extraconfig/i;
const KEY_SUFFIX = /(^key|Key)$/;

const looksSecret = (column: string) =>
	SECRET_WORD.test(column) || KEY_SUFFIX.test(column);

const tables = new Map<string, PgTable>();
for (const value of Object.values(schema)) {
	if (is(value, PgTable)) tables.set(getTableName(value), value);
}

const secretLooking: { id: string; table: string; column: string }[] = [];
for (const [table, value] of tables) {
	for (const column of Object.keys(getTableColumns(value))) {
		if (looksSecret(column)) {
			secretLooking.push({ id: `${table}.${column}`, table, column });
		}
	}
}

const isRedacted = ({ table, column }: { table: string; column: string }) => {
	if (ROW_TABLES.has(table)) {
		return (SECRET_ROW_FIELDS as readonly string[]).includes(column);
	}
	if (NESTED_TABLES.has(table)) {
		return (NESTED_SECRET_FIELDS as readonly string[]).includes(column);
	}
	return isSecretKey(column);
};

describe("secret-looking schema columns", () => {
	it("finds the tables and the columns it is meant to guard", () => {
		expect(tables.size).toBeGreaterThan(80);
		for (const id of [
			"registry.awsSecretAccessKey",
			"registry.awsAccessKeyId",
			"application.refreshToken",
			"destination.encryptionKey",
			"github.githubPrivateKey",
		]) {
			expect(secretLooking.map((entry) => entry.id)).toContain(id);
		}
	});

	it("are each redacted or reviewed", () => {
		const unclassified = secretLooking
			.filter(
				(entry) =>
					!isRedacted(entry) &&
					!(entry.id in REVIEWED_NOT_SECRET) &&
					!(entry.id in SECRET_OWN_SURFACE),
			)
			.map((entry) => entry.id);

		// A new column lands here. If it is a credential, name it in
		// service-secrets.ts (SECRET_ROW_FIELDS for a service table,
		// NESTED_SECRET_FIELDS for a table a service read nests, MCP_SECRET_KEYS
		// otherwise) and drop it from the finder's columns where the deploy path
		// does not need it. If it is not one, add it to REVIEWED_NOT_SECRET with
		// the reason.
		expect(unclassified).toEqual([]);
	});

	it("do not appear in a reviewed list once they are redacted", () => {
		const redundant = secretLooking
			.filter(
				(entry) =>
					isRedacted(entry) &&
					(entry.id in REVIEWED_NOT_SECRET || entry.id in SECRET_OWN_SURFACE),
			)
			.map((entry) => entry.id);

		expect(redundant).toEqual([]);
	});

	it("are in at most one reviewed list", () => {
		expect(
			Object.keys(REVIEWED_NOT_SECRET).filter((id) => id in SECRET_OWN_SURFACE),
		).toEqual([]);
	});

	it("are all still in the schema (no stale reviewed entry)", () => {
		const present = new Set(secretLooking.map((entry) => entry.id));
		expect(
			[
				...Object.keys(REVIEWED_NOT_SECRET),
				...Object.keys(SECRET_OWN_SURFACE),
			].filter((id) => !present.has(id)),
		).toEqual([]);
	});

	it("give every reviewed entry a reason", () => {
		for (const reasons of [REVIEWED_NOT_SECRET, SECRET_OWN_SURFACE]) {
			for (const [id, reason] of Object.entries(reasons)) {
				expect(reason.trim().length, id).toBeGreaterThan(5);
			}
		}
	});
});

describe("the redaction lists", () => {
	const columnsOf = (names: Set<string>) =>
		new Set(
			[...names].flatMap((table) =>
				Object.keys(getTableColumns(tables.get(table) as PgTable)),
			),
		);

	it("name only columns the service tables have", () => {
		const columns = columnsOf(ROW_TABLES);
		expect(SECRET_ROW_FIELDS.filter((field) => !columns.has(field))).toEqual(
			[],
		);
	});

	it("name only columns the nested tables have", () => {
		const columns = columnsOf(NESTED_TABLES);
		expect(NESTED_SECRET_FIELDS.filter((field) => !columns.has(field))).toEqual(
			[],
		);
	});

	it("find every table they classify", () => {
		for (const table of [...ROW_TABLES, ...NESTED_TABLES]) {
			expect(tables.has(table), table).toBe(true);
		}
	});
});

// The first load imports the whole service layer.
describe("the real finders against NESTED_SECRET_FIELDS", {
	timeout: 60_000,
}, () => {
	// relation name on the service row -> table name
	const RELATION_TABLE = {
		registry: "registry",
		buildRegistry: "registry",
		rollbackRegistry: "registry",
		github: "github",
		gitlab: "gitlab",
		bitbucket: "bitbucket",
		gitea: "gitea",
	} as const;

	type Row = Record<string, Record<string, unknown> | undefined>;

	const nestedColumns = (table: string) =>
		Object.keys(getTableColumns(tables.get(table) as PgTable)).filter(
			(column) => (NESTED_SECRET_FIELDS as readonly string[]).includes(column),
		);

	const load = async (finder: "application" | "compose"): Promise<Row> => {
		for (const [relation, table] of Object.entries(RELATION_TABLE)) {
			finderState.tableOf[relation] = table;
			finderState.columnsOf[table] = Object.keys(
				getTableColumns(tables.get(table) as PgTable),
			);
		}
		if (finder === "application") {
			const { findApplicationById } = await import(
				"@dokploy/server/services/application"
			);
			return (await findApplicationById("id")) as unknown as Row;
		}
		const { findComposeById } = await import(
			"@dokploy/server/services/compose"
		);
		return (await findComposeById("id")) as unknown as Row;
	};

	it.each(["application", "compose"] as const)(
		"%s finder: no git provider column on the list is loaded",
		async (finder) => {
			const row = await load(finder);
			const leaked: string[] = [];
			for (const relation of [
				"github",
				"gitlab",
				"bitbucket",
				"gitea",
			] as const) {
				for (const column of nestedColumns(RELATION_TABLE[relation])) {
					if (column in (row[relation] ?? {})) {
						leaked.push(`${relation}.${column}`);
					}
				}
			}
			// A listed column that a finder loads reaches every reader of the
			// service: exclude it in the finder (`columns: { x: false }`).
			expect(leaked).toEqual([]);
		},
	);

	it("application finder: every listed registry column it loads is blanked on the dashboard path", async () => {
		const row = await load("application");
		const redacted = redactRegistryAwsKeys(row, { keepAccessKeyId: false });
		const unblanked: string[] = [];
		let checked = 0;
		for (const relation of [
			"registry",
			"buildRegistry",
			"rollbackRegistry",
		] as const) {
			const before = row[relation] ?? {};
			const after = redacted[relation] ?? {};
			for (const column of nestedColumns("registry")) {
				if (!(column in before)) continue;
				checked++;
				if (after[column] !== "") unblanked.push(`${relation}.${column}`);
			}
		}
		// awsSecretAccessKey is loaded for the deploy path, so this is not vacuous.
		expect(checked).toBeGreaterThan(0);
		expect(unblanked).toEqual([]);
	});

	it("keeps only the access key id for a caller who may edit the service", async () => {
		const row = await load("application");
		const redacted = redactRegistryAwsKeys(row, { keepAccessKeyId: true });
		const kept = new Set<string>();
		for (const relation of [
			"registry",
			"buildRegistry",
			"rollbackRegistry",
		] as const) {
			for (const column of nestedColumns("registry")) {
				if (
					column in (row[relation] ?? {}) &&
					redacted[relation]?.[column] !== ""
				) {
					kept.add(column);
				}
			}
		}
		expect([...kept]).toEqual(["awsAccessKeyId"]);
	});
});
