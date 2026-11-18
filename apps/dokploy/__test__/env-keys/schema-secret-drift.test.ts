import * as schema from "@dokploy/server/db/schema";
import {
	isSecretKey,
	NESTED_SECRET_FIELDS,
	SECRET_ROW_FIELDS,
} from "@dokploy/server/services/service-secrets";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
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
 * Which list applies to a table:
 * - the service tables (`application`, `compose`, the databases) are read as a
 *   row: `SECRET_ROW_FIELDS`;
 * - the tables a service read nests (registries, git providers, destinations,
 *   SSH keys, basic-auth entries): `NESTED_SECRET_FIELDS`;
 * - every other table can only reach a client inside some tool result:
 *   `MCP_SECRET_KEYS` (via `isSecretKey`).
 */

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
const SECRET_WORD =
	/password|passwd|secret|token|credential|passphrase|privatekey|signingkey|encryptionkey|webhook|hmac|digest|salt|accesskey|apikey|secretkey/i;
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
