-- Re-issue of upstream v0.30.6 migrations 0191_cool_christian_walker,
-- 0192_light_lake, 0193_chemical_the_liberteens, 0194_acoustic_prima and
-- 0195_classy_whirlwind in a fork slot: the fork had already released
-- migrations at 0191-0195, so upstream's copies were dropped and their schema
-- delta regenerated here. Guarded with IF NOT EXISTS so instances that somehow
-- already have these objects are a no-op.
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'infomaniak';--> statement-breakpoint
ALTER TYPE "public"."DnsProviderType" ADD VALUE IF NOT EXISTS 'ovh';--> statement-breakpoint
ALTER TYPE "public"."VaultProviderType" ADD VALUE IF NOT EXISTS 'aws-parameter-store' BEFORE 'doppler';--> statement-breakpoint
ALTER TABLE "webServerSettings" ALTER COLUMN "whitelabelingConfig" SET DEFAULT '{"appName":null,"appDescription":null,"logoUrl":null,"faviconUrl":null,"customCss":null,"loginLogoUrl":null,"supportUrl":null,"docsUrl":null,"errorPageTitle":null,"errorPageDescription":null,"footerText":null,"ogImageUrl":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD COLUMN IF NOT EXISTS "domain_verified" boolean DEFAULT true NOT NULL;
