-- Where the image a deployment shipped was built (T-12149): 'dokploy' | 'github-actions' | 'external',
-- and the GitHub Actions run link when the caller sent a valid one. Kept on the deployment row, not on
-- application/compose (the application table sits at the Postgres 100-argument cap for Drizzle eager loads).
-- Nullable, no default: rows written before this have no value and readers infer it. Guarded so a re-run is a no-op.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildOrigin" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildRunUrl" text;
