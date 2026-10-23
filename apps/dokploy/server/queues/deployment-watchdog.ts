import type { RecordDeploymentCancelAuditInput } from "@dokploy/server/services/deployment-cancel-audit";
import type {
	WatchdogDeployment,
	WatchdogServiceContext,
	WatchdogServiceRef,
} from "@dokploy/server/services/deployment-watchdog";
import {
	evaluateWatchdog,
	isWatchdogExcluded,
	WATCHDOG_FAILED_LINE,
	type WatchdogConfig,
	type WatchdogTrigger,
	watchdogTriggerLine,
} from "@dokploy/server/utils/deployments/watchdog-config";
import type { StopResult } from "./deployment-stop";
import type { InMemoryJob } from "./in-memory-queue";

/**
 * Stuck-deployment watchdog.
 *
 * Every sweep looks at the deploys that are `running` and fails the ones whose
 * log has been silent for too long, or that have run for too long, unless their
 * service is excluded. Failing is three steps, in this order:
 *
 * 1. Stop the work, the way "Kill build" / "Kill process" do (deployment-stop.ts).
 *    The deploy flow's own cancel or failure handling then runs: a rolling
 *    replace removes the replica it had not promoted, a compose restores its
 *    previous release. The watchdog does not do any of that itself.
 * 2. Wait for the job to end on its own. If it has not after the grace period
 *    (it is hung in something no signal reaches) its queue slot is released by
 *    force, and the service, if still `running`, goes to `error`.
 * 3. Mark the deployment `error` with the watchdog's reason, write the closing
 *    line to its log, send the deployment-failed notification and record the
 *    cancel-trail entry, actor "system".
 *
 * The notification is left to the deploy flow when it fails on its own after
 * the stop (it sends one); the watchdog sends it only when it is the one that
 * changes the row, so one failure is one notification.
 *
 * Besides running deploys, a job can sit `active` with no running deployment:
 * the flow finished (or never created a row) and then hung. Those slots are
 * released too, once the job has been silent for the grace period.
 */

const MINUTE_MS = 60_000;
export const WATCHDOG_INTERVAL_MS = MINUTE_MS;
/** How long a stopped job gets to end by itself before its slot is released. */
export const STOP_RELEASE_GRACE_MS = 10 * MINUTE_MS;
/** A job still active this long after its deployment ended is hung. */
export const WEDGED_AFTER_FINISH_MS = 5 * MINUTE_MS;

type DeployRow = WatchdogServiceRef;

export interface WatchdogDeps {
	now: () => number;
	loadConfig: () => Promise<WatchdogConfig>;
	/** The jobs the queue is running. */
	activeJobs: () => Promise<InMemoryJob[]>;
	/** Free the slot of a running job; false when it is not running. */
	releaseJob: (jobId: string) => boolean;
	listRunning: () => Promise<WatchdogDeployment[]>;
	/** The newest deploy rows of a service, newest first. */
	latestDeploys: (service: {
		applicationId?: string;
		composeId?: string;
		previewDeploymentId?: string;
	}) => Promise<
		Array<{
			status: string | null;
			createdAt: string;
			finishedAt: string | null;
		}>
	>;
	/** The service of a deployment (a preview row names only its preview). */
	resolveService: (row: DeployRow) => Promise<{
		applicationId: string | null;
		composeId: string | null;
	} | null>;
	/** Milliseconds since the log last changed; null when it cannot be told. */
	readLogIdleMs: (row: WatchdogDeployment) => Promise<number | null>;
	/** Host holding the log: null is the Dokploy host, undefined is unknown. */
	logHost: (row: WatchdogDeployment) => Promise<string | null | undefined>;
	appendLog: (
		host: string | null,
		logPath: string,
		line: string,
	) => Promise<void>;
	stop: (row: WatchdogDeployment) => Promise<StopResult>;
	markFailed: (deploymentId: string, message: string) => Promise<boolean>;
	failServiceIfRunning: (row: DeployRow) => Promise<void>;
	loadContext: (row: DeployRow) => Promise<WatchdogServiceContext | null>;
	notify: (
		row: WatchdogDeployment,
		host: string | null,
		context: WatchdogServiceContext,
		fallbackMessage: string,
	) => Promise<void>;
	recordAudit: (input: RecordDeploymentCancelAuditInput) => Promise<void>;
	releaseGraceMs?: number;
	wedgedAfterMs?: number;
}

/** A stop that was issued and is waiting for its job to end. */
interface PendingStop {
	row: WatchdogDeployment;
	trigger: WatchdogTrigger;
	stop: StopResult;
	host: string | null;
	jobId: string | null;
	stoppedAt: number;
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const timeOf = (value: string | null | undefined): number | null => {
	if (!value) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : time;
};

const jobServiceOf = (data: InMemoryJob["data"]) => ({
	applicationId: "applicationId" in data ? data.applicationId : undefined,
	composeId: "composeId" in data ? data.composeId : undefined,
	previewDeploymentId:
		"previewDeploymentId" in data ? data.previewDeploymentId : undefined,
});

/** The active job that runs this deployment, if the queue has one. */
export const findJobOf = (
	row: DeployRow,
	jobs: InMemoryJob[],
): InMemoryJob | null => {
	for (const job of jobs) {
		const service = jobServiceOf(job.data);
		if (row.previewDeploymentId) {
			if (service.previewDeploymentId === row.previewDeploymentId) return job;
		} else if (row.composeId) {
			if (!service.previewDeploymentId && service.composeId === row.composeId) {
				return job;
			}
		} else if (row.applicationId) {
			if (
				!service.previewDeploymentId &&
				service.applicationId === row.applicationId
			) {
				return job;
			}
		}
	}
	return null;
};

export const createDeploymentWatchdog = (deps: WatchdogDeps) => {
	const releaseGraceMs = deps.releaseGraceMs ?? STOP_RELEASE_GRACE_MS;
	const wedgedAfterMs = deps.wedgedAfterMs ?? WEDGED_AFTER_FINISH_MS;
	const pending = new Map<string, PendingStop>();
	let sweeping = false;

	const hostOf = async (row: WatchdogDeployment): Promise<string | null> => {
		const host = await deps.logHost(row);
		return host === undefined ? row.buildServerId || row.serverId : host;
	};

	const audit = async (
		row: WatchdogDeployment | null,
		context: WatchdogServiceContext,
		metadata: Record<string, unknown>,
	) => {
		await deps.recordAudit({
			organizationId: context.organizationId,
			action: "watchdog_fail",
			actor: { type: "system" },
			targetType: row ? "deployment" : context.serviceType,
			targetId: row ? row.deploymentId : context.serviceId,
			targetName: context.appName,
			applicationId:
				context.serviceType === "application" ? context.serviceId : null,
			composeId: context.serviceType === "compose" ? context.serviceId : null,
			deploymentId: row?.deploymentId ?? null,
			metadata,
		});
	};

	/** Last step: the row, the log, the notification and the trail. */
	const finish = async (stopped: PendingStop, released: boolean) => {
		const { row, trigger } = stopped;
		const reason = watchdogTriggerLine(trigger);
		if (released) {
			await deps
				.failServiceIfRunning(row)
				.catch((error) =>
					console.error(
						`Deployment watchdog: could not update the service of ${row.deploymentId}`,
						errorText(error),
					),
				);
			await deps.appendLog(
				stopped.host,
				row.logPath,
				"Watchdog: the deployment did not end after it was stopped; its queue slot was released",
			);
		}
		const flipped = await deps.markFailed(
			row.deploymentId,
			`${reason}. The deployment was stopped and marked failed by the watchdog.`,
		);
		await deps.appendLog(stopped.host, row.logPath, WATCHDOG_FAILED_LINE);
		const context = await deps.loadContext(row);
		if (!context) return;
		// A deploy flow that failed on its own after the stop already told people.
		if (flipped) {
			await deps.notify(row, stopped.host, context, `${reason}; marked failed`);
		}
		await audit(row, context, {
			reason: trigger.kind,
			thresholdMinutes: trigger.minutes,
			observedMinutes: trigger.observedMinutes,
			stop: stopped.stop.method,
			slotReleased: released,
			notified: flipped,
			...(stopped.stop.warning ? { warning: stopped.stop.warning } : {}),
		});
	};

	const stopAndTrack = async (
		row: WatchdogDeployment,
		trigger: WatchdogTrigger,
		jobs: InMemoryJob[],
	) => {
		const host = await hostOf(row);
		await deps.appendLog(host, row.logPath, watchdogTriggerLine(trigger));
		let stop: StopResult;
		try {
			stop = await deps.stop(row);
		} catch (error) {
			stop = {
				method: "none",
				notRunning: false,
				claimedCancelled: false,
				warning: `Could not stop the work: ${errorText(error)}`,
			};
		}
		if (stop.warning) {
			await deps.appendLog(host, row.logPath, `Watchdog: ${stop.warning}`);
		}
		const job = findJobOf(row, jobs);
		const stopped: PendingStop = {
			row,
			trigger,
			stop,
			host,
			jobId: job?.id ?? null,
			stoppedAt: deps.now(),
		};
		// Nothing holds a slot (no job in the queue), or the deployment had ended
		// by the time the stop reached it: nothing to wait for.
		if (!job || stop.notRunning) {
			await finish(stopped, false);
			return;
		}
		pending.set(row.deploymentId, stopped);
	};

	/** Follow up on a stop issued by an earlier sweep. */
	const settle = async (stopped: PendingStop, jobs: InMemoryJob[]) => {
		const job = jobs.find((candidate) => candidate.id === stopped.jobId);
		let released = false;
		if (job) {
			if (deps.now() - stopped.stoppedAt < releaseGraceMs) return;
			released = deps.releaseJob(job.id);
		}
		pending.delete(stopped.row.deploymentId);
		await finish(stopped, released);
	};

	/** An active job with no running deployment that has been hung since. */
	const releaseHungJobs = async (
		jobs: InMemoryJob[],
		running: WatchdogDeployment[],
		config: WatchdogConfig,
	) => {
		const tracked = new Set(
			[...pending.values()].map((stopped) => stopped.jobId),
		);
		for (const job of jobs) {
			if (tracked.has(job.id)) continue;
			if (job.processedOn === undefined) continue;
			const service = jobServiceOf(job.data);
			// Its deployment is running: the deploy checks above own it.
			if (running.some((row) => findJobOf(row, [job]))) continue;
			if (isWatchdogExcluded(config.exclusions, service)) continue;
			const startedAt = job.processedOn;
			const latest = await deps.latestDeploys(service);
			const mine = latest.find(
				(row) => (timeOf(row.createdAt) ?? 0) >= startedAt - MINUTE_MS,
			);
			const endedAt = timeOf(mine?.finishedAt);
			const hung = mine
				? mine.status !== "running" &&
					endedAt !== null &&
					deps.now() - endedAt > wedgedAfterMs
				: deps.now() - startedAt > config.maxMinutes * MINUTE_MS;
			if (!hung) continue;
			if (!deps.releaseJob(job.id)) continue;
			console.warn(
				`Deployment watchdog: released the queue slot of job ${job.id}, hung with no running deployment`,
			);
			await deps.failServiceIfRunning(service).catch(() => {});
			const context = await deps.loadContext(service);
			if (context) {
				await audit(null, context, {
					reason: "hung-job",
					jobId: job.id,
					activeMinutes: Math.floor((deps.now() - startedAt) / MINUTE_MS),
					slotReleased: true,
				});
			}
		}
	};

	const sweepOnce = async () => {
		const config = await deps.loadConfig();
		const jobs = await deps.activeJobs();

		for (const stopped of [...pending.values()]) {
			try {
				await settle(stopped, jobs);
			} catch (error) {
				console.error(
					`Deployment watchdog: could not finish ${stopped.row.deploymentId}`,
					errorText(error),
				);
			}
		}
		if (!config.enabled) return;

		const running = await deps.listRunning();
		const now = deps.now();
		await Promise.all(
			running.map(async (row) => {
				if (pending.has(row.deploymentId)) return;
				try {
					const service = await deps.resolveService(row);
					if (!service || isWatchdogExcluded(config.exclusions, service)) {
						return;
					}
					const startedAt = timeOf(row.startedAt) ?? timeOf(row.createdAt);
					const runningMs = startedAt === null ? 0 : now - startedAt;
					// The wall limit needs no host call; the log is only read when the
					// deployment is not already past it.
					const wallOnly = evaluateWatchdog(config, {
						runningMs,
						idleMs: null,
					});
					const trigger =
						wallOnly ??
						evaluateWatchdog(config, {
							runningMs,
							idleMs: await deps.readLogIdleMs(row),
						});
					if (!trigger) return;
					await stopAndTrack(row, trigger, jobs);
				} catch (error) {
					console.error(
						`Deployment watchdog: could not check ${row.deploymentId}`,
						errorText(error),
					);
				}
			}),
		);

		await releaseHungJobs(jobs, running, config);
	};

	return {
		/** One pass. Never throws; a pass that is still running is not doubled. */
		sweep: async () => {
			if (sweeping) return;
			sweeping = true;
			try {
				await sweepOnce();
			} catch (error) {
				console.error("Deployment watchdog sweep failed", errorText(error));
			} finally {
				sweeping = false;
			}
		},
		/** Stops whose job has not ended yet (for tests and diagnostics). */
		pendingCount: () => pending.size,
	};
};
