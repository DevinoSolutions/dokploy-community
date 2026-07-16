ALTER TABLE "gitlab" ADD COLUMN IF NOT EXISTS "webhook_secret" text;--> statement-breakpoint
UPDATE "gitlab" SET "webhook_secret" = replace(gen_random_uuid()::text, '-', '') WHERE "webhook_secret" IS NULL;--> statement-breakpoint
ALTER TABLE "gitlab" ALTER COLUMN "webhook_secret" SET NOT NULL;