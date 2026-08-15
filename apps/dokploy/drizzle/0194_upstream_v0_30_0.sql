DO $$ BEGIN
 CREATE TYPE "public"."DnsProviderType" AS ENUM('cloudflare', 'route53');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."VaultProviderType" AS ENUM('hashicorp', 'infisical', 'aws', 'doppler', 'azure', 'scaleway');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TYPE "public"."VaultProviderType" ADD VALUE IF NOT EXISTS 'scaleway';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dns_provider" (
	"dnsProviderId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"providerType" "DnsProviderType" NOT NULL,
	"config" jsonb NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_provider" (
	"vaultProviderId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"providerType" "VaultProviderType" NOT NULL,
	"config" jsonb NOT NULL,
	"assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "default_role" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "createEnvFile" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dns_provider" ADD CONSTRAINT "dns_provider_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_provider" ADD CONSTRAINT "vault_provider_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dns_provider_org_name_idx" ON "dns_provider" USING btree ("organizationId","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_provider_org_name_idx" ON "vault_provider" USING btree ("organizationId","name");
