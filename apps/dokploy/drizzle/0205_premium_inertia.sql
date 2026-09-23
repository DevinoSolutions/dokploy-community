-- DoDomain integration: three fork tables plus four nullable verification
-- columns on the upstream-owned "domain" table. Guarded (IF NOT EXISTS /
-- duplicate_object) so a re-run after an upstream-to-fork switch is a no-op.
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
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dodomainConnectionId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dodomainSessionId" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsVerificationStatus" text;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "dnsVerifiedAt" timestamp;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dodomain_connect_session" ADD CONSTRAINT "dodomain_connect_session_domainId_domain_domainId_fk" FOREIGN KEY ("domainId") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dodomain_connect_session" ADD CONSTRAINT "dodomain_connect_session_dodomainId_dodomain_integration_dodomainId_fk" FOREIGN KEY ("dodomainId") REFERENCES "public"."dodomain_integration"("dodomainId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dodomain_integration" ADD CONSTRAINT "dodomain_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
