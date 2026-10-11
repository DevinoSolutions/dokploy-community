-- Connect-session token (encrypted at rest by the app) so the panel can poll and
-- verify a session without a webhook. Nullable: sessions created before this
-- migration have none. Guarded so a re-run after an upstream-to-fork switch is a no-op.
ALTER TABLE "dodomain_connect_session" ADD COLUMN IF NOT EXISTS "token" text;
