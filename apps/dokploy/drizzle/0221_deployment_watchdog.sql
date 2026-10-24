-- Stuck-deployment watchdog settings (web server settings, instance-wide): on by default,
-- idle limit 20 min, wall limit 90 min, and a JSON list of excluded services (empty by default).
-- Guarded so a re-run is a no-op.
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogIdleMinutes" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogMaxMinutes" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogExclusions" jsonb DEFAULT '[]'::jsonb NOT NULL;
