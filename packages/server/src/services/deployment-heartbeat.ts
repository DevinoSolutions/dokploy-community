import { appendFile } from "node:fs/promises";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { quote } from "shell-quote";

/**
 * Progress marks for the long steps of a deploy (T-11843).
 *
 * The stuck-deployment watchdog fails a deploy whose log has had no output for
 * `idleMinutes` (20 by default). Some steps of a healthy deploy print nothing
 * for longer than that: a `docker push` of one large layer to a slow registry,
 * a `docker pull` of it on the serving host, a build step that is quiet. They
 * run as one command whose output goes straight into the log, so while they
 * run the log file does not change, and the watchdog cannot tell them from a
 * hung deploy.
 *
 * While such a step runs, Dokploy itself writes one line to the deployment log
 * every few minutes. That is the proof the watchdog reads (the log's
 * modification time): the step is still running and its connection is alive.
 * It ends with the step, so a deploy that is stuck in any other place (a hung
 * clone, a job that never starts the next step) is still found by the idle
 * limit, and the wall limit still bounds the step itself.
 */

/**
 * Well under the smallest idle limit the watchdog accepts (15 min), so several
 * marks fit into any idle window and one lost write changes nothing.
 */
export const DEPLOY_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** A step that outlives this stops marking: its job is long past any limit. */
export const DEPLOY_HEARTBEAT_MAX_MS = 24 * 60 * 60_000;

export const getDeployHeartbeatLine = (label: string, elapsedMs: number) =>
	`⏳ ${label} is still running (${Math.max(1, Math.round(elapsedMs / 60_000))} min so far, no output yet)`;

export interface DeployHeartbeatOptions {
	/** What is running, as the log line names it. */
	label: string;
	/** Writes one line to the deployment log. Failures are swallowed. */
	write: (line: string) => void | Promise<void>;
	intervalMs?: number;
	maxMs?: number;
	now?: () => number;
}

/**
 * Runs `work`; until it settles, writes a progress line every `intervalMs`.
 * Never changes the outcome of `work`: a failed write is only reported to the
 * server log, writes never overlap, and the timer never keeps the process
 * alive.
 */
export const withDeployHeartbeat = async <T>(
	work: () => Promise<T>,
	{
		label,
		write,
		intervalMs = DEPLOY_HEARTBEAT_INTERVAL_MS,
		maxMs = DEPLOY_HEARTBEAT_MAX_MS,
		now = Date.now,
	}: DeployHeartbeatOptions,
): Promise<T> => {
	const startedAt = now();
	let writing = false;
	let stopped = false;
	const timer = setInterval(() => {
		const elapsed = now() - startedAt;
		if (stopped || writing) return;
		if (elapsed > maxMs) {
			clearInterval(timer);
			return;
		}
		writing = true;
		Promise.resolve()
			.then(() => write(getDeployHeartbeatLine(label, elapsed)))
			.catch((error) =>
				console.error(
					"Could not write a progress mark to the deployment log",
					error instanceof Error ? error.message : error,
				),
			)
			.finally(() => {
				writing = false;
			});
	}, intervalMs);
	timer.unref?.();
	try {
		return await work();
	} finally {
		stopped = true;
		clearInterval(timer);
	}
};

/** Where a deployment's log lives: a server id, or null for the Dokploy host. */
export interface DeployLogTarget {
	serverId: string | null | undefined;
	logPath: string;
}

/** Appends one line to a deployment log on its host. Throws on failure. */
export const appendDeployLogLine = async (
	{ serverId, logPath }: DeployLogTarget,
	line: string,
) => {
	if (!logPath || logPath === ".") return;
	if (serverId) {
		const encoded = Buffer.from(`${line}\n`, "utf8").toString("base64");
		await execAsyncRemote(
			serverId,
			`echo "${encoded}" | base64 -d >> ${quote([logPath])}`,
		);
		return;
	}
	await appendFile(logPath, `${line}\n`);
};

/** `withDeployHeartbeat` for a step whose output goes to a deployment log. */
export const withDeployLogHeartbeat = <T>(
	target: DeployLogTarget,
	label: string,
	work: () => Promise<T>,
): Promise<T> =>
	withDeployHeartbeat(work, {
		label,
		write: (line) => appendDeployLogLine(target, line),
	});
