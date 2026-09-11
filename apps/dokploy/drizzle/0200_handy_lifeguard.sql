-- Fork migration: build policy (enforced remote builds).
-- See packages/server/src/services/build-policy/README.md.
-- Written idempotently (fork house style) so a re-run on a partially
-- migrated database is a no-op rather than a hard failure.
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."buildPolicyAuditAction" AS ENUM('settings_updated', 'exclusion_added', 'exclusion_removed', 'break_glass_granted', 'break_glass_consumed', 'remote_build_enforced', 'build_server_missing', 'deploy_coalesced', 'deploy_skipped', 'required_checks_failed', 'required_checks_timeout', 'deploy_by_digest');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
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
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "requiredChecks" text[];--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "requiredChecks" text[];--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageTag" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "imageDigest" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_audit" ADD CONSTRAINT "build_policy_audit_actorId_user_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_exclusion" ADD CONSTRAINT "build_policy_exclusion_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_exclusion" ADD CONSTRAINT "build_policy_exclusion_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_exclusion" ADD CONSTRAINT "build_policy_exclusion_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_settings" ADD CONSTRAINT "build_policy_settings_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_settings" ADD CONSTRAINT "build_policy_settings_defaultBuildServerId_server_serverId_fk" FOREIGN KEY ("defaultBuildServerId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "build_policy_settings" ADD CONSTRAINT "build_policy_settings_defaultRegistryId_registry_registryId_fk" FOREIGN KEY ("defaultRegistryId") REFERENCES "public"."registry"("registryId") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_organizationId_idx" ON "build_policy_audit" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_applicationId_idx" ON "build_policy_audit" USING btree ("applicationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_composeId_idx" ON "build_policy_audit" USING btree ("composeId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyAudit_createdAt_idx" ON "build_policy_audit" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyExclusion_organizationId_idx" ON "build_policy_exclusion" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyExclusion_applicationId_idx" ON "build_policy_exclusion" USING btree ("applicationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "buildPolicyExclusion_composeId_idx" ON "build_policy_exclusion" USING btree ("composeId");
