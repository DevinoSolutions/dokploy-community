-- Which source a GitHub Actions release was read from (T-13719): the run artifact, or the manifest line in the
-- log of the release job when GitHub blocks artifact uploads (Actions storage quota). Additive only and guarded,
-- so a re-run is a no-op. Numbered after the deploy-gate slot 0230: renumber if the order changes.
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "manifestSource" text DEFAULT 'artifact' NOT NULL;
