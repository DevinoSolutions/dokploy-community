-- The commit a build-server compose deploy checked out on its serving host (T-7960). A rebuild
-- refuses unless the code on disk is still that commit. Nullable, no default; guarded so a re-run is a no-op.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "pinnedCommit" text;
