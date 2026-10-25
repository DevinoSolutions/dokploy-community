-- What a build-server compose deploy that passed its checks built (T-7960): the commit its serving host
-- checked out, the build server, and a digest of the patch rows it applied. A rebuild refuses unless the
-- code on disk and these still match. Nullable, no default; guarded so a re-run is a no-op.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "pinnedCommit" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "pinnedBuildServerId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "pinnedPatchDigest" text;
