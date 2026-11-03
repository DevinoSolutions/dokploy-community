-- "Build on GitHub Actions", connected natively (T-13719): the services that follow a repository's GitHub Actions
-- releases (gha_connection) and every release they accepted (gha_release). Tables of their own: the application table
-- sits at the Drizzle / Postgres 100-argument cap (error 54023), so nothing is added to it. Additive only; every
-- statement is guarded so a re-run is a no-op. Numbered after 0228 (PR #577, T-12166): renumber if the order changes.
CREATE TABLE IF NOT EXISTS "gha_connection" (
	"ghaConnectionId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serviceType" text NOT NULL,
	"serviceId" text NOT NULL,
	"githubConnectionId" text NOT NULL,
	"repoId" bigint NOT NULL,
	"repoFullName" text NOT NULL,
	"workflowPath" text DEFAULT '.github/workflows/dokploy.yml' NOT NULL,
	"trackedBranch" text NOT NULL,
	"environment" text NOT NULL,
	"serviceKey" text NOT NULL,
	"protectionMode" text DEFAULT 'environment' NOT NULL,
	"registryPrefix" text,
	"registryId" text,
	"registryProbeHost" text,
	"gateMode" text DEFAULT 'image' NOT NULL,
	"gateStartedAt" timestamp,
	"state" text DEFAULT 'waiting' NOT NULL,
	"stateDetail" text,
	"stateSince" timestamp DEFAULT now() NOT NULL,
	"expectedSha" text,
	"deployedSha" text,
	"deployedRunId" bigint,
	"deployedRunAttempt" integer,
	"deployedDigests" jsonb,
	"deployedAt" timestamp,
	"processed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previousSource" jsonb,
	"lastActivityAt" timestamp,
	"lastRunSeenId" bigint,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gha_release" (
	"releaseId" text PRIMARY KEY NOT NULL,
	"ghaConnectionId" text NOT NULL,
	"manifestReleaseId" text NOT NULL,
	"sha" text NOT NULL,
	"runId" bigint NOT NULL,
	"runAttempt" integer NOT NULL,
	"delivery" text NOT NULL,
	"status" text NOT NULL,
	"githubDeploymentId" bigint,
	"images" jsonb NOT NULL,
	"digests" jsonb NOT NULL,
	"sourceBackup" jsonb,
	"pinned" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"settledAt" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_service_unique" UNIQUE("serviceType","serviceId");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_repo_key_unique" UNIQUE("repoId","environment","serviceKey");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_release" ADD CONSTRAINT "gha_release_run_unique" UNIQUE("ghaConnectionId","runId","runAttempt");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_github_connection_fk" FOREIGN KEY ("githubConnectionId") REFERENCES "public"."github_deployment_connection"("connectionId") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_release" ADD CONSTRAINT "gha_release_ghaConnectionId_gha_connection_ghaConnectionId_fk" FOREIGN KEY ("ghaConnectionId") REFERENCES "public"."gha_connection"("ghaConnectionId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gha_release_connection_created_idx" ON "gha_release" USING btree ("ghaConnectionId","createdAt");
