-- A pull release whose image the registry does not serve yet (T-15783): GHCR lags making a freshly pushed manifest
-- readable without a login, so the first pull can be denied. The release stays accepted and the poller starts it again
-- at "retryAt"; "retryAttempt" counts the retries scheduled so far (at most 4). Additive only and guarded, so a re-run
-- is a no-op. "retryGateVersion" is the gate version the release had passed under. Numbered after 0232 (T-13879): renumber if the order changes.
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "retryAt" timestamp;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "retryAttempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gha_release" ADD COLUMN IF NOT EXISTS "retryGateVersion" integer;
