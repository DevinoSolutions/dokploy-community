ALTER TYPE "public"."notificationType" ADD VALUE IF NOT EXISTS 'sendly';--> statement-breakpoint
ALTER TYPE "public"."notificationType" ADD VALUE IF NOT EXISTS 'notifly';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifly" (
	"notiflyId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"workflowKey" text NOT NULL,
	"subscriberId" text,
	"baseUrl" text DEFAULT 'https://api.notifly.io' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sendly" (
	"sendlyId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"fromAddress" text NOT NULL,
	"toAddress" text[] NOT NULL,
	"baseUrl" text DEFAULT 'https://app.sendly.now' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "sendlyId" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "notiflyId" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_sendlyId_sendly_sendlyId_fk" FOREIGN KEY ("sendlyId") REFERENCES "public"."sendly"("sendlyId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification" ADD CONSTRAINT "notification_notiflyId_notifly_notiflyId_fk" FOREIGN KEY ("notiflyId") REFERENCES "public"."notifly"("notiflyId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
