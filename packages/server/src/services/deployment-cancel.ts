import { appendFile } from "node:fs/promises";
import { db } from "@dokploy/server/db";
import { applications, compose, deployments } from "@dokploy/server/db/schema";
import {
	getKillRemoteBuildCommand,
	getReleaseCancelKey,
	getReleaseCancelTarget,
	getRemoteBuildCancelTarget,
	parseKillResult,
	RELEASE_KILL_GRACE_SECONDS,
	type RemoteBuildKillResult,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import {
	execAsync,
	execAsyncCancelable,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import {
	abortRemoteBuild,
	hasRunningRemoteBuild,
} from "@dokploy/server/utils/process/remote-build-registry";
import { and, eq, ne } from "drizzle-orm";

/**
 * Cancelling a deployment whose build runs on a build server.
 *
 * `docker build` / `docker compose` there run in their own session with a pid
 * file (see `utils/builders/remote-build-cancel.ts`), so a cancel signals that
 * one deployment's process group and nothing else. The deployment row is the
 * source of truth for "this was cancelled": the cancel flips it from `running`
 * to `cancelled` before it kills anything, and every step of the deploy flow
 * checks it, so a cancel that lands between two steps (for example between the
 * image push and the serving host's pull) still stops the deploy.
 */

/**
 * Thrown by a deploy flow whose deployment was cancelled. Recognised by a
 * property rather than `instanceof`, because the app can load this module
 * twice (see `utils/process/remote-build-registry.ts`).
 */
export class DeploymentCancelledError extends Error {
	readonly deploymentCancelled = true;
	/**
	 * The status the deploy flow put the service in when it settled the cancel.
	 * The deployment queue only moves the service on from there if it is still
	 * in that status (a Stop or Start clicked meanwhile must not be undone).
	 */
	readonly settledStatus?: string;
	/**
	 * True when the cancel stopped the release step on the serving host (the
	 * rolling replace), not a build: unlike a build, the release may already
	 * have replaced some services.
	 */
	readonly duringRelease: boolean;

	constructor(
		message = "Deployment cancelled.",
		options: { settledStatus?: string; duringRelease?: boolean } = {},
	) {
		super(message);
		this.name = "DeploymentCancelledError";
		this.settledStatus = options.settledStatus;
		this.duringRelease = options.duringRelease === true;
	}
}

export const isDeploymentCancelledError = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	(error as { deploymentCancelled?: unknown }).deploymentCancelled === true;

/**
 * What an error from a cancelable build step means. Cancelling kills the build
 * (or drops its connection), which surfaces as an ordinary exec error; once the
 * deployment row says `cancelled`, that error IS the cancellation. Anything
 * else is returned untouched, so a deploy only takes the cancelled path for a
 * `DeploymentCancelledError`, never for a genuine failure that merely happened
 * after a cancel (see `settleCancelled*Deploy`).
 */
export const toCancelledErrorIfCancelled = async (
	deploymentId: string | undefined,
	error: unknown,
): Promise<unknown> => {
	if (isDeploymentCancelledError(error)) return error;
	if (await isDeploymentCancelled(deploymentId)) {
		return new DeploymentCancelledError(
			"Deployment cancelled: the build was stopped.",
		);
	}
	return error;
};

/**
 * True once the deployment has been marked cancelled. A failed lookup counts
 * as "not cancelled": the check runs inside the deploy flow (including its
 * failure path), where it must never replace the real error or fail a deploy
 * that nobody cancelled.
 */
export const isDeploymentCancelled = async (
	deploymentId: string | undefined,
): Promise<boolean> => {
	if (!deploymentId) return false;
	try {
		const row = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, deploymentId),
			columns: { status: true },
		});
		return row?.status === "cancelled";
	} catch (error) {
		console.warn(
			`Could not read the cancel flag of deployment ${deploymentId}:`,
			error instanceof Error ? error.message : error,
		);
		return false;
	}
};

/**
 * Records a finished deployment as `done` without overwriting a cancel that
 * landed while the serving host was pulling and starting the release (that part
 * cannot be interrupted). Returns false when the deployment is cancelled, so
 * the caller can say so instead of reporting a success. Only build-server
 * deployments can be cancelled; every other one keeps using
 * `updateDeploymentStatus` unchanged.
 */
export const markDeploymentDoneUnlessCancelled = async (
	deploymentId: string,
): Promise<boolean> => {
	const updated = await db
		.update(deployments)
		.set({ status: "done", finishedAt: new Date().toISOString() })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				ne(deployments.status, "cancelled"),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return updated.length > 0;
};

/** What the log says when a cancel arrived too late to stop the release. */
export const CANCELLED_TOO_LATE_NOTE =
	"Deployment cancelled ⛔ The cancel arrived while the release was being started, which cannot be interrupted: the new release is running.";

/**
 * What the log says when the release failed after a cancel was requested but
 * did not end it as cancelled: the deployment ends as `error` (it did fail),
 * not `cancelled`. Neutral on why, since a cancel that landed in time can still
 * be followed by a failed restore of the previous release.
 */
export const CANCELLED_THEN_FAILED_NOTE =
	"A cancel was requested earlier, and the deployment then failed.";

/**
 * The status a service returns to after a cancelled deploy. Nothing from the
 * cancelled build was pulled or started, so a service that has deployed before
 * is still serving its last release ("done"); one that never has stays "idle".
 * This is the fallback: the deployment queue, which knows the status the
 * service had when the job started, puts that exact status back afterwards.
 */
export const statusAfterCancelledDeploy = async (
	service: { applicationId: string } | { composeId: string },
): Promise<"done" | "idle"> => {
	const owner =
		"applicationId" in service
			? eq(deployments.applicationId, service.applicationId)
			: eq(deployments.composeId, service.composeId);
	const previous = await db.query.deployments.findFirst({
		where: and(owner, eq(deployments.status, "done")),
		columns: { deploymentId: true },
	});
	return previous ? "done" : "idle";
};

type StatusOwner = { applicationId: string } | { composeId: string };

/**
 * Just the status column of an application or compose, for the deployment
 * queue to remember what the service was before a job flipped it to "running".
 * One narrow select instead of loading the whole service with its relations.
 */
export const readServiceStatus = async (
	service: StatusOwner,
): Promise<string | undefined> => {
	if ("applicationId" in service) {
		const row = await db.query.applications.findFirst({
			where: eq(applications.applicationId, service.applicationId),
			columns: { applicationStatus: true },
		});
		return row?.applicationStatus;
	}
	const row = await db.query.compose.findFirst({
		where: eq(compose.composeId, service.composeId),
		columns: { composeStatus: true },
	});
	return row?.composeStatus;
};

/**
 * Moves a service from the status a cancelled deploy settled it in to the one
 * it had before the job, only if it is still in the settled status: a Stop or
 * Start clicked in between is the user's latest word and stays. Returns whether
 * the status was changed.
 */
export const restoreServiceStatusIfUnchanged = async (
	service: StatusOwner,
	from: "idle" | "done" | "running" | "error",
	to: "idle" | "done" | "error",
): Promise<boolean> => {
	if (from === to) return false;
	if ("applicationId" in service) {
		const updated = await db
			.update(applications)
			.set({ applicationStatus: to })
			.where(
				and(
					eq(applications.applicationId, service.applicationId),
					eq(applications.applicationStatus, from),
				),
			)
			.returning({ applicationId: applications.applicationId });
		return updated.length > 0;
	}
	const updated = await db
		.update(compose)
		.set({ composeStatus: to })
		.where(
			and(
				eq(compose.composeId, service.composeId),
				eq(compose.composeStatus, from),
			),
		)
		.returning({ composeId: compose.composeId });
	return updated.length > 0;
};

/** Throws `DeploymentCancelledError` when the deployment was cancelled. */
export const assertDeploymentNotCancelled = async (
	deploymentId: string | undefined,
) => {
	if (await isDeploymentCancelled(deploymentId)) {
		throw new DeploymentCancelledError(
			"Deployment cancelled: nothing more will be built, pushed or deployed.",
		);
	}
};

/**
 * Runs an application's build script on `serverId`. When the build runs on a
 * build server (the deployment recorded one) it is launched cancelable, in its
 * own session with a pid file, so `application.killBuild` can stop exactly this
 * deployment's build there. Any other command is sent exactly as before.
 */
export const runRemoteBuildScript = async (
	serverId: string,
	commandWithLog: string,
	deployment: { deploymentId: string; buildServerId?: string | null },
) => {
	if (!deployment.buildServerId) {
		await execAsyncRemote(serverId, commandWithLog);
		return;
	}
	await assertDeploymentNotCancelled(deployment.deploymentId);
	try {
		await execAsyncRemote(serverId, commandWithLog, undefined, {
			cancelable: getRemoteBuildCancelTarget(deployment.deploymentId),
		});
	} catch (error) {
		// A cancel kills the build (or drops its connection): that failure is the
		// cancellation itself, not a build error.
		throw await toCancelledErrorIfCancelled(deployment.deploymentId, error);
	}
};

/**
 * After the build script ended, a build-server deployment that was cancelled
 * meanwhile (the cancel landed once the build was already done, so there was
 * nothing to kill) must not go on to pull and run the image.
 */
export const assertBuildNotCancelled = async (deployment: {
	deploymentId: string;
	buildServerId?: string | null;
}) => {
	if (deployment.buildServerId) {
		await assertDeploymentNotCancelled(deployment.deploymentId);
	}
};

/**
 * Runs the release script of a build-server compose on its serving host
 * (`serverId`, null: the Dokploy host) as a cancelable command: its own session
 * with a pid file, so a cancel can signal it and its trap can run (the rolling
 * replace removes the replica that was not promoted). Only for scripts that
 * have such a trap; any other release step is sent exactly as before and stays
 * uninterruptible (see `CANCELLED_TOO_LATE_NOTE`).
 *
 * The command registers before the cancel flag is read, so a cancel that lands
 * in between finds it (the kill script retries while it is registered).
 */
export const runReleaseScript = async ({
	serverId,
	command,
	deploymentId,
}: {
	serverId: string | null;
	command: string;
	deploymentId: string;
}) => {
	await assertDeploymentNotCancelled(deploymentId);
	const cancelable = getReleaseCancelTarget(deploymentId, !!serverId);
	const beforeExec = () => assertDeploymentNotCancelled(deploymentId);
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command, undefined, {
				cancelable,
				beforeExec,
			});
		} else {
			await execAsyncCancelable(command, cancelable, { beforeExec });
		}
	} catch (error) {
		if (isDeploymentCancelledError(error)) throw error;
		// Only a failure that looks like the signal landing is the cancellation
		// (and the release may be half done). Any other failure after a cancel
		// is a real one: the signal did not land and the rollout failed or
		// ended on its own, which must still be reported as an error.
		if (
			isCancelSignalFailure(error) &&
			(await isDeploymentCancelled(deploymentId))
		) {
			throw new DeploymentCancelledError(
				"Deployment cancelled: the release step was stopped.",
				{ duringRelease: true },
			);
		}
		throw error;
	}
};

/** Exit statuses of a shell whose command was ended by INT, KILL or TERM. */
const SIGNAL_EXIT_CODES = new Set([130, 137, 143]);

/**
 * True when a release command failed the way a cancel makes it fail: its
 * connection was dropped by `abortRemoteBuild`, or it ended with the exit
 * status of an INT / KILL / TERM (the rolling replace's own trap exits 130).
 */
const isCancelSignalFailure = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false;
	const { exitCode, message } = error as {
		exitCode?: unknown;
		message?: unknown;
	};
	if (typeof exitCode === "number" && SIGNAL_EXIT_CODES.has(exitCode)) {
		return true;
	}
	return (
		typeof message === "string" &&
		/was cancelled: cancelled by user/.test(message)
	);
};

/** Longest a cancel waits for the build server's kill script (SSH included). */
export const KILL_TIMEOUT_MS = 30_000;
/** The pid file is written a moment after the ssh command starts. */
const PID_FILE_RETRY_MS = 1_000;
const PID_FILE_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} did not answer within ${ms / 1000}s`)),
			ms,
		);
	});
	// The loser keeps running; make sure its failure is not unhandled.
	promise.catch(() => {});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Appends a line to a deployment log, wherever it lives. Never throws. */
export const appendLogLine = async (
	logServerId: string | null,
	logPath: string,
	line: string,
) => {
	if (!logPath || logPath === ".") return;
	const text = `\n${line}\n`;
	try {
		if (logServerId) {
			const encoded = Buffer.from(text, "utf8").toString("base64");
			await withTimeout(
				execAsyncRemote(
					logServerId,
					`echo "${encoded}" | base64 -d >> '${logPath.replace(/'/g, `'\\''`)}'`,
				),
				KILL_TIMEOUT_MS,
				"The server holding the deployment log",
			);
		} else {
			await appendFile(logPath, text);
		}
	} catch (error) {
		console.error(
			"Could not write the cancellation to the deployment log",
			error,
		);
	}
};

export interface CancellableDeployment {
	deploymentId: string;
	logPath: string;
	/** Host the deployment log is on (null: this Dokploy host). */
	logServerId: string | null;
	buildServerId: string;
	/**
	 * Compose only: the serving host, where the release step (the rolling
	 * replace) runs once the images are built. A cancel signals it there too
	 * (serverId null: this Dokploy host).
	 */
	releaseHost?: { serverId: string | null };
}

export type CancelOutcome =
	| { status: "not-running" }
	| {
			status: "cancelled";
			result: RemoteBuildKillResult | "UNREACHABLE";
			warning?: string;
	  };

/**
 * Signals the release step of a deployment on its serving host (see
 * `runReleaseScript`): SIGTERM to its process group, which runs the rolling
 * replace's trap, then SIGKILL after the grace. Never throws.
 */
const stopReleaseStep = async (
	releaseHost: { serverId: string | null },
	deploymentId: string,
): Promise<{
	result: RemoteBuildKillResult | "UNREACHABLE";
	warning?: string;
}> => {
	const { serverId } = releaseHost;
	const cancelKey = getReleaseCancelKey(deploymentId);
	const command = getKillRemoteBuildCommand(
		getReleaseCancelTarget(deploymentId, !!serverId),
		RELEASE_KILL_GRACE_SECONDS,
	);
	const where = serverId ? "the serving host" : "the Dokploy host";
	const Where = serverId ? "The serving host" : "The Dokploy host";
	try {
		let result: RemoteBuildKillResult = "NONE";
		for (let attempt = 0; ; attempt++) {
			const { stdout } = await withTimeout(
				serverId ? execAsyncRemote(serverId, command) : execAsync(command),
				KILL_TIMEOUT_MS,
				Where,
			);
			result = parseKillResult(stdout);
			// The release step registers a moment before its pid file exists.
			if (
				result === "NONE" &&
				hasRunningRemoteBuild(cancelKey) &&
				attempt < PID_FILE_RETRIES
			) {
				await sleep(PID_FILE_RETRY_MS);
				continue;
			}
			break;
		}
		if (result === "NONE" && hasRunningRemoteBuild(cancelKey)) {
			return {
				result,
				warning: `The release step of this deployment is running on ${where} but its pid file was not found (not written yet, or the launcher is missing there), so it could not be signalled. The local connection to it is being dropped; the rolling replace may still be running there.`,
			};
		}
		if (result === "FAILED") {
			return {
				result,
				warning: `The release step on ${where} did not stop after SIGKILL; it may still be running.`,
			};
		}
		if (result === "UNVERIFIED") {
			return {
				result,
				warning: `${Where} has no /proc, so the release process could not be identified safely and was not signalled; it may still be running.`,
			};
		}
		return { result };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			result: "UNREACHABLE",
			warning: `Could not reach ${where} to stop the release step (${reason}). The deployment is cancelled here, but a rolling replace may keep running there until it finishes.`,
		};
	}
};

/**
 * Stops one deployment's build on its build server and marks the deployment
 * cancelled. Best effort on the server side: when the build server cannot be
 * reached, the deployment is still cancelled locally (its job ends and frees
 * its queue slot and group lock) and the log says the build may still be
 * running there.
 */
export const cancelBuildServerDeployment = async (
	target: CancellableDeployment,
): Promise<CancelOutcome> => {
	const { deploymentId, logPath, logServerId, buildServerId, releaseHost } =
		target;

	// Claim it first and atomically: only a deployment that is still running
	// can be cancelled, and from here on every deploy step sees the flag.
	const [claimed] = await db
		.update(deployments)
		.set({ status: "cancelled", finishedAt: new Date().toISOString() })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "running"),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	if (!claimed) return { status: "not-running" };

	await appendLogLine(
		logServerId,
		logPath,
		"⛔ Deployment cancelled by user. Stopping the build on the build server...",
	);

	let result: RemoteBuildKillResult | "UNREACHABLE" = "UNREACHABLE";
	let warning: string | undefined;
	try {
		const command = getKillRemoteBuildCommand(
			getRemoteBuildCancelTarget(deploymentId),
		);
		for (let attempt = 0; ; attempt++) {
			const { stdout } = await withTimeout(
				execAsyncRemote(buildServerId, command),
				KILL_TIMEOUT_MS,
				"The build server",
			);
			result = parseKillResult(stdout);
			// No pid file while a build step is starting in this process: it will
			// appear in a moment, so look again before giving up.
			if (
				result === "NONE" &&
				hasRunningRemoteBuild(deploymentId) &&
				attempt < PID_FILE_RETRIES
			) {
				await sleep(PID_FILE_RETRY_MS);
				continue;
			}
			break;
		}
		if (result === "NONE" && hasRunningRemoteBuild(deploymentId)) {
			// A command of this deployment is still running here but left no pid
			// file after the retries: the launcher is missing on that server or
			// the file could not be written. That is not "finished".
			warning =
				"A build command of this deployment is running on the build server but its pid file was not found (not written yet, or the launcher is missing there), so it could not be signalled. The local connection to it is being dropped; the build may still be running on the build server.";
		} else if (result === "FAILED") {
			warning =
				"The build process on the build server did not stop after SIGKILL; it may still be running.";
		} else if (result === "UNVERIFIED") {
			warning =
				"The build server has no /proc, so the build process could not be identified safely and was not signalled; it may still be running.";
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		warning = `Could not reach the build server to stop the build (${reason}). The deployment is cancelled here, but the build may keep running on the build server until it finishes.`;
	}

	// The images are built and this process is waiting on the release script
	// (the rolling replace) on the serving host: the build server had nothing
	// to kill, signal the host that is running it. Skipped when a build was
	// just killed, and when no release step is running (no extra ssh call).
	let releaseStopped = false;
	if (
		releaseHost &&
		result !== "KILLED" &&
		hasRunningRemoteBuild(getReleaseCancelKey(deploymentId))
	) {
		const release = await stopReleaseStep(releaseHost, deploymentId);
		releaseStopped = release.result === "KILLED";
		if (release.warning) {
			warning = warning ? `${warning} ${release.warning}` : release.warning;
		}
	}

	// Release the job even if the build server never answers: drop the local
	// connection waiting on it. A no-op when the command already ended.
	abortRemoteBuild(deploymentId, "cancelled by user");
	if (releaseHost) {
		abortRemoteBuild(getReleaseCancelKey(deploymentId), "cancelled by user");
	}

	if (warning) {
		console.warn(`Cancelling deployment ${deploymentId}: ${warning}`);
		await appendLogLine(logServerId, logPath, `⚠️ ${warning}`);
		await db
			.update(deployments)
			.set({ errorMessage: warning })
			.where(eq(deployments.deploymentId, deploymentId))
			.catch(() => {});
	} else {
		await appendLogLine(
			logServerId,
			logPath,
			releaseStopped
				? "✅ The release step was stopped on the serving host. A rolling replace removes the replica it had not promoted; services it had already replaced stay on the new release."
				: result === "KILLED"
					? "✅ Build stopped on the build server."
					: "ℹ️ No build was running on the build server (it had not started, or had just finished). Nothing more will be built or deployed.",
		);
	}
	return {
		status: "cancelled",
		result: releaseStopped ? "KILLED" : result,
		warning,
	};
};

/**
 * What `application.killBuild` / `compose.killBuild` need: cancel every running
 * build-server deployment of the service. `usesBuildServer` is true when the
 * service builds on a build server, in which case the caller must not run the
 * generic `pkill` on the serving host (it would hit unrelated deployments).
 */
export const cancelBuildServerDeploymentsForService = async (
	service:
		| { type: "application"; applicationId: string }
		| { type: "compose"; composeId: string },
): Promise<{
	usesBuildServer: boolean;
	cancelled: number;
	warnings: string[];
}> => {
	const warnings: string[] = [];
	let cancelled = 0;

	if (service.type === "application") {
		const running = await db.query.deployments.findMany({
			where: and(
				eq(deployments.applicationId, service.applicationId),
				eq(deployments.status, "running"),
			),
			columns: { deploymentId: true, logPath: true, buildServerId: true },
		});
		const onBuildServer = running.filter((row) => !!row.buildServerId);
		for (const row of onBuildServer) {
			const outcome = await cancelBuildServerDeployment({
				deploymentId: row.deploymentId,
				logPath: row.logPath,
				// The application's log is created on the host that builds.
				logServerId: row.buildServerId,
				buildServerId: row.buildServerId as string,
			});
			if (outcome.status === "cancelled") {
				cancelled++;
				if (outcome.warning) warnings.push(outcome.warning);
			}
		}
		return { usesBuildServer: onBuildServer.length > 0, cancelled, warnings };
	}

	const owner = await db.query.compose.findFirst({
		where: eq(compose.composeId, service.composeId),
		columns: { buildServerId: true, serverId: true },
	});
	if (!owner?.buildServerId) {
		return { usesBuildServer: false, cancelled, warnings };
	}
	const running = await db.query.deployments.findMany({
		where: and(
			eq(deployments.composeId, service.composeId),
			eq(deployments.status, "running"),
		),
		columns: { deploymentId: true, logPath: true },
	});
	for (const row of running) {
		const outcome = await cancelBuildServerDeployment({
			deploymentId: row.deploymentId,
			logPath: row.logPath,
			// A compose's log stays on its serving host.
			logServerId: owner.serverId,
			buildServerId: owner.buildServerId,
			releaseHost: { serverId: owner.serverId },
		});
		if (outcome.status === "cancelled") {
			cancelled++;
			if (outcome.warning) warnings.push(outcome.warning);
		}
	}
	return { usesBuildServer: true, cancelled, warnings };
};

/**
 * `deployment.killProcess` for a deployment that builds on a build server.
 * Returns `null` when the deployment does not (so the caller keeps its
 * existing behaviour), otherwise the outcome.
 */
export const cancelBuildServerDeploymentById = async (
	deploymentId: string,
): Promise<CancelOutcome | null> => {
	const row = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, deploymentId),
		columns: {
			deploymentId: true,
			logPath: true,
			buildServerId: true,
			applicationId: true,
			composeId: true,
		},
	});
	if (!row) return null;

	if (row.applicationId && row.buildServerId) {
		return cancelBuildServerDeployment({
			deploymentId: row.deploymentId,
			logPath: row.logPath,
			logServerId: row.buildServerId,
			buildServerId: row.buildServerId,
		});
	}
	if (row.composeId) {
		const owner = await db.query.compose.findFirst({
			where: eq(compose.composeId, row.composeId),
			columns: { buildServerId: true, serverId: true },
		});
		if (owner?.buildServerId) {
			return cancelBuildServerDeployment({
				deploymentId: row.deploymentId,
				logPath: row.logPath,
				logServerId: owner.serverId,
				buildServerId: owner.buildServerId,
				releaseHost: { serverId: owner.serverId },
			});
		}
	}
	return null;
};
