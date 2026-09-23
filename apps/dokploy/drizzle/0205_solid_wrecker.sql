CREATE TABLE "snapvisor_integration" (
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
ALTER TABLE "application" ADD COLUMN "snapvisorProjectName" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "snapvisorDeploymentId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "snapvisorBuildId" text;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "snapvisorBuildStatus" text;--> statement-breakpoint
ALTER TABLE "snapvisor_integration" ADD CONSTRAINT "snapvisor_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;