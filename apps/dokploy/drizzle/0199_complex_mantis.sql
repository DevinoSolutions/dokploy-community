-- Re-issue of upstream v0.30.4/v0.30.5 migrations 0188_volatile_piledriver,
-- 0189_wooden_nextwave and 0190_nappy_anita_blake in a fork slot: the fork had
-- already released migrations at 0188/0189/0190, so upstream's copies were
-- dropped and their schema delta regenerated here. Guarded with IF NOT EXISTS
-- so instances that somehow already have these objects are a no-op.
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'porkbun';--> statement-breakpoint
ALTER TYPE "public"."VaultProviderType" ADD VALUE IF NOT EXISTS 'phase';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" timestamp;--> statement-breakpoint
-- Hand-carried verbatim from upstream 0190_nappy_anita_blake (drizzle cannot
-- emit data migrations).
-- Backfill only: existing users shouldn't see the onboarding wizard just
-- because this column is new. Not a column-level DEFAULT - that would also
-- apply to rows inserted after this migration, and newly created users
-- (self-hosted setup, cloud signups) need onboardingCompletedAt to stay NULL
-- so the wizard still shows for them.
UPDATE "user" SET "onboardingCompletedAt" = now() WHERE "onboardingCompletedAt" IS NULL;
