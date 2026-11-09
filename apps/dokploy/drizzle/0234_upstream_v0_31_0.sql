-- Upstream Dokploy v0.31.0 sync: schema deltas after the fork catch-up chain. Upstream's own
-- 0196 / 0197 / 0198 are NOT applied; this migration carries their schema effect, regenerated after the
-- fork chain. Every statement is guarded so a re-run, or a database that already has a column, is a no-op.
--   * compose.pullImages (upstream #5410) replaces the fork's compose.pullImagesOnDeploy. The new column is
--     ADDED and filled from the old one once; the old column stays in place (deprecated, mirrored on write by
--     updateCompose) so a rollback to v0.30.8-community.51, which still selects pullImagesOnDeploy, keeps working.
--   * Logs-and-metrics telemetry: enum TelemetryProviderType, table telemetryProvider, server and
--     webServerSettings telemetryProviderIds, webServerSettings.vectorAgentOrganizationId and their FKs.
--   * backup.customName (upstream 0198, custom backup file names).
--   * webServerSettings.whitelabelingConfig default gains upstream's new whitelabel keys (default only).
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'compose' AND column_name = 'pullImages'
	) THEN
		ALTER TABLE "compose" ADD COLUMN "pullImages" boolean DEFAULT false NOT NULL;
		IF EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'compose' AND column_name = 'pullImagesOnDeploy'
		) THEN
			UPDATE "compose" SET "pullImages" = "pullImagesOnDeploy";
		END IF;
	END IF;
EXCEPTION WHEN duplicate_column THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."TelemetryProviderType" AS ENUM('loki', 'datadog', 'betterstack', 'elasticsearch', 'splunk_hec', 'aws_cloudwatch', 'prometheus_remote_write', 'new_relic', 'influxdb');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telemetryProvider" (
	"telemetryProviderId" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"providerType" "TelemetryProviderType" NOT NULL,
	"signals" text[] NOT NULL,
	"endpoint" text,
	"apiKey" text,
	"apiSecret" text,
	"extraConfig" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" text NOT NULL,
	"organizationId" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webServerSettings" ALTER COLUMN "whitelabelingConfig" SET DEFAULT '{"appName":null,"appDescription":null,"logoUrl":null,"faviconUrl":null,"customCss":null,"loginLogoUrl":null,"supportUrl":null,"docsUrl":null,"errorPageTitle":null,"errorPageDescription":null,"footerText":null,"ogImageUrl":null,"passwordResetGuide":null,"supportEmail":null,"logoLightUrl":null,"loginLogoLightUrl":null,"faviconLightUrl":null,"dualModeBranding":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "backup" ADD COLUMN IF NOT EXISTS "customName" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN IF NOT EXISTS "telemetryProviderIds" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "telemetryProviderIds" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "webServerSettings" ADD COLUMN IF NOT EXISTS "vectorAgentOrganizationId" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "telemetryProvider" ADD CONSTRAINT "telemetryProvider_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webServerSettings" ADD CONSTRAINT "webServerSettings_vectorAgentOrganizationId_organization_id_fk" FOREIGN KEY ("vectorAgentOrganizationId") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
