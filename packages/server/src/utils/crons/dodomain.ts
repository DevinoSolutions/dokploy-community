import {
	DODOMAIN_SYNC_FAST_CRON,
	DODOMAIN_SYNC_SLOW_CRON,
	type DoDomainSyncCycleKind,
	runDoDomainSyncCycle,
} from "@dokploy/server/services/dodomain-sync";
import { scheduleJob } from "node-schedule";
import { backgroundJob } from "../process/background";

/**
 * Polls DoDomain for the status of the organization's domains, so a panel that
 * DoDomain cannot reach with webhooks (Tailscale, private network) still learns
 * about verified, broken and expired connections. Self-hosted only: the caller
 * does not register it on cloud, like the other panel-level jobs.
 *
 * A cycle that is still running when the next one is due is skipped instead of
 * stacking up behind a slow DoDomain.
 */
export const initDoDomainSyncCronJobs = () => {
	const running = new Set<DoDomainSyncCycleKind>();
	const schedule = (kind: DoDomainSyncCycleKind, cron: string) =>
		scheduleJob(
			`dodomain-sync-${kind}`,
			cron,
			backgroundJob(`DoDomain ${kind} status sync`, async () => {
				if (running.has(kind)) return;
				running.add(kind);
				try {
					await runDoDomainSyncCycle(kind);
				} finally {
					running.delete(kind);
				}
			}),
		);
	schedule("fast", DODOMAIN_SYNC_FAST_CRON);
	schedule("slow", DODOMAIN_SYNC_SLOW_CRON);
};
