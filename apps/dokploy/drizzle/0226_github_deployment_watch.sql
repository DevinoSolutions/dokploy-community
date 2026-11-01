-- "Deploy from GitHub Deployments" (T-12166): the GitHub accounts an organization connected through the OAuth
-- device flow (token encrypted at rest by the application, like other provider secrets), and the services that
-- follow a repository's GitHub Deployments. A table of its own: the application table sits at the Drizzle /
-- Postgres 100-argument cap (error 54023), so nothing is added to it. Additive only; every statement is guarded
-- so a re-run is a no-op. Numbered after 0225 (PR #576, T-12149): renumber if the order changes.
CREATE TABLE IF NOT EXISTS "github_deployment_connection" (
	"connectionId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"createdByUserId" text,
	"githubLogin" text NOT NULL,
	"githubUserId" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"accessToken" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_deployment_watch" (
	"watchId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serviceType" text NOT NULL,
	"serviceId" text NOT NULL,
	"connectionId" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"postLogUrl" boolean DEFAULT false NOT NULL,
	"lastSeenDeploymentId" bigint,
	"etag" text,
	"inflightDeploymentId" bigint,
	"inflightStartedAt" timestamp,
	"lastCheckedAt" timestamp,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_deployment_watch" ADD COLUMN IF NOT EXISTS "postLogUrl" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "github_deployment_connection" ADD CONSTRAINT "github_deployment_connection_org_user_unique" UNIQUE("organizationId","githubUserId");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "github_deployment_watch" ADD CONSTRAINT "github_deployment_watch_service_unique" UNIQUE("serviceType","serviceId");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "github_deployment_connection" ADD CONSTRAINT "github_deployment_connection_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "github_deployment_watch" ADD CONSTRAINT "github_deployment_watch_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "github_deployment_watch" ADD CONSTRAINT "github_deployment_watch_connectionId_github_deployment_connection_connectionId_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."github_deployment_connection"("connectionId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
