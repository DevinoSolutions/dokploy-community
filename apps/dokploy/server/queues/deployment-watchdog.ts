import type { RecordDeploymentCancelAuditInput } from "@dokploy/server/services/deployment-cancel-audit";
import type {
	WatchdogDeployment,
	WatchdogMarkOutcome,
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
 * service is excluded. A deploy is only touched when it is the one the active
 * job of its service is running (its row was created after that job started):
 * a stale `running` row of a service whose healthy job runs another deploy is
 * left alone. Silence has to be seen on two consecutive sweeps, and the row
 * status and the log are read again right before anything is stopped. Failing
 * is three steps, in this order:
 *
 * 1. Stop the work, the way "Kill build" / "Kill process" do (deployment-stop.ts).
 *    The deploy flow's own cancel or failure handling then runs: a rolling
 *    replace removes the replica it had not promoted, a compose restores its
 *    previous release. The watchdog does not do any of that itself.
 * 2. Wait for the job to end on its own. If it has not after the grace period
 *    (it is hung in something no signal reaches) the service, if still
 *    `running`, goes to `error`, and then the queue slot is released by force
 *    (never before: the next job starts the moment the slot is free). When
 *    nothing could be stopped the service group lock is kept until the
 *    process really returns, so a second build of it cannot start next to it.
 * 3. Mark the deployment `error` with the watchdog reason, write the closing
 *    line to its log, send the deployment-failed notification and record the
 *    cancel-trail entry, actor "system". When the row ended some other way (it
 *    finished, or a person cancelled it) none of that is claimed.
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
	/**
	 * Free the slot of a running job; false when it is not running.
	 * `keepGroupLock` keeps the service locked until its process returns.
	 */
	releaseJob: (jobId: string, options?: { keepGroupLock?: boolean }) => boolean;
	/** The status of a deployment row right now; null when it is gone. */
	readStatus: (deploymentId: string) => Promise<string | null>;
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
	markFailed: (
		deploymentId: string,
		message: string,
		options: { claimedCancel: boolean },
	) => Promise<WatchdogMarkOutcome>;
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

/** The active jobs of the service (or preview) a deployment belongs to. */
export const jobsOfService = (
	row: DeployRow,
	jobs: InMemoryJob[],
): InMemoryJob[] =>
	jobs.filter((job) => {
		const service = jobServiceOf(job.data);
		if (row.previewDeploymentId) {
			return service.previewDeploymentId === row.previewDeploymentId;
		}
		if (service.previewDeploymentId) return false;
		if (row.composeId) return service.composeId === row.composeId;
		if (row.applicationId) return service.applicationId === row.applicationId;
		return false;
	});

/**
 * The active job that runs this deployment, if the queue has one. A job runs
 * the deployment its start created, so the row has to be created after the job
 * started (one minute of slack for the clocks): an older `running` row of the
 * same service is a leftover and belongs to no job.
 */
export const findJobOf = (
	row: DeployRow & { createdAt?: string },
	jobs: InMemoryJob[],
): InMemoryJob | null =>
	jobsOfService(row, jobs).find((job) => {
		if (job.processedOn === undefined) return true;
		const createdAt = timeOf(row.createdAt);
		return createdAt === null || createdAt >= job.processedOn - MINUTE_MS;
	}) ?? null;

export const createDeploymentWatchdog = (deps: WatchdogDeps) => {
	const releaseGraceMs = deps.releaseGraceMs ?? STOP_RELEASE_GRACE_MS;
	const wedgedAfterMs = deps.wedgedAfterMs ?? WEDGED_AFTER_FINISH_MS;
	const pending = new Map<string, PendingStop>();
	/** Deployments seen silent on the last sweep: id -> when first seen. */
	const suspects = new Map<string, number>();
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
	const finish = async (
		stopped: PendingStop,
		release: { slotReleased: boolean; lockKept: boolean },
	) => {
		const { row, trigger } = stopped;
		const reason = watchdogTriggerLine(trigger);
		const outcome = await deps.markFailed(
			row.deploymentId,
			`${reason}. The deployment was stopped and marked failed by the watchdog.`,
			{ claimedCancel: stopped.stop.claimedCancelled },
		);
		if (outcome === "unchanged") {
			// It finished, or a person cancelled it, while the stop was on its way:
			// no failure to record, claim or announce.
			console.log(
				`Deployment watchdog: ${row.deploymentId} ended another way after it was stopped, nothing recorded`,
			);
			return;
		}
		if (release.slotReleased) {
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
				release.lockKept
					? "Watchdog: nothing could stop the process, so the queue slot was released for other services; this service stays locked (no new deploy of it starts) until the old process ends or Dokploy restarts"
					: "Watchdog: the deployment did not end after it was stopped; its queue slot was released",
			);
		}
		await deps.appendLog(stopped.host, row.logPath, WATCHDOG_FAILED_LINE);
		const context = await deps.loadContext(row);
		if (!context) return;
		const flipped = outcome === "flipped";
		// A deploy flow that failed on its own after the stop already told people.
		if (flipped) {
			await deps.notify(row, stopped.host, context, `${reason}; marked failed`);
		}
		await audit(row, context, {
			reason: trigger.kind,
			thresholdMinutes: trigger.minutes,
			observedMinutes: trigger.observedMinutes,
			stop: stopped.stop.method,
			slotReleased: release.slotReleased,
			groupLockKept: release.lockKept,
			notified: flipped,
			...(stopped.stop.warning ? { warning: stopped.stop.warning } : {}),
		});
	};

	const stopAndTrack = async (
		row: WatchdogDeployment,
		trigger: WatchdogTrigger,
		config: WatchdogConfig,
	) => {
		// The view of the sweep is a few seconds old (a remote probe can take 15):
		// read the row and the log again, right before anything is touched.
		if ((await deps.readStatus(row.deploymentId)) !== "running") return;
		let confirmed = trigger;
		if (trigger.kind === "idle") {
			const startedAt = timeOf(row.startedAt) ?? timeOf(row.createdAt);
			const again = evaluateWatchdog(config, {
				runningMs: startedAt === null ? 0 : deps.now() - startedAt,
				idleMs: await deps.readLogIdleMs(row),
			});
			// The log moved (or can no longer be read): not stuck, as far as we know.
			if (!again) return;
			confirmed = again;
		}
		const jobs = await deps.activeJobs();
		const job = findJobOf(row, jobs);
		// A leftover row of a service whose current job runs another deploy.
		if (!job && jobsOfService(row, jobs).length > 0) return;

		const host = await hostOf(row);
		await deps.appendLog(host, row.logPath, watchdogTriggerLine(confirmed));
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
		const stopped: PendingStop = {
			row,
			trigger: confirmed,
			stop,
			host,
			jobId: job?.id ?? null,
			stoppedAt: deps.now(),
		};
		// Nothing holds a slot (no job in the queue), or the deployment had ended
		// by the time the stop reached it: nothing to wait for.
		if (!job || stop.notRunning) {
			await finish(stopped, { slotReleased: false, lockKept: false });
			return;
		}
		pending.set(row.deploymentId, stopped);
	};

	/** Follow up on a stop issued by an earlier sweep. */
	const settle = async (stopped: PendingStop, jobs: InMemoryJob[]) => {
		const job = jobs.find((candidate) => candidate.id === stopped.jobId);
		if (job && deps.now() - stopped.stoppedAt < releaseGraceMs) return;
		pending.delete(stopped.row.deploymentId);
		// Nothing could be signalled: the process may still be running, so the
		// service stays locked and only the slot (fleet capacity) is freed.
		const keepGroupLock = stopped.stop.method === "none";
		// The row, the log and the service first, the slot last: freeing the slot
		// starts the next job at once, and its service must not be touched after.
		await finish(stopped, {
			slotReleased: Boolean(job),
			lockKept: Boolean(job) && keepGroupLock,
		});
		if (job) deps.releaseJob(job.id, { keepGroupLock });
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
			// A job with no deployment at all never reached a step we could have
			// stopped: keep its service locked. One whose deployment ended is just
			// stuck after the work, and is released completely.
			const keepGroupLock = !mine;
			console.warn(
				`Deployment watchdog: releasing the queue slot of job ${job.id}, hung with no running deployment`,
			);
			await deps.failServiceIfRunning(service).catch(() => {});
			const context = await deps.loadContext(service);
			if (context) {
				await audit(null, context, {
					reason: "hung-job",
					jobId: job.id,
					activeMinutes: Math.floor((deps.now() - startedAt) / MINUTE_MS),
					slotReleased: true,
					groupLockKept: keepGroupLock,
				});
			}
			deps.releaseJob(job.id, { keepGroupLock });
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
		const silent = new Set<string>();
		await Promise.all(
			running.map(async (row) => {
				if (pending.has(row.deploymentId)) return;
				try {
					const service = await deps.resolveService(row);
					if (!service || isWatchdogExcluded(config.exclusions, service)) {
						return;
					}
					// A leftover `running` row of a service whose current job runs
					// another deploy is not this job: leave it, and the job, alone.
					if (!findJobOf(row, jobs) && jobsOfService(row, jobs).length > 0) {
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
					// Silence must be seen on two consecutive sweeps. The wall limit is
					// plain arithmetic on the start time, so once is enough.
					if (trigger.kind === "idle") {
						silent.add(row.deploymentId);
						if (!suspects.has(row.deploymentId)) {
							suspects.set(row.deploymentId, now);
							return;
						}
					}
					suspects.delete(row.deploymentId);
					await stopAndTrack(row, trigger, config);
				} catch (error) {
					console.error(
						`Deployment watchdog: could not check ${row.deploymentId}`,
						errorText(error),
					);
				}
			}),
		);

		// A deployment that is no longer silent (or no longer there) starts over.
		for (const id of [...suspects.keys()]) {
			if (!silent.has(id)) suspects.delete(id);
		}

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
