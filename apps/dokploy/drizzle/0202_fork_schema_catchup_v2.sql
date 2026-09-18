-- Fork schema catch-up, second edition.
--
-- The drizzle migrator applies a journal entry only when its `when` timestamp
-- is greater than the newest `created_at` recorded in
-- drizzle.__drizzle_migrations. Upstream Dokploy v0.30.6 ships migrations
-- stamped up to 2026-09-08, so a database created by upstream v0.30.6 that is
-- switched to this fork silently skips every fork-original migration stamped
-- earlier than that: 0195_fork_schema_catchup (2026-08-18), 0196 (network
-- dockerId + server.terminal role backfill), 0197 (wildcard domains), 0198
-- (MCP OAuth tables) and 0199 (v0.30.5 re-issue). Only 0200 and 0201 land,
-- which is exactly the shape reported from the field: build_policy_* tables
-- exist while organization.wildcard_domain and oauth_access_token do not.
--
-- This migration re-issues 0196..0200 idempotently. 0195's own content is not
-- repeated: every *_fork_schema_catchup* migration is additionally applied at
-- boot by apps/dokploy/server/db/fork-schema-catchup.ts whenever its file hash
-- is missing from drizzle.__drizzle_migrations, independent of `when`
-- ordering, so 0195 heals through that path.
--
-- Sync rule (docs/UPSTREAM_SYNC.md, "Fork-original migrations vs. an
-- upstream-to-fork switch"): every upstream sync adds a new
-- NNNN_fork_schema_catchup_* migration re-issuing each fork-original migration
-- whose `when` is older than upstream's newest migration.
--> statement-breakpoint
-- 0196_robust_lucky_pierre
--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN IF NOT EXISTS "dockerId" text;
--> statement-breakpoint
-- Grant the new "server.terminal" permission to existing custom roles that already have
-- "server.read", which is the permission that surfaces the terminal in the UI today.
-- Roles without a "server" entry are deliberately left alone: they never saw the terminal in the
-- UI, so from now on they are denied at the websocket too.
UPDATE "organization_role" AS r
SET "permission" = jsonb_set(
	r."permission"::jsonb,
	'{server}',
	(r."permission"::jsonb->'server') || '["terminal"]'::jsonb
)::text
WHERE jsonb_typeof(r."permission"::jsonb->'server') = 'array'
AND r."permission"::jsonb->'server' @> '["read"]'::jsonb
AND NOT r."permission"::jsonb->'server' @> '["terminal"]'::jsonb;
--> statement-breakpoint
-- 0197_lush_roughhouse
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "wildcard_domain" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "wildcardDomain" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "useOrganizationWildcard" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- 0198_good_harry_osborn
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"icon" text,
	"metadata" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"user_id" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "oauth_application_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"access_token_expires_at" timestamp NOT NULL,
	"refresh_token_expires_at" timestamp,
	"client_id" text NOT NULL,
	"user_id" text,
	"scopes" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "oauth_access_token_access_token_unique" UNIQUE("access_token"),
	CONSTRAINT "oauth_access_token_refresh_token_unique" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"consent_given" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_application" ADD CONSTRAINT "oauth_application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_application_user_id_idx" ON "oauth_application" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_client_id_idx" ON "oauth_access_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_user_id_idx" ON "oauth_access_token" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_client_id_idx" ON "oauth_consent" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_user_id_idx" ON "oauth_consent" USING btree ("user_id");
--> statement-breakpoint
-- 0199_complex_mantis (the onboarding backfill only runs when this statement
-- is the one adding the column: users created after the column already
-- existed must keep NULL so the wizard still shows for them)
--> statement-breakpoint
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'porkbun';
--> statement-breakpoint
ALTER TYPE "public"."VaultProviderType" ADD VALUE IF NOT EXISTS 'phase';
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'user'
			AND column_name = 'onboardingCompletedAt'
	) THEN
		ALTER TABLE "user" ADD COLUMN "onboardingCompletedAt" timestamp;
		UPDATE "user" SET "onboardingCompletedAt" = now();
	END IF;
EXCEPTION WHEN duplicate_column THEN null; END $$;
--> statement-breakpoint
-- 0200_handy_lifeguard
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."buildPolicyAuditAction" AS ENUM('settings_updated', 'exclusion_added', 'exclusion_removed', 'break_glass_granted', 'break_glass_consumed', 'remote_build_enforced', 'build_server_missing', 'deploy_coalesced', 'deploy_skipped', 'required_checks_failed', 'required_checks_timeout', 'deploy_by_digest');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_policy_audit" (
	"buildPolicyAuditId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"action" "buildPolicyAuditAction" NOT NULL,
	"applicationId" text,
	"composeId" text,
	"actorId" text,
	"actorEmail" text,
	"reason" text,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"consumedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_policy_exclusion" (
	"buildPolicyExclusionId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"applicationId" text,
	"composeId" text,
	"reason" text,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_policy_settings" (
	"buildPolicySettingsId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"enforceRemoteBuilds" boolean DEFAULT false NOT NULL,
	"defaultBuildServerId" text,
	"defaultRegistryId" text,
	"requiredChecksTimeoutMinutes" integer DEFAULT 5 NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "build_policy_settings_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "requiredChecks" text[];
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "requiredChecks" text[];
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageTag" text;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageDigest" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_actorId_user_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_exclusion" ADD CONSTRAINT "build_policy_exclusion_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_exclusion" ADD CONSTRAINT "build_policy_exclusion_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_exclusion" ADD CONSTRAINT "build_policy_exclusion_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_settings" ADD CONSTRAINT "build_policy_settings_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_settings" ADD CONSTRAINT "build_policy_settings_defaultBuildServerId_server_serverId_fk" FOREIGN KEY ("defaultBuildServerId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_settings" ADD CONSTRAINT "build_policy_settings_defaultRegistryId_registry_registryId_fk" FOREIGN KEY ("defaultRegistryId") REFERENCES "public"."registry"("registryId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_organizationId_idx" ON "build_policy_audit" USING btree ("organizationId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_applicationId_idx" ON "build_policy_audit" USING btree ("applicationId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_composeId_idx" ON "build_policy_audit" USING btree ("composeId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_createdAt_idx" ON "build_policy_audit" USING btree ("createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyExclusion_organizationId_idx" ON "build_policy_exclusion" USING btree ("organizationId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyExclusion_applicationId_idx" ON "build_policy_exclusion" USING btree ("applicationId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyExclusion_composeId_idx" ON "build_policy_exclusion" USING btree ("composeId");
