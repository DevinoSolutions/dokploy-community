-- GitHub Actions as a service provider (T-13879): a service that follows a repository's GitHub Actions releases has
-- sourceType 'github-actions'. Additive only. IF NOT EXISTS makes a re-run a no-op. Nothing in this migration (or in a
-- later one) uses the new value in the transaction that adds it, which Postgres forbids. Numbered after 0231
-- (T-13719): renumber if the order changes.
ALTER TYPE "public"."sourceType" ADD VALUE IF NOT EXISTS 'github-actions';--> statement-breakpoint
ALTER TYPE "public"."sourceTypeCompose" ADD VALUE IF NOT EXISTS 'github-actions';
