-- Who saved a GitHub Deployments watch (T-13796). The poller uses a connection's token for a watch only while the
-- connection is shared with the organization, or this user owns it (or is an owner or admin of the organization), so
-- unsharing a connection stops the watches other members bound to it. Additive and guarded, so a re-run is a no-op.
-- Backfill: a watch on a connection that is NOT shared could only have been bound by the connection's owner, so it
-- takes the owner. Watches on a shared connection stay null (creator unknown): they keep working while the connection
-- is shared and stop, with a message, if it is unshared until the owner saves the watch again. Numbered after 0235: renumber if the order changes.
ALTER TABLE "github_deployment_watch" ADD COLUMN IF NOT EXISTS "createdByUserId" text;--> statement-breakpoint
UPDATE "github_deployment_watch" AS w SET "createdByUserId" = c."createdByUserId" FROM "github_deployment_connection" AS c WHERE c."connectionId" = w."connectionId" AND c."sharedWithOrganization" = false AND c."createdByUserId" IS NOT NULL AND w."createdByUserId" IS NULL;
