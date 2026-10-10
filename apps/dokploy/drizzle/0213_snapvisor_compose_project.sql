-- Compose counterpart of application.snapvisorProjectName: nullable, no default.
-- Guarded so a re-run after an upstream-to-fork switch is a no-op.
ALTER TABLE "compose" ADD COLUMN IF NOT EXISTS "snapvisorProjectName" text;
