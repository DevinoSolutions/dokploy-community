ALTER TYPE "public"."RegistryType" ADD VALUE IF NOT EXISTS 'awsEcr';--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN IF NOT EXISTS "awsAccessKeyId" text;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN IF NOT EXISTS "awsSecretAccessKey" text;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN IF NOT EXISTS "awsRegion" text;
