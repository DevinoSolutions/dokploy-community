-- Live GitHub Actions rows (T-12686). A deployment row can now exist while GitHub still builds the image:
-- the workflow registers it before the build (deployment.registerExternalBuild), a poller follows the run, and the
-- later deploy call takes the same row over. The run's identity and progress live on the row so the lists can show
-- them without calling GitHub: the run id, the repository (owner/name), the commit sha, the run state
-- ('queued' | 'in_progress' | 'completed') and a short label of the step that runs now.
-- externalBuildOnly is true from the registration until a deploy takes the row over (false for every other row, so the
-- default needs no backfill); a partial unique index makes one run of one service one registered row however many
-- calls arrive at once. The index covers registered rows only: the rows deploys write for the same run (a rollback
-- deploy shares its run link) are not in it.
-- deployQueuedAt is set when a deploy call accepted the row (the deploy waits in Dokploy's queue, so the run poller must
-- leave the row alone); deployStartedAt is when the queue job took it over (the watchdog counts from it).
-- The five run columns are nullable, no default, no backfill: rows written before this have none and readers derive what they can from the
-- run link and the title. Guarded so a re-run is a no-op.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildRunId" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildRepository" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildCommitSha" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildRunStatus" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "buildRunStep" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "externalBuildOnly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "deployQueuedAt" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "deployStartedAt" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployment_external_build_run_unique" ON "deployment" (coalesce("applicationId", "composeId"), "buildRunUrl") WHERE "externalBuildOnly" = true;
