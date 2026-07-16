CREATE TABLE IF NOT EXISTS "deploy_hook" (
	"deployHookId" text PRIMARY KEY NOT NULL,
	"applicationId" text NOT NULL,
	"hooks" text,
	CONSTRAINT "deploy_hook_applicationId_unique" UNIQUE("applicationId")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deploy_hook" ADD CONSTRAINT "deploy_hook_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
