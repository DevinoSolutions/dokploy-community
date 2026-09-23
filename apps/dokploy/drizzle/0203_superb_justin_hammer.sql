DO $$ BEGIN
	CREATE TYPE "public"."uptimelyMonitorKind" AS ENUM('website', 'port', 'ssl', 'domain');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."uptimelyServiceType" AS ENUM('application', 'compose', 'postgres', 'mysql', 'mariadb', 'mongo', 'redis');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_integration" (
	"uptimelyId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"apiKey" text NOT NULL,
	"projectId" text NOT NULL,
	"baseUrl" text DEFAULT 'https://app.getuptimely.com' NOT NULL,
	"statusPageSlug" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uptimely_integration_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_monitor_link" (
	"linkId" text PRIMARY KEY NOT NULL,
	"uptimelyId" text NOT NULL,
	"serviceType" "uptimelyServiceType" NOT NULL,
	"serviceId" text NOT NULL,
	"monitorId" text NOT NULL,
	"kind" "uptimelyMonitorKind" NOT NULL,
	"target" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "uptimely_integration" ADD CONSTRAINT "uptimely_integration_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "uptimely_monitor_link" ADD CONSTRAINT "uptimely_monitor_link_uptimelyId_uptimely_integration_uptimelyId_fk" FOREIGN KEY ("uptimelyId") REFERENCES "public"."uptimely_integration"("uptimelyId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uptimely_monitor_link_service_monitor_unique" ON "uptimely_monitor_link" USING btree ("serviceType","serviceId","monitorId");
