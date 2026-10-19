-- Cancel trail: the OAuth client behind a cancel made with an MCP bearer token.
-- Nullable, no default: NULL = not an OAuth client call. Guarded so a re-run is a no-op.
ALTER TABLE "deployment_cancel_audit" ADD COLUMN IF NOT EXISTS "oauthClientId" text;
