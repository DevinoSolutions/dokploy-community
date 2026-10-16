-- Opt-in Compose rolling replace (scale up, wait healthy, remove the old container).
-- Nullable jsonb, no default: NULL = off. Guarded so a re-run is a no-op.
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "rollingReplace" jsonb;
