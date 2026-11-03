-- Deploy gate of the native GitHub Actions connect (T-13720): per-service gate settings on gha_connection and the gate
-- state of each release on gha_release. Additive only; every statement is guarded so a re-run is a no-op. Numbered after
-- 0229 (T-13719): renumber if the order changes.
ALTER TABLE "gha_connection" ADD COLUMN IF NOT EXISTS "gateWorkflows" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "gha_connection" ADD COLUMN IF NOT EXISTS "gateTimeoutMinutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "gha_connection" ADD COLUMN IF NOT EXISTS "gateVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gha_connection" ADD COLUMN IF NOT EXISTS "gateBlocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "gateState" text;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "gateReason" text;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "gateCheckedAt" timestamp;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "gateExpected" jsonb;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "gateOverride" jsonb;
