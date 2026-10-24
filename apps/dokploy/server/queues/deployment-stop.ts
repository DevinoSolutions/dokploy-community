import type { CancelOutcome } from "@dokploy/server/services/deployment-cancel";
import type { WatchdogDeployment } from "@dokploy/server/services/deployment-watchdog";

/**
 * Stops the work of ONE running deployment, on the host it runs on. Shared by
 * the stuck-deployment watchdog and the self-hosted per-job cancel, so both
 * stop a build the same way the "Kill build" and "Kill process" actions do and
 * neither invents a kill of its own. The deploy flow's own cancel or failure
 * handling then runs (the rolling replace's trap, the transactional restore of
 * the previous release); nothing here touches the service or the row.
 */

export type StopMethod =
	/** The build or release script the deploy runs under a pid file (build server, rolling replace). */
	| "launcher"
	/** `kill -9 <pid>`, the same as `deployment.killProcess`. */
	| "pid"
	/** `pkill` of the docker build / compose command on the host, as `killBuild` does. */
	| "generic"
	/** Nothing could be signalled. */
	| "none";

export interface StopResult {
	method: StopMethod;
	/** The deployment was no longer `running` when the stop reached it. */
	notRunning: boolean;
	/** The deployment row was set to `cancelled` by the stop (launcher only). */
	claimedCancelled: boolean;
	/** A note for the log: what could not be stopped, and why. */
	warning?: string;
	/**
	 * Nothing was signalled only because other deploys run on the host (the
	 * generic stop would hit them): trying again later, once they ended, can work.
	 */
	retryable?: boolean;
}

export interface StopOptions {
	/**
	 * Use only the handles that are checked against the deployment itself (the
	 * pid-file launcher, which verifies the pid and its start time). Never a
	 * recorded pid (it may have been reused by another process) and never the
	 * host-wide command-name stop. For a deployment that no queue job runs: its
	 * process, if any, is not known to be ours.
	 */
	launcherOnly?: boolean;
}

export interface StopDeps {
	/** `cancelBuildServerDeploymentById` of the server package. */
	cancelWithLauncher: (deploymentId: string) => Promise<CancelOutcome | null>;
	/** How many other deploys (of any kind) run on the same host. */
	countOtherRunning: (
		row: Pick<WatchdogDeployment, "deploymentId" | "serverId">,
	) => Promise<number>;
	/** `kill -9 <pid>` on the host (null: the Dokploy host). */
	killPid: (serverId: string | null, pid: string) => Promise<void>;
	/**
	 * The kind of service a deployment belongs to. A preview row names only its
	 * preview, so its service is looked up.
	 */
	resolveKind: (
		row: Pick<WatchdogDeployment, "previewDeploymentId">,
	) => Promise<"application" | "compose">;
	/** `killDockerBuild` of the queue module. */
	killDockerBuild: (
		kind: "application" | "compose",
		serverId: string | null,
	) => Promise<void>;
}

// `pid` is a free text column and ends up in a shell command: only a plain
// decimal pid >= 2 is accepted (`kill -9 0` signals our own process group and
// `kill -9 1` signals init). The same rule as deployment.killProcess.
const VALID_PID = /^(?:[2-9]|[1-9]\d+)$/;

export const stopDeploymentWork = async (
	row: Pick<
		WatchdogDeployment,
		| "deploymentId"
		| "pid"
		| "serverId"
		| "buildServerId"
		| "composeId"
		| "applicationId"
		| "previewDeploymentId"
	>,
	deps: StopDeps,
	options: StopOptions = {},
): Promise<StopResult> => {
	let claimedCancelled = false;
	let warning: string | undefined;

	// A preview built on a build server runs there, under no pid file the cancel
	// machinery knows (its row names no service), and the row's own server is
	// the host that serves it, not the one that builds. Nothing can be signalled
	// safely: only its queue slot is released, after the grace period.
	if (row.previewDeploymentId && row.buildServerId) {
		return {
			method: "none",
			notRunning: false,
			claimedCancelled,
			warning:
				"A preview deployment built on a build server cannot be stopped individually, so it was not signalled; its queue slot is released if it does not end by itself.",
		};
	}

	// A build on a build server, or a rolling replace, runs under a pid file and
	// is stopped exactly (see deployment-cancel.ts).
	const launcher = await deps.cancelWithLauncher(row.deploymentId);
	if (launcher?.status === "not-running") {
		return {
			method: "none",
			notRunning: true,
			claimedCancelled: false,
		};
	}
	if (launcher?.status === "cancelled") {
		claimedCancelled = true;
		warning = launcher.warning;
		// Signalled, or there was no step running yet and the claim alone stops the
		// deploy at its next step.
		if (!launcher.genericStopNeeded) {
			return {
				method: "launcher",
				notRunning: false,
				claimedCancelled,
				warning,
			};
		}
	}

	if (options.launcherOnly) {
		return {
			method: "none",
			notRunning: false,
			claimedCancelled,
			warning:
				warning ??
				"No queue job runs this deployment, so no process was signalled; only its record was closed.",
		};
	}

	if (row.pid && VALID_PID.test(row.pid)) {
		try {
			await deps.killPid(row.serverId, row.pid);
			return { method: "pid", notRunning: false, claimedCancelled, warning };
		} catch (error) {
			// The process is already gone, or the host cannot be reached.
			const reason = error instanceof Error ? error.message : String(error);
			return {
				method: "none",
				notRunning: false,
				claimedCancelled,
				warning: `Could not signal process ${row.pid}: ${reason}`,
			};
		}
	}

	// No launcher and no pid: the only handle left is the command name, which
	// matches every docker build (or compose) on the host. Only used when no
	// other deploy of that kind runs there, so an unrelated build is never hit.
	const kind = row.previewDeploymentId
		? await deps.resolveKind(row)
		: row.composeId
			? "compose"
			: "application";
	const others = await deps.countOtherRunning(row);
	if (others > 0) {
		return {
			method: "none",
			notRunning: false,
			claimedCancelled,
			warning: `The ${kind} build has no process handle and ${others} other deploy${others === 1 ? " runs" : "s run"} on the same host, so it was not signalled; it may keep running there until it ends.`,
			retryable: true,
		};
	}
	await deps.killDockerBuild(kind, row.serverId);
	return { method: "generic", notRunning: false, claimedCancelled, warning };
};
