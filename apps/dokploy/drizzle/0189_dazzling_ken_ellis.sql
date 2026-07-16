DROP INDEX IF EXISTS "preview_deployments_application_pr_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preview_deployments_application_pr_unique" ON "preview_deployments" USING btree ("applicationId","pullRequestId") WHERE "applicationId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployments" ALTER COLUMN "applicationId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewEnv" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewLabels" text[];--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewWildcard" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewLimit" integer DEFAULT 3;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewHttps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewPath" text DEFAULT '/';--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewCertificateType" "certificateType" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewCustomCertResolver" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "isPreviewDeploymentsActive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "previewRequireCollaboratorPermissions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN IF NOT EXISTS "composeId" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preview_deployments" ADD CONSTRAINT "preview_deployments_composeId_compose_composeId_fk" FOREIGN KEY ("composeId") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "preview_deployments_compose_pr_unique" ON "preview_deployments" USING btree ("composeId","pullRequestId") WHERE "composeId" IS NOT NULL;
