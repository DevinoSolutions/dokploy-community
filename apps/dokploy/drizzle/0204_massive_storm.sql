ALTER TYPE "public"."notificationType" ADD VALUE 'sendly';--> statement-breakpoint
ALTER TYPE "public"."notificationType" ADD VALUE 'notifly';--> statement-breakpoint
CREATE TABLE "notifly" (
	"notiflyId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"workflowKey" text NOT NULL,
	"subscriberId" text,
	"baseUrl" text DEFAULT 'https://api.notifly.io' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sendly" (
	"sendlyId" text PRIMARY KEY NOT NULL,
	"apiKey" text NOT NULL,
	"fromAddress" text NOT NULL,
	"toAddress" text[] NOT NULL,
	"baseUrl" text DEFAULT 'https://app.sendly.now' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "sendlyId" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "notiflyId" text;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_sendlyId_sendly_sendlyId_fk" FOREIGN KEY ("sendlyId") REFERENCES "public"."sendly"("sendlyId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_notiflyId_notifly_notiflyId_fk" FOREIGN KEY ("notiflyId") REFERENCES "public"."notifly"("notiflyId") ON DELETE cascade ON UPDATE no action;