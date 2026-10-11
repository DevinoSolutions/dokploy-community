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
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "snapvisorChanges" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "snapvisor_build_check" ADD CONSTRAINT "snapvisor_build_check_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "snapvisor_build_check_service_commit_unique" ON "snapvisor_build_check" USING btree ("serviceId","commitSha");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapvisor_build_check_due_idx" ON "snapvisor_build_check" USING btree ("state","nextCheckAt");
