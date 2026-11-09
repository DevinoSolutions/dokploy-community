-- Fork schema catch-up, third edition.
--
-- The drizzle migrator applies a journal entry only when its `when` timestamp
-- is greater than the newest `created_at` recorded in
-- drizzle.__drizzle_migrations. Upstream Dokploy v0.31.0 ships migrations
-- stamped up to 1792806870958 (2026-10-24), so a database created by upstream
-- v0.31.0 that is switched to this fork silently skips every fork-original
-- migration stamped earlier than that: 0201 and 0203..0221, plus 0202 itself.
-- (0195..0200 are covered by 0195_fork_schema_catchup and
-- 0202_fork_schema_catchup_v2, which also run at boot by hash; 0222..0234 are
-- stamped above upstream's newest and apply on their own.)
--
-- This migration re-issues 0201 and 0203..0221 idempotently: ADD VALUE / ADD
-- COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS, constraints in DO blocks
-- with an EXCEPTION guard. Nothing is dropped, renamed or rewritten. Two
-- statements are left out on purpose:
--   * 0201 SET DEFAULT on "webServerSettings"."whitelabelingConfig": 0234
--     already carries the newer default, and re-running the old one here would
--     put it back.
--   * 0211 (copy of better-auth 1.6 grants into the 1.7 tables): upstream has
--     no 1.6 MCP OAuth tables, so there is nothing to copy on an
--     upstream-to-fork switch, and re-running the copy on an instance that
--     already ran it could bring back a token the provider since revoked.
--
-- Upstream v0.31.0's own 0196..0198 (compose.pullImages, telemetry providers,
-- backup.customName, whitelabel default) are carried by
-- 0234_upstream_v0_31_0, which a fork-first instance also applies.
--
-- Sync rule (docs/UPSTREAM_SYNC.md, "Fork-original migrations vs. an
-- upstream-to-fork switch"): every upstream sync adds a new
-- NNNN_fork_schema_catchup_* migration re-issuing each fork-original migration
-- whose `when` is older than upstream's newest migration. This file is also
-- applied at boot by apps/dokploy/server/db/fork-schema-catchup.ts when its
-- hash is missing from drizzle.__drizzle_migrations. Never edit it once
-- shipped: its hash is its identity.
--> statement-breakpoint
-- 0201_steep_sage
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'infomaniak';
--> statement-breakpoint
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'ovh';
--> statement-breakpoint
ALTER TYPE "public"."VaultProviderType" ADD VALUE IF NOT EXISTS 'aws-parameter-store' BEFORE 'doppler';
--> statement-breakpoint
ALTER TABLE "sso_provider" ADD COLUMN IF NOT EXISTS "domain_verified" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- 0203_superb_justin_hammer
DO $$ BEGIN
	CREATE TYPE "public"."uptimelyMonitorKind" AS ENUM('website', 'port', 'ssl', 'domain');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."uptimelyServiceType" AS ENUM('application', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_integration" (
	"uptimelyId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"apiKey" text NOT NULL,
	"projectId" text NOT NULL,
	"baseUrl" text DEFAULT 'https://app.getuptimely.com' NOT NULL,
	"statusPageSlug" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uptimely_integration_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_monitor_link" (
	"linkId" text PRIMARY KEY NOT NULL,
	"uptimelyId" text NOT NULL,
	"serviceType" "uptimelyServiceType" NOT NULL,
	"serviceId" text NOT NULL,
	"monitorId" text NOT NULL,
	"kind" "uptimelyMonitorKind" NOT NULL,
	"target" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "uptimely_integration" ADD CONSTRAINT "uptimely_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "uptimely_monitor_link" ADD CONSTRAINT "uptimely_monitor_link_uptimelyId_uptimely_integration_uptimelyId_fk" FOREIGN KEY ("uptimelyId") REFERENCES "public"."uptimely_integration"("uptimelyId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uptimely_monitor_link_service_monitor_unique" ON "uptimely_monitor_link" USING btree ("serviceType","serviceId","monitorId");
--> statement-breakpoint
-- 0204_massive_storm
ALTER TYPE "public"."notificationType" ADD VALUE IF NOT EXISTS 'sendly';
--> statement-breakpoint
ALTER TYPE "public"."notificationType" ADD VALUE IF NOT EXISTS 'notifly';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifly" (
	"notiflyId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"workflowKey" text NOT NULL,
	"subscriberId" text,
	"baseUrl" text DEFAULT 'https://api.notifly.io' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sendly" (
	"sendlyId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"fromAddress" text NOT NULL,
	"toAddress" text[] NOT NULL,
	"baseUrl" text DEFAULT 'https://app.sendly.now' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "sendlyId" text;
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "notiflyId" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_sendlyId_sendly_sendlyId_fk" FOREIGN KEY ("sendlyId") REFERENCES "public"."sendly"("sendlyId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_notiflyId_notifly_notiflyId_fk" FOREIGN KEY ("notiflyId") REFERENCES "public"."notifly"("notiflyId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- 0205_premium_inertia
CREATE TABLE IF NOT EXISTS "dodomain_connect_session" (
	"sessionId" text PRIMARY KEY NOT NULL,
	"domainId" text NOT NULL,
	"dodomainId" text NOT NULL,
	"connectUrl" text NOT NULL,
	"records" jsonb NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dodomain_integration" (
	"dodomainId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"secretKey" text NOT NULL,
	"appId" text NOT NULL,
	"baseUrl" text DEFAULT 'https://app.dodomain.io' NOT NULL,
	"webhookEndpointId" text,
	"webhookUrl" text,
	"webhookSecret" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "dodomain_integration_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dodomain_webhook_delivery" (
	"deliveryId" text PRIMARY KEY NOT NULL,
	"receivedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dodomainConnectionId" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dodomainSessionId" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsVerificationStatus" text;
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsVerifiedAt" timestamp;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dodomain_connect_session" ADD CONSTRAINT "dodomain_connect_session_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dodomain_connect_session" ADD CONSTRAINT "dodomain_connect_session_dodomainId_dodomain_integration_dodomainId_fk" FOREIGN KEY ("dodomainId") REFERENCES "public"."dodomain_integration"("dodomainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dodomain_integration" ADD CONSTRAINT "dodomain_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- 0206_blushing_miss_america
CREATE TABLE IF NOT EXISTS "snapvisor_integration" (
	"snapvisorId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"accessToken" text NOT NULL,
	"accountSlug" text NOT NULL,
	"baseUrl" text DEFAULT 'https://app.snapvisor.io' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "snapvisor_integration_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "snapvisorProjectName" text;
--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "snapvisorDeploymentId" text;
--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "snapvisorBuildId" text;
--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "snapvisorBuildStatus" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "snapvisor_integration" ADD CONSTRAINT "snapvisor_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- 0207_deployment_queue_journal
CREATE TABLE IF NOT EXISTS "deployment_queue_job" (
	"jobId" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"enqueuedAt" timestamp DEFAULT now() NOT NULL,
	"startedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "snapvisor_integration" ALTER COLUMN "baseUrl" SET DEFAULT 'https://api.snapvisor.io';
--> statement-breakpoint
-- 0208_compose_build_server
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "buildServerId" text;
--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "buildRegistryId" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compose" ADD CONSTRAINT "compose_buildServerId_server_serverId_fk" FOREIGN KEY ("buildServerId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compose" ADD CONSTRAINT "compose_buildRegistryId_registry_registryId_fk" FOREIGN KEY ("buildRegistryId") REFERENCES "public"."registry"("registryId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- 0209_preview_docker_image
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "previewDockerImage" text;
--> statement-breakpoint
-- 0210_better_auth_1_7_tables
CREATE TABLE IF NOT EXISTS "oauth_provider_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_provider_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[] DEFAULT '{}',
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_provider_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"revoked" timestamp,
	"rotated_at" timestamp,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp,
	"auth_time" timestamp,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_connection_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"decommissioned_at" timestamp,
	"decommission_status" text DEFAULT 'active' NOT NULL,
	"decommission_cursor_user_id" text,
	"decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
	"decommission_batch_count" integer DEFAULT 0 NOT NULL,
	"decommission_revision" integer DEFAULT 0 NOT NULL,
	"decommission_completed_at" timestamp,
	"decommission_lease_id" text,
	"decommission_lease_expires_at" timestamp,
	CONSTRAINT "scim_connection_binding_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_group" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"order_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "scim_group_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_group_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_group_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_group_member" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"membership_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "scim_group_member_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_identity_tombstone" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"user_id" text NOT NULL,
	"profile" text NOT NULL,
	"deleted_at" timestamp NOT NULL,
	CONSTRAINT "scim_identity_tombstone_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_managed_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"creation_request_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"created_by" text NOT NULL,
	"decommission_started_at" timestamp,
	"decommission_started_by" text,
	"decommissioned_at" timestamp,
	"decommissioned_by" text,
	CONSTRAINT "scim_managed_connection_creation_request_id_unique" UNIQUE("creation_request_id"),
	CONSTRAINT "scim_managed_connection_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_managed_connection_event" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_record_id" text NOT NULL,
	"event_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"credential_id" text,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "scim_managed_connection_event_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_managed_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_record_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"hash_version" text NOT NULL,
	"active_slot_key" text NOT NULL,
	"status" text NOT NULL,
	"serialized_scopes" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by" text,
	"decommissioned_at" timestamp,
	CONSTRAINT "scim_managed_credential_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "scim_managed_credential_active_slot_key_unique" UNIQUE("active_slot_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_projection_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_value" text,
	"role" text NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "scim_projection_grant_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_subject" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "scim_subject_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scim_user" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_user_key" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	"email_value_index" text NOT NULL,
	"display_name" text NOT NULL,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"serialized_emails" text NOT NULL,
	"serialized_attributes" text,
	"external_id" text,
	"external_id_key" text,
	"active" boolean NOT NULL,
	"order_key" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "scim_user_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_user_user_name_key_unique" UNIQUE("user_name_key"),
	CONSTRAINT "scim_user_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_user_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_provider_access_token" ADD CONSTRAINT "oauth_provider_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_provider_access_token" ADD CONSTRAINT "oauth_provider_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_provider_access_token" ADD CONSTRAINT "oauth_provider_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_provider_access_token" ADD CONSTRAINT "oauth_provider_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_provider_consent" ADD CONSTRAINT "oauth_provider_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_provider_consent" ADD CONSTRAINT "oauth_provider_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_identity_tombstone" ADD CONSTRAINT "scim_identity_tombstone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_managed_connection_event" ADD CONSTRAINT "scim_managed_connection_event_connection_record_id_scim_managed_connection_id_fk" FOREIGN KEY ("connection_record_id") REFERENCES "public"."scim_managed_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_managed_credential" ADD CONSTRAINT "scim_managed_credential_connection_record_id_scim_managed_connection_id_fk" FOREIGN KEY ("connection_record_id") REFERENCES "public"."scim_managed_connection"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_subject" ADD CONSTRAINT "scim_subject_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scim_user" ADD CONSTRAINT "scim_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_client_id_idx" ON "oauth_provider_access_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_session_id_idx" ON "oauth_provider_access_token" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_user_id_idx" ON "oauth_provider_access_token" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_authorization_code_id_idx" ON "oauth_provider_access_token" USING btree ("authorization_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_access_token_refresh_id_idx" ON "oauth_provider_access_token" USING btree ("refresh_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_user_id_idx" ON "oauth_client" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_client_id_idx" ON "oauth_client_resource" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" USING btree ("resource_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_client_resource_client_id_resource_id_uidx" ON "oauth_client_resource" USING btree ("client_id","resource_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_consent_client_id_idx" ON "oauth_provider_consent" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_provider_consent_user_id_idx" ON "oauth_provider_consent" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_connection_binding_connection_id_idx" ON "scim_connection_binding" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_connection_id_idx" ON "scim_group" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_provisioning_domain_id_idx" ON "scim_group" USING btree ("provisioning_domain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_member_connection_id_idx" ON "scim_group_member" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_member_group_id_idx" ON "scim_group_member" USING btree ("group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_group_member_scim_user_id_idx" ON "scim_group_member" USING btree ("scim_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_identity_tombstone_connection_id_idx" ON "scim_identity_tombstone" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_identity_tombstone_provisioning_domain_id_idx" ON "scim_identity_tombstone" USING btree ("provisioning_domain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_identity_tombstone_user_id_idx" ON "scim_identity_tombstone" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_managed_connection_provisioning_domain_id_idx" ON "scim_managed_connection" USING btree ("provisioning_domain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_managed_connection_event_connection_record_id_idx" ON "scim_managed_connection_event" USING btree ("connection_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_managed_credential_connection_record_id_idx" ON "scim_managed_credential" USING btree ("connection_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grant_connection_id_idx" ON "scim_projection_grant" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grant_provisioning_domain_id_idx" ON "scim_projection_grant" USING btree ("provisioning_domain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grant_scim_user_id_idx" ON "scim_projection_grant" USING btree ("scim_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_projection_grant_user_id_idx" ON "scim_projection_grant" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_subject_profile_source_id_idx" ON "scim_subject" USING btree ("profile_source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_user_connection_id_idx" ON "scim_user" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_user_provisioning_domain_id_idx" ON "scim_user" USING btree ("provisioning_domain_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scim_user_user_id_idx" ON "scim_user" USING btree ("user_id");
--> statement-breakpoint
-- 0212_uptimely_heartbeat_channel
ALTER TYPE "public"."notificationType" ADD VALUE IF NOT EXISTS 'uptimely';
--> statement-breakpoint
ALTER TYPE "public"."uptimelyMonitorKind" ADD VALUE IF NOT EXISTS 'heartbeat';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_channel" (
	"uptimelyChannelId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"projectId" text NOT NULL,
	"baseUrl" text DEFAULT 'https://app.getuptimely.com' NOT NULL,
	"resolvedStateId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_channel_incident" (
	"channelIncidentId" text PRIMARY KEY NOT NULL,
	"uptimelyChannelId" text NOT NULL,
	"serviceKey" text NOT NULL,
	"incidentId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "uptimelyChannelId" text;
--> statement-breakpoint
ALTER TABLE "uptimely_monitor_link" ADD COLUMN IF NOT EXISTS "heartbeatKey" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "uptimely_channel_incident" ADD CONSTRAINT "uptimely_channel_incident_uptimelyChannelId_uptimely_channel_uptimelyChannelId_fk" FOREIGN KEY ("uptimelyChannelId") REFERENCES "public"."uptimely_channel"("uptimelyChannelId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uptimely_channel_incident_service_unique" ON "uptimely_channel_incident" USING btree ("uptimelyChannelId","serviceKey");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_uptimelyChannelId_uptimely_channel_uptimelyChannelId_fk" FOREIGN KEY ("uptimelyChannelId") REFERENCES "public"."uptimely_channel"("uptimelyChannelId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- 0213_snapvisor_compose_project
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "snapvisorProjectName" text;
--> statement-breakpoint
-- 0214_dodomain_session_token
ALTER TABLE "dodomain_connect_session" ADD COLUMN IF NOT EXISTS "token" text;
--> statement-breakpoint
-- 0215_snapvisor_build_checks
CREATE TABLE IF NOT EXISTS "snapvisor_build_check" (
	"checkId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serviceType" text NOT NULL,
	"serviceId" text NOT NULL,
	"deploymentId" text,
	"commitSha" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"errorStreak" integer DEFAULT 0 NOT NULL,
	"buildNumber" integer,
	"buildStatus" text,
	"nextCheckAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"notifiedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "snapvisorChanges" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "snapvisor_build_check" ADD CONSTRAINT "snapvisor_build_check_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "snapvisor_build_check_service_commit_unique" ON "snapvisor_build_check" USING btree ("serviceId","commitSha");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapvisor_build_check_due_idx" ON "snapvisor_build_check" USING btree ("state","nextCheckAt");
--> statement-breakpoint
-- 0216_compose_deploy_guardrails
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "deployGuardrails" jsonb;
--> statement-breakpoint
-- 0217_compose_rolling_replace
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "rollingReplace" jsonb;
--> statement-breakpoint
-- 0218_deployment_cancel_audit
CREATE TABLE IF NOT EXISTS "deployment_cancel_audit" (
	"deploymentCancelAuditId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"action" text NOT NULL,
	"actorType" text NOT NULL,
	"actorId" text,
	"actorEmail" text,
	"apiKeyId" text,
	"targetType" text NOT NULL,
	"targetId" text,
	"targetName" text,
	"applicationId" text,
	"composeId" text,
	"deploymentId" text,
	"metadata" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "deployment_cancel_audit" ADD CONSTRAINT "deployment_cancel_audit_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploymentCancelAudit_organizationId_idx" ON "deployment_cancel_audit" USING btree ("organizationId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploymentCancelAudit_targetId_idx" ON "deployment_cancel_audit" USING btree ("targetId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploymentCancelAudit_createdAt_idx" ON "deployment_cancel_audit" USING btree ("createdAt");
--> statement-breakpoint
-- 0219_deployment_cancel_audit_oauth_client
ALTER TABLE "deployment_cancel_audit" ADD COLUMN IF NOT EXISTS "oauthClientId" text;
--> statement-breakpoint
-- 0220_docker_cleanup_cron
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "dockerCleanupCron" text DEFAULT '0 4 * * *' NOT NULL;
--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "dockerCleanupCron" text DEFAULT '0 4 * * *' NOT NULL;
--> statement-breakpoint
-- 0221_deployment_watchdog
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogEnabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogIdleMinutes" integer DEFAULT 20 NOT NULL;
--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogMaxMinutes" integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "deploymentWatchdogExclusions" jsonb DEFAULT '[]'::jsonb NOT NULL;
