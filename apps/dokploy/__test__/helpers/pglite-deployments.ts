import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getTableConfig, isPgEnum, type PgTable } from "drizzle-orm/pg-core";

/**
 * A real Postgres (PGlite, in process) with the fork's real drizzle tables, for tests that must run the real SQL of
 * the live GitHub Actions rows: the guarded UPDATEs, the unique index and the filters. The tables are generated from the
 * drizzle schema (no foreign keys, no NOT NULL), then the real 0227 migration is applied on top, so its statements and
 * its index are the ones that ship. PGlite comes with drizzle-orm's optional peer; when it cannot be resolved the
 * helper reports `null` and the tests skip themselves.
 */

type PGliteLike = {
	exec: (sql: string) => Promise<unknown>;
	close: () => Promise<void>;
};

const loadPglite = (): (new () => PGliteLike) | null => {
	try {
		const require = createRequire(import.meta.url);
		// The package entry (its package.json is not exported): the optional peer sits next to drizzle-orm in the store.
		const drizzleRoot = require.resolve("drizzle-orm");
		const fromDrizzle = createRequire(drizzleRoot);
		return fromDrizzle("@electric-sql/pglite").PGlite;
	} catch {
		return null;
	}
};

export const PGliteClass = loadPglite();

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

const literal = (value: unknown): string | null => {
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return null;
};

export const createTableSql = (table: PgTable, enumNames: Set<string>) => {
	const config = getTableConfig(table);
	const columns = config.columns.map((column) => {
		const rawType = column.getSQLType();
		const type = enumNames.has(rawType) ? q(rawType) : rawType;
		const fallback = column.hasDefault ? literal(column.default) : null;
		return `${q(column.name)} ${type}${fallback ? ` DEFAULT ${fallback}` : ""}${
			column.primary ? " PRIMARY KEY" : ""
		}`;
	});
	return `CREATE TABLE IF NOT EXISTS ${q(config.name)} (${columns.join(", ")});`;
};

export const enumSql = (schema: Record<string, unknown>) => {
	const statements: string[] = [];
	const names = new Set<string>();
	for (const value of Object.values(schema)) {
		if (!isPgEnum(value as never)) continue;
		const e = value as { enumName: string; enumValues: string[] };
		if (names.has(e.enumName)) continue;
		names.add(e.enumName);
		statements.push(
			`CREATE TYPE ${q(e.enumName)} AS ENUM (${e.enumValues
				.map((v) => `'${v.replace(/'/g, "''")}'`)
				.join(", ")});`,
		);
	}
	return { statements, names };
};

/** The statements of a drizzle migration file, split on its breakpoints. */
export const migrationStatements = (file: string) =>
	fs
		.readFileSync(path.resolve(__dirname, "../../drizzle", file), "utf8")
		.split("--> statement-breakpoint")
		.map((part) => part.trim())
		.filter(Boolean);
