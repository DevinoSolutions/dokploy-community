ALTER TYPE "public"."notificationType" ADD VALUE IF NOT EXISTS 'uptimely';--> statement-breakpoint
ALTER TYPE "public"."uptimelyMonitorKind" ADD VALUE IF NOT EXISTS 'heartbeat';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_channel" (
	"uptimelyChannelId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"projectId" text NOT NULL,
	"baseUrl" text DEFAULT 'https://app.getuptimely.com' NOT NULL,
	"resolvedStateId" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uptimely_channel_incident" (
	"channelIncidentId" text PRIMARY KEY NOT NULL,
	"uptimelyChannelId" text NOT NULL,
	"serviceKey" text NOT NULL,
	"incidentId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "uptimelyChannelId" text;--> statement-breakpoint
ALTER TABLE "uptimely_monitor_link" ADD COLUMN IF NOT EXISTS "heartbeatKey" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "uptimely_channel_incident" ADD CONSTRAINT "uptimely_channel_incident_uptimelyChannelId_uptimely_channel_uptimelyChannelId_fk" FOREIGN KEY ("uptimelyChannelId") REFERENCES "public"."uptimely_channel"("uptimelyChannelId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uptimely_channel_incident_service_unique" ON "uptimely_channel_incident" USING btree ("uptimelyChannelId","serviceKey");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_uptimelyChannelId_uptimely_channel_uptimelyChannelId_fk" FOREIGN KEY ("uptimelyChannelId") REFERENCES "public"."uptimely_channel"("uptimelyChannelId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
