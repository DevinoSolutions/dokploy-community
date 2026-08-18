-- Fork schema catch-up.
--
-- The drizzle migrator applies a migration only when its journal `when`
-- timestamp is strictly greater than the newest `created_at` recorded in
-- drizzle.__drizzle_migrations. A database that was created by upstream
-- Dokploy therefore silently skips every fork-original migration whose
-- `when` slot predates upstream's newest applied migration (fork
-- 0175..0193 all sit below upstream v0.30.0's high-water mark), leaving the
-- fork's own tables/columns/enums missing while the app queries them.
--
-- This migration sits at the tail of the journal (its `when` is greater than
-- every existing entry), so it runs on BOTH upgrade paths, and it is fully
-- idempotent so it is a strict no-op on databases that already carry the
-- fork schema.

--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."networkDriver" AS ENUM('bridge', 'host', 'overlay', 'macvlan', 'none', 'ipvlan');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TYPE "public"."networkDriver" ADD VALUE IF NOT EXISTS 'host';--> statement-breakpoint
ALTER TYPE "public"."networkDriver" ADD VALUE IF NOT EXISTS 'macvlan';--> statement-breakpoint
ALTER TYPE "public"."networkDriver" ADD VALUE IF NOT EXISTS 'none';--> statement-breakpoint
ALTER TYPE "public"."networkDriver" ADD VALUE IF NOT EXISTS 'ipvlan';--> statement-breakpoint
ALTER TYPE "public"."RegistryType" ADD VALUE IF NOT EXISTS 'awsEcr';--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."backupPolicyScopeType" AS ENUM('organization', 'projects', 'environments');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."cloudflareTunnelMode" AS ENUM('existing-instance', 'shared-managed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."cloudflareTunnelRuntimeMode" AS ENUM('shared-managed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."cloudflareTunnelRuntimeStatus" AS ENUM('pending', 'running', 'error', 'stopped');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deploy_hook" (
	"deployHookId" text PRIMARY KEY NOT NULL,
	"applicationId" text NOT NULL,
	"hooks" text,
	CONSTRAINT "deploy_hook_applicationId_unique" UNIQUE("applicationId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloudflare" (
	"cloudflareId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"apiToken" text NOT NULL,
	"accountId" text NOT NULL,
	"defaultTunnelId" text,
	"defaultSessionDuration" text DEFAULT '168h' NOT NULL,
	"protectDomainsByDefault" boolean DEFAULT false NOT NULL,
	"requireProtectedDomains" boolean DEFAULT false NOT NULL,
	"defaultAllowEmails" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"defaultAllowEmailDomains" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloudflare_tunnel_runtime" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"cloudflareId" text NOT NULL,
	"serverId" text,
	"tunnelId" text NOT NULL,
	"tunnelName" text NOT NULL,
	"dockerResourceName" text NOT NULL,
	"runtimeMode" "cloudflareTunnelRuntimeMode" DEFAULT 'shared-managed' NOT NULL,
	"status" "cloudflareTunnelRuntimeStatus" DEFAULT 'pending' NOT NULL,
	"lastError" text,
	"lastStartedAt" timestamp,
	"lastSeenAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloudflare_access_application" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"cloudflareId" text NOT NULL,
	"domainId" text NOT NULL,
	"cloudflareAppId" text NOT NULL,
	"cloudflarePolicyId" text,
	"appDomain" text NOT NULL,
	"sessionDuration" text DEFAULT '24h' NOT NULL,
	"allowEmails" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"allowEmailDomains" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_policy" (
	"backupPolicyId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organizationId" text NOT NULL,
	"scopeType" "backupPolicyScopeType" DEFAULT 'organization' NOT NULL,
	"scopeIds" text[] DEFAULT '{}' NOT NULL,
	"includeDatabases" boolean DEFAULT true NOT NULL,
	"includeVolumes" boolean DEFAULT false NOT NULL,
	"serviceTypeFilter" text[] DEFAULT '{}' NOT NULL,
	"destinationId" text NOT NULL,
	"schedule" text NOT NULL,
	"prefix" text,
	"keepLatestCount" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastSyncError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "pullImagesOnDeploy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "isolatedNetworkMtu" integer;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewEnv" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewLabels" text[];--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewWildcard" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewLimit" integer DEFAULT 3;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewHttps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewPath" text DEFAULT '/';--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewCertificateType" "certificateType" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewCustomCertResolver" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "isPreviewDeploymentsActive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewRequireCollaboratorPermissions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "encryptionEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "encryptionKey" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "encryptionPassword2" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "filenameEncryption" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "directoryNameEncryption" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "publishToCloudflare" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareTunnelMode" "cloudflareTunnelMode";--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareZoneId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareTunnelId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareDnsRecordId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareIngressApplied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "enableCloudflareAccess" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareAccessApplicationId" text;--> statement-breakpoint
ALTER TABLE "mount" ADD COLUMN IF NOT EXISTS "uid" integer;--> statement-breakpoint
ALTER TABLE "mount" ADD COLUMN IF NOT EXISTS "gid" integer;--> statement-breakpoint
ALTER TABLE "mount" ADD COLUMN IF NOT EXISTS "mode" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "scheduleFailure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "logo" text;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN IF NOT EXISTS "awsAccessKeyId" text;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN IF NOT EXISTS "awsSecretAccessKey" text;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN IF NOT EXISTS "awsRegion" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "default_domain" text;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "domainRestrictionConfig" jsonb DEFAULT '{"enabled":false,"allowedWildcards":[]}'::jsonb;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN IF NOT EXISTS "backupPolicyId" text;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD COLUMN IF NOT EXISTS "backupPolicyId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "composeId" text;--> statement-breakpoint
ALTER TABLE "gitlab" ADD COLUMN IF NOT EXISTS "webhook_secret" text;--> statement-breakpoint
UPDATE "gitlab" SET "webhook_secret" = replace(gen_random_uuid()::text, '-', '') WHERE "webhook_secret" IS NULL;--> statement-breakpoint
ALTER TABLE "gitlab" ALTER COLUMN "webhook_secret" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ALTER COLUMN "enableDockerCleanup" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "email" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email" ALTER COLUMN "password" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployments" ALTER COLUMN "pullRequestCommentId" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "preview_deployments" ALTER COLUMN "applicationId" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deploy_hook" ADD CONSTRAINT "deploy_hook_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare" ADD CONSTRAINT "cloudflare_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_tunnel_runtime" ADD CONSTRAINT "cloudflare_tunnel_runtime_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_tunnel_runtime" ADD CONSTRAINT "cloudflare_tunnel_runtime_cloudflareId_cloudflare_cloudflareId_fk" FOREIGN KEY ("cloudflareId") REFERENCES "public"."cloudflare"("cloudflareId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_access_application" ADD CONSTRAINT "cloudflare_access_application_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_access_application" ADD CONSTRAINT "cloudflare_access_application_cloudflareId_cloudflare_cloudflareId_fk" FOREIGN KEY ("cloudflareId") REFERENCES "public"."cloudflare"("cloudflareId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_access_application" ADD CONSTRAINT "cloudflare_access_application_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain" ADD CONSTRAINT "domain_cloudflareId_cloudflare_cloudflareId_fk" FOREIGN KEY ("cloudflareId") REFERENCES "public"."cloudflare"("cloudflareId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_destinationId_destination_destinationId_fk" FOREIGN KEY ("destinationId") REFERENCES "public"."destination"("destinationId") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup" ADD CONSTRAINT "backup_backupPolicyId_backup_policy_backupPolicyId_fk" FOREIGN KEY ("backupPolicyId") REFERENCES "public"."backup_policy"("backupPolicyId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_backupPolicyId_backup_policy_backupPolicyId_fk" FOREIGN KEY ("backupPolicyId") REFERENCES "public"."backup_policy"("backupPolicyId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloudflare_tunnel_runtime_org_server_cf_unique" ON "cloudflare_tunnel_runtime" USING btree ("organizationId","serverId","cloudflareId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloudflare_access_application_domainId_unique" ON "cloudflare_access_application" USING btree ("domainId");--> statement-breakpoint
DELETE FROM "preview_deployments" t1
USING "preview_deployments" t2
WHERE t1."applicationId" = t2."applicationId"
  AND t1."pullRequestId" = t2."pullRequestId"
  AND (
    t1."createdAt" > t2."createdAt"
    OR (t1."createdAt" = t2."createdAt" AND t1."previewDeploymentId" > t2."previewDeploymentId")
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preview_deployments_application_pr_unique" ON "preview_deployments" USING btree ("applicationId","pullRequestId") WHERE "applicationId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preview_deployments_compose_pr_unique" ON "preview_deployments" USING btree ("composeId","pullRequestId") WHERE "composeId" IS NOT NULL;
