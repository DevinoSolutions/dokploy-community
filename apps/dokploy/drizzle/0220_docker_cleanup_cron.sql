-- Nightly Docker cleanup schedule: 5-field cron read in UTC (default 04:00 UTC).
-- NOT NULL with a default, so every existing row moves off the old 23:50 container-local slot.
-- Guarded so a re-run is a no-op.
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "dockerCleanupCron" text DEFAULT '0 4 * * *' NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "dockerCleanupCron" text DEFAULT '0 4 * * *' NOT NULL;
