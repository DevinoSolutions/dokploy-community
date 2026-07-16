ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "encryptionEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "encryptionKey" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "encryptionPassword2" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "filenameEncryption" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN IF NOT EXISTS "directoryNameEncryption" boolean DEFAULT false NOT NULL;