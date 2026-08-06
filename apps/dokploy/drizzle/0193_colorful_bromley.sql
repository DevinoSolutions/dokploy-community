CREATE TABLE IF NOT EXISTS "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
DROP INDEX IF EXISTS "network_name_serverId_idx";--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "icon" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "serviceNetworks" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "github" ADD COLUMN IF NOT EXISTS "githubUrl" text DEFAULT 'https://github.com' NOT NULL;--> statement-breakpoint
ALTER TABLE "libsql" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN IF NOT EXISTS "mtu" integer;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN IF NOT EXISTS "detachDokployNetwork" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
ALTER TABLE "network" DROP COLUMN IF EXISTS "scope";--> statement-breakpoint
ALTER TABLE "network" DROP COLUMN IF EXISTS "ingress";--> statement-breakpoint
ALTER TABLE "network" DROP COLUMN IF EXISTS "configOnly";
