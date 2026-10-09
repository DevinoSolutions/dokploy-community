-- Image template for previews of a Docker-image application (nullable, no default).
-- Guarded so a re-run after an upstream-to-fork switch is a no-op.
ALTER TABLE "application" ADD COLUMN IF NOT EXISTS "previewDockerImage" text;
