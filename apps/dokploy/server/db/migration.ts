import { dbUrl } from "@dokploy/server/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { captureError } from "../sentry";

const sql = postgres(dbUrl, { max: 1 });
const db = drizzle(sql);

export const migration = async () => {
	try {
		await migrate(db, { migrationsFolder: "drizzle" });
		console.log("Migration complete");
	} catch (error) {
		// A swallowed migration failure is how an install ends up "half-migrated":
		// the pending batch rolls back, later fork tables/columns never land, and
		// the only visible symptom is downstream "column X does not exist" errors.
		// Boot anyway (never brick a running install), but make the root cause
		// LOUD in logs and report it to Sentry so broken switchers are diagnosable.
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			"\n============================================================\n" +
				"DATABASE MIGRATION FAILED — the app is starting WITHOUT the\n" +
				"pending migrations applied. Schema-dependent features WILL break\n" +
				"until this is resolved. Failing migration error:\n" +
				`  ${message}\n` +
				"============================================================\n",
		);
		console.error(error);
		captureError(error, { subsystem: "db-migration" });
	} finally {
		await sql.end();
	}
};
