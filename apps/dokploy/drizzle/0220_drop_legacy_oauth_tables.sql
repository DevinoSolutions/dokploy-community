-- Drops the better-auth 1.6 MCP OAuth tables. 0211 copied their live grants into
-- the 1.7 tables (oauth_client, oauth_refresh_token, oauth_provider_access_token,
-- oauth_provider_consent) and no 1.7 table references them. DESTRUCTIVE: the
-- plaintext 1.6 tokens go with the tables and a rollback to 1.6 is no longer
-- possible. Children first (both reference oauth_application.client_id); IF EXISTS
-- so a re-run, or a database that never had them, is a no-op.
DROP TABLE IF EXISTS "oauth_consent" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_access_token" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_application" CASCADE;
