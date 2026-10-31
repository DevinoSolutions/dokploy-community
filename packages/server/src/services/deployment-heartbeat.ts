import { appendFile } from "node:fs/promises";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
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
 * modification time). The marks end with the step, and the wall limit
 * (`maxMinutes`, 90 by default) still bounds the step itself.
 *
 * What is marked, and so no longer found by the idle limit while it runs:
 * - Compose, built on a build server: the image build and the image push, and
 *   the release step (pull, `up`, rolling drain) on the serving host. The
 *   fetch of the source and the other short steps are not marked.
 * - Compose built on the serving host: the release step only (pull, `up` with
 *   its build, rolling drain). The fetch is its own step and is not marked.
 *   A rebuild has no fetch: its release command is marked as a whole.
 * - Application (deploy, rebuild, previews): only what follows the line
 *   `BUILD_START_MARKER`, which the script logs when the build starts, so it
 *   is the build and the push to the registry, if any. The marks start once
 *   Dokploy has seen that line in the log, at most one interval after it. The
 *   clone, the patches and the pull of a docker-source image come before it
 *   in the same script and stay under the idle limit, so a clone or pull that
 *   hangs is still failed after about `idleMinutes`, not after the wall limit.
 *   The required-checks wait of the build policy runs in Dokploy, not in the
 *   script, and is not marked either.
 *
 * What a mark proves: that Dokploy is still waiting for the step, and that it
 * could append to the log on the host that holds it. On a build-server compose
 * the step runs over one SSH connection to the build server and the mark goes
 * over another one to the serving host, so the mark says nothing about the
 * build server connection. A step whose connection died is caught by the SSH
 * keepalive (execAsync.ts, `SSH_KEEPALIVE`: a ping every 10 s, dropped after 3
 * misses), which fails the step; it is not the mark that detects it.
 *
 * A mark is not written once the deployment is no longer `running` (for
 * example after the watchdog failed it), and the step's end waits a few
 * seconds for a mark that is being written, so none lands after the closing
 * lines of the step.
 */

/**
 * Well under the smallest idle limit the watchdog accepts (15 min), so several
 * marks fit into any idle window and one lost write changes nothing.
 */
export const DEPLOY_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** A step that outlives this stops marking: its job is long past any limit. */
export const DEPLOY_HEARTBEAT_MAX_MS = 24 * 60 * 60_000;
/** How long the end of a step waits for a mark that is being written. */
export const DEPLOY_HEARTBEAT_SETTLE_MS = 5_000;

/**
 * The line an application's deploy script logs where its build starts: the
 * marks of an application begin once this line is in the log.
 */
export const BUILD_START_MARKER = "--- Dokploy: the build starts here ---";
/** The shell command that logs `BUILD_START_MARKER`. */
export const getBuildStartCommand = () =>
	`echo ${quote([BUILD_START_MARKER])};`;

export const getDeployHeartbeatLine = (label: string, elapsedMs: number) =>
	`⏳ ${label} is still running (${Math.max(1, Math.round(elapsedMs / 60_000))} min so far, no output yet)`;

export interface DeployHeartbeatOptions {
	/** What is running, as the log line names it. */
	label: string;
	/** Writes one line to the deployment log. Failures are swallowed. */
	write: (line: string) => void | Promise<void>;
	/**
	 * Holds the marks back until this is true, checked once per interval. For a
	 * command whose first part must keep the idle limit: the script logs a line
	 * where the part to mark starts. A check that fails counts as "not yet".
	 */
	ready?: () => boolean | Promise<boolean>;
	/**
	 * Checked before each mark: once it is false the marks stop for good (the
	 * deployment was failed or cancelled meanwhile). A check that fails counts as
	 * "still running".
	 */
	isActive?: () => boolean | Promise<boolean>;
	intervalMs?: number;
	maxMs?: number;
	/** How long the end of the step waits for a mark that is being written. */
	settleMs?: number;
	now?: () => number;
}

/** Resolves when `pending` settles, or after `ms`, whichever comes first. */
const settleWithin = async (pending: Promise<unknown>, ms: number) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		pending,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
			timer.unref?.();
		}),
	]);
	clearTimeout(timer);
};

const attempt = async (
	check: () => boolean | Promise<boolean>,
	orElse: boolean,
) => {
	try {
		return await check();
	} catch (error) {
		console.error(
			"Could not check the state of a deployment for its progress mark",
			error instanceof Error ? error.message : error,
		);
		return orElse;
	}
};

/**
 * Runs `work`; until it settles, writes a progress line every `intervalMs`.
 * Never changes the outcome of `work`: a failed write is only reported to the
 * server log, writes never overlap, and the timer never keeps the process
 * alive. When `work` ends, a mark that is being written is awaited (for at most
 * `settleMs`), so no mark follows the lines the caller writes next.
 */
export const withDeployHeartbeat = async <T>(
	work: () => Promise<T>,
	{
		label,
		write,
		ready,
		isActive,
		intervalMs = DEPLOY_HEARTBEAT_INTERVAL_MS,
		maxMs = DEPLOY_HEARTBEAT_MAX_MS,
		settleMs = DEPLOY_HEARTBEAT_SETTLE_MS,
		now = Date.now,
	}: DeployHeartbeatOptions,
): Promise<T> => {
	const startedAt = now();
	// When the marks count from: the start of the step, or, for a step that is
	// only marked from a point on, the interval that saw that point.
	let markedFrom: number | null = ready ? null : startedAt;
	let stopped = false;
	let inFlight: Promise<void> | null = null;

	const mark = async (tickAt: number) => {
		if (markedFrom === null) {
			if (!ready || !(await attempt(ready, false)) || stopped) return;
			// The line that proved the start is at most one interval old: the first
			// mark follows one interval later.
			markedFrom = tickAt;
			return;
		}
		if (isActive && !(await attempt(isActive, true))) {
			stopped = true;
			clearInterval(timer);
			return;
		}
		if (stopped) return;
		await write(getDeployHeartbeatLine(label, tickAt - markedFrom));
	};

	const timer = setInterval(() => {
		const tickAt = now();
		if (stopped || inFlight) return;
		if (tickAt - startedAt > maxMs) {
			clearInterval(timer);
			return;
		}
		inFlight = Promise.resolve()
			.then(() => mark(tickAt))
			.catch((error) =>
				console.error(
					"Could not write a progress mark to the deployment log",
					error instanceof Error ? error.message : error,
				),
			)
			.finally(() => {
				inFlight = null;
			});
	}, intervalMs);
	timer.unref?.();
	try {
		return await work();
	} finally {
		stopped = true;
		clearInterval(timer);
		const pending = inFlight;
		if (pending) await settleWithin(pending, settleMs);
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
		const encoded = Buffer.from(
			`${line}
`,
			"utf8",
		).toString("base64");
		await execAsyncRemote(
			serverId,
			`echo "${encoded}" | base64 -d >> ${quote([logPath])}`,
		);
		return;
	}
	await appendFile(
		logPath,
		`${line}
`,
	);
};

/** True when the deployment log, on its host, holds `text` on some line. */
export const deployLogHasLine = async (
	{ serverId, logPath }: DeployLogTarget,
	text: string,
): Promise<boolean> => {
	if (!logPath || logPath === ".") return false;
	// `grep -c` prints 0 and exits 1 when nothing matches; a log that cannot be
	// read prints nothing. Both mean "not there yet".
	const command = `grep -cF -- ${quote([text])} ${quote([logPath])} || true`;
	const { stdout } = serverId
		? await execAsyncRemote(serverId, command)
		: await execAsync(command);
	return Number.parseInt(String(stdout ?? "").trim(), 10) > 0;
};

export interface DeployLogHeartbeatOptions {
	/**
	 * Marks only once the log holds this line (`BUILD_START_MARKER` for an
	 * application), so the commands that come before it in the same script stay
	 * under the idle limit.
	 */
	startsAfterLogLine?: string;
	/** False once the deployment is no longer running: the marks stop then. */
	isRunning?: () => boolean | Promise<boolean>;
}

/** `withDeployHeartbeat` for a step whose output goes to a deployment log. */
export const withDeployLogHeartbeat = <T>(
	target: DeployLogTarget,
	label: string,
	work: () => Promise<T>,
	{ startsAfterLogLine, isRunning }: DeployLogHeartbeatOptions = {},
): Promise<T> =>
	withDeployHeartbeat(work, {
		label,
		write: (line) => appendDeployLogLine(target, line),
		ready: startsAfterLogLine
			? () => deployLogHasLine(target, startsAfterLogLine)
			: undefined,
		isActive: isRunning,
	});
