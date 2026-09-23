-- Snapvisor integration: one fork table plus four nullable columns on the
-- upstream-owned "application" and "preview_deployments" tables. Guarded
-- (IF NOT EXISTS / duplicate_object) so a re-run after an upstream-to-fork
-- switch is a no-op.
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
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "snapvisorProjectName" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "snapvisorDeploymentId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "snapvisorBuildId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "snapvisorBuildStatus" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "snapvisor_integration" ADD CONSTRAINT "snapvisor_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
