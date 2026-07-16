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
DO $$ BEGIN
 CREATE TYPE "public"."cloudflareTunnelMode" AS ENUM('existing-instance', 'shared-managed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
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
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "publishToCloudflare" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareTunnelMode" "cloudflareTunnelMode";--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareZoneId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareTunnelId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareDnsRecordId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareIngressApplied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "enableCloudflareAccess" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "cloudflareAccessApplicationId" text;--> statement-breakpoint
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
CREATE UNIQUE INDEX IF NOT EXISTS "cloudflare_tunnel_runtime_org_server_cf_unique" ON "cloudflare_tunnel_runtime" USING btree ("organizationId","serverId","cloudflareId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloudflare_access_application_domainId_unique" ON "cloudflare_access_application" USING btree ("domainId");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain" ADD CONSTRAINT "domain_cloudflareId_cloudflare_cloudflareId_fk" FOREIGN KEY ("cloudflareId") REFERENCES "public"."cloudflare"("cloudflareId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;