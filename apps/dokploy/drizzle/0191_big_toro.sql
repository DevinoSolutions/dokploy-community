DO $$ BEGIN
 CREATE TYPE "public"."backupPolicyScopeType" AS ENUM('organization', 'projects', 'environments');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_policy" (
	"backupPolicyId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"organizationId" text NOT NULL,
	"scopeType" "backupPolicyScopeType" DEFAULT 'organization' NOT NULL,
	"scopeIds" text[] DEFAULT '{}' NOT NULL,
	"includeDatabases" boolean DEFAULT true NOT NULL,
	"includeVolumes" boolean DEFAULT false NOT NULL,
	"serviceTypeFilter" text[] DEFAULT '{}' NOT NULL,
	"destinationId" text NOT NULL,
	"schedule" text NOT NULL,
	"prefix" text,
	"keepLatestCount" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastSyncError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN IF NOT EXISTS "backupPolicyId" text;--> statement-breakpoint
ALTER TABLE "volume_backup" ADD COLUMN IF NOT EXISTS "backupPolicyId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policy" ADD CONSTRAINT "backup_policy_destinationId_destination_destinationId_fk" FOREIGN KEY ("destinationId") REFERENCES "public"."destination"("destinationId") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup" ADD CONSTRAINT "backup_backupPolicyId_backup_policy_backupPolicyId_fk" FOREIGN KEY ("backupPolicyId") REFERENCES "public"."backup_policy"("backupPolicyId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "volume_backup" ADD CONSTRAINT "volume_backup_backupPolicyId_backup_policy_backupPolicyId_fk" FOREIGN KEY ("backupPolicyId") REFERENCES "public"."backup_policy"("backupPolicyId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
