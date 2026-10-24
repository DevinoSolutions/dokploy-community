import type { WatchdogDeployment } from "@dokploy/server/services/deployment-watchdog";
import type { StopResult } from "@/server/queues/deployment-stop";
import type { InMemoryJob } from "@/server/queues/in-memory-queue";

/**
 * Cancelling a deployment that is RUNNING, on a self-hosted instance (Cloud
 * hands the cancel to its jobs service instead). The same stop as "Kill build"
 * and the stuck-deployment watchdog, so the deploy flow's own cancel handling
 * runs: a rolling replace removes the replica it had not promoted, a compose
 * restores its previous release, the job ends and frees its queue slot.
 *
 * The slot is never freed by force here: right after a stop the flow may still
 * be restoring the previous release, and a second deploy of the service must
 * not start on top of that. A job that is hung for real is released by the
 * watchdog (deployment-watchdog.ts), which waits for the restore to be over.
 */

export type ServiceRef =
	| { type: "application"; applicationId: string }
	| { type: "compose"; composeId: string };

export interface CancelActiveDeps {
	listRunning: () => Promise<WatchdogDeployment[]>;
	activeJobs: () => Promise<InMemoryJob[]>;
	stop: (row: WatchdogDeployment) => Promise<StopResult>;
	/** Host holding the log: null is the Dokploy host, undefined is unknown. */
	logHost: (row: WatchdogDeployment) => Promise<string | null | undefined>;
	appendLog: (
		host: string | null,
		logPath: string,
		line: string,
	) => Promise<void>;
	sleep?: (ms: number) => Promise<void>;
	/** How long to wait for the job to leave the queue after the stop. */
	waitMs?: number;
}

export type CancelActiveResult =
	/** No deployment of the service is running and no job is active. */
	| { status: "nothing-running" }
	/** A job is active but has not created its deployment yet. */
	| { status: "starting" }
	/** Nothing could be signalled; `warnings` says why. */
	| { status: "not-stopped"; warnings: string[] }
	| {
			status: "cancelled";
			deploymentIds: string[];
			/** The job had left the queue (its slot is free) when this returned. */
			slotFree: boolean;
			warnings: string[];
	  };

const POLL_MS = 500;
const DEFAULT_WAIT_MS = 30_000;

const isJobOf = (job: InMemoryJob, service: ServiceRef) => {
	const { data } = job;
	if ("previewDeploymentId" in data) return false;
	return service.type === "compose"
		? "composeId" in data && data.composeId === service.composeId
		: "applicationId" in data && data.applicationId === service.applicationId;
};

export const cancelActiveServiceDeployment = async (
	service: ServiceRef,
	deps: CancelActiveDeps,
): Promise<CancelActiveResult> => {
	const rows = (await deps.listRunning()).filter((row) =>
		service.type === "compose"
			? row.composeId === service.composeId
			: row.applicationId === service.applicationId,
	);
	const jobs = (await deps.activeJobs()).filter((job) => isJobOf(job, service));
	if (rows.length === 0) {
		return { status: jobs.length > 0 ? "starting" : "nothing-running" };
	}

	const deploymentIds: string[] = [];
	const warnings: string[] = [];
	for (const row of rows) {
		const stop = await deps.stop(row);
		if (stop.warning) warnings.push(stop.warning);
		if (stop.notRunning) continue;
		if (stop.method === "none" && !stop.claimedCancelled) continue;
		deploymentIds.push(row.deploymentId);
		// The launcher writes its own line; a plain signal leaves none.
		if (stop.method !== "launcher") {
			const found = await deps.logHost(row);
			const host =
				found === undefined ? row.buildServerId || row.serverId : found;
			await deps.appendLog(
				host,
				row.logPath,
				"⛔ Deployment cancelled by user. Stopping the build...",
			);
		}
	}
	if (deploymentIds.length === 0) {
		// Every row ended on its own meanwhile, or nothing could be signalled.
		return warnings.length > 0
			? { status: "not-stopped", warnings }
			: { status: "nothing-running" };
	}

	// Give the job a moment to end by itself, so the answer can say whether the
	// slot is already free.
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
	const ids = new Set(jobs.map((job) => job.id));
	let slotFree = ids.size === 0;
	for (let waited = 0; !slotFree && waited < waitMs; waited += POLL_MS) {
		await sleep(POLL_MS);
		const stillActive = await deps.activeJobs();
		slotFree = !stillActive.some((job) => ids.has(job.id));
	}
	return { status: "cancelled", deploymentIds, slotFree, warnings };
};
