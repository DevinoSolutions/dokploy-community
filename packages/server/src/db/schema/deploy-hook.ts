import { pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { applications } from "./application";

/**
 * Pre/post-deploy command hooks, stored 1:1 with an application.
 *
 * These live in their own table (rather than as an `application` column) on
 * purpose: the fork's `application` table already sits at Postgres's hard
 * 100-argument limit for `json_build_array`, which Drizzle's nested relational
 * queries use to load a project with its applications. Adding another
 * `application` column would push that call to 101 args and break the project
 * query. Keeping hooks in a side table avoids that entirely.
 *
 * `hooks` is the same JSON payload the execution engine already understands:
 * `{ "pre": string | null, "post": string | null }` (see parseDeployHooks).
 */
export const deployHook = pgTable("deploy_hook", {
	deployHookId: text("deployHookId")
		.primaryKey()
		.$defaultFn(() => nanoid()),
	applicationId: text("applicationId")
		.notNull()
		.unique()
		.references(() => applications.applicationId, { onDelete: "cascade" }),
	hooks: text("hooks"),
});
