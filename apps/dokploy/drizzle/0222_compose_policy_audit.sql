-- Restricted compose, audit mode (read-only): an opt-in organization switch (off by default),
-- the list of composes it skips (empty by default), and the table that records what a sandbox
-- WOULD refuse. Additive only: no existing row is updated or deleted.
-- Guarded so a re-run is a no-op.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "restricted_compose_audit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "restricted_compose_audit_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compose_policy_finding" (
	"composePolicyFindingId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"composeId" text NOT NULL,
	"deploymentId" text,
	"serviceName" text NOT NULL,
	"ruleId" text NOT NULL,
	"detail" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "compose_policy_finding" ADD CONSTRAINT "compose_policy_finding_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composePolicyFinding_organizationId_createdAt_idx" ON "compose_policy_finding" USING btree ("organizationId","createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composePolicyFinding_composeId_idx" ON "compose_policy_finding" USING btree ("composeId");
