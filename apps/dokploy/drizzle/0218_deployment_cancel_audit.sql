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
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploymentCancelAudit_organizationId_idx" ON "deployment_cancel_audit" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploymentCancelAudit_targetId_idx" ON "deployment_cancel_audit" USING btree ("targetId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploymentCancelAudit_createdAt_idx" ON "deployment_cancel_audit" USING btree ("createdAt");
