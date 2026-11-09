-- The default wall limit of the stuck-deployment watchdog is now 180 min (T-12495), so a new settings row
-- starts there. Only the column default changes: no stored value is touched, an instance that kept 90 keeps it.
-- SET DEFAULT can be run again with the same result.
-- An instance that moved from upstream Dokploy to this fork can reach this migration before it has the
-- column: 0221 is older than upstream's newest migration, so the drizzle migrator skips it, and 0235
-- (the fork catch-up) only runs after this one. Without the column, SET DEFAULT below fails and rolls the
-- whole pending batch back. Adding it first (with 0221's original default) keeps the sequence 0221 -> 0226.
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogMaxMinutes" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ALTER COLUMN "deploymentWatchdogMaxMinutes" SET DEFAULT 180;