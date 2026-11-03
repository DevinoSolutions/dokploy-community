-- The default wall limit of the stuck-deployment watchdog is now 180 min (T-12495), so a new settings row
-- starts there. Only the column default changes: no stored value is touched, an instance that kept 90 keeps it.
-- SET DEFAULT can be run again with the same result.
ALTER TABLE "webServerSettings" ALTER COLUMN "deploymentWatchdogMaxMinutes" SET DEFAULT 180;