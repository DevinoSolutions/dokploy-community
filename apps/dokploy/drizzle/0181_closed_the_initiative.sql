ALTER TABLE "mount" ADD COLUMN IF NOT EXISTS "uid" integer;--> statement-breakpoint
ALTER TABLE "mount" ADD COLUMN IF NOT EXISTS "gid" integer;--> statement-breakpoint
ALTER TABLE "mount" ADD COLUMN IF NOT EXISTS "mode" text;