/** Snapvisor `Build.status` → the label/tone shown on a build badge. */
export const SNAPVISOR_STATUS_PRESENTATION: Record<
	string,
	{ label: string; className: string }
> = {
	pending: { label: "Pending", className: "text-muted-foreground" },
	progress: { label: "Pending", className: "text-muted-foreground" },
	"no-changes": { label: "No changes", className: "text-green-600" },
	"changes-detected": {
		label: "Changes detected",
		className: "text-yellow-600",
	},
	accepted: { label: "Approved", className: "text-green-600" },
	rejected: { label: "Rejected", className: "text-red-600" },
	error: { label: "Error", className: "text-red-600" },
	aborted: { label: "Error", className: "text-red-600" },
	expired: { label: "Expired", className: "text-muted-foreground" },
};

/**
 * Build statuses that can never change again on their own: a review outcome
 * (accepted/rejected) or a finished/failed run (no-changes/error/aborted/
 * expired). Polling stops once one of these is reached; a new commit gets a
 * new build anyway.
 */
export const SNAPVISOR_TERMINAL_STATUSES = new Set([
	"accepted",
	"rejected",
	"no-changes",
	"error",
	"aborted",
	"expired",
]);

export type SnapvisorUnavailableReason =
	| "auth"
	| "rate-limited"
	| "project"
	| "unreachable";

/** What `snapvisor.deploymentBuild` returns (server: `DeploymentSnapvisorBuild`). */
export type SnapvisorDeploymentBuildData =
	| { state: "off" | "not-connected" | "no-commit" | "no-build" }
	| { state: "unavailable"; reason: SnapvisorUnavailableReason }
	| {
			state: "ready";
			buildNumber: number;
			buildStatus: string;
			changedSnapshots: number | null;
			reviewUrl: string;
	  };

const UNAVAILABLE_HINTS: Record<SnapvisorUnavailableReason, string> = {
	auth: "Snapvisor rejected the access token. An admin can update it in Settings → Integrations.",
	"rate-limited": "Snapvisor is rate limiting requests. Try again in a minute.",
	project: "The linked Snapvisor project was not found.",
	unreachable: "Snapvisor could not be reached.",
};

export interface SnapvisorBadgeView {
	label: string;
	className: string;
	/** Longer explanation, shown as a tooltip. */
	title?: string;
	reviewUrl: string | null;
}

/**
 * What a deployment row shows for its build, or `null` for "show nothing":
 * the service is not linked, Snapvisor is not connected, or the deployment has
 * no commit. A missing build and an unreachable Snapvisor are quiet states of
 * their own, never errors.
 */
export const presentDeploymentBuild = (
	data: SnapvisorDeploymentBuildData | undefined | null,
): SnapvisorBadgeView | null => {
	if (!data) return null;
	switch (data.state) {
		case "off":
		case "not-connected":
		case "no-commit":
			return null;
		case "no-build":
			return {
				label: "No build yet",
				className: "text-muted-foreground",
				title: "Snapvisor has no build for this commit yet.",
				reviewUrl: null,
			};
		case "unavailable":
			return {
				label: "Unavailable",
				className: "text-muted-foreground",
				title: UNAVAILABLE_HINTS[data.reason],
				reviewUrl: null,
			};
		case "ready": {
			const presentation = SNAPVISOR_STATUS_PRESENTATION[data.buildStatus];
			const changed =
				data.buildStatus === "changes-detected" && data.changedSnapshots
					? ` (${data.changedSnapshots})`
					: "";
			return {
				label: `${presentation?.label ?? "Unknown"}${changed}`,
				className: presentation?.className ?? "text-muted-foreground",
				title: `Snapvisor build #${data.buildNumber}`,
				reviewUrl: data.reviewUrl,
			};
		}
	}
};

/**
 * How often to ask again: only while the answer can still change by itself (a
 * missing build may appear, a running or unreviewed one may finish). A failure
 * is retried by the refresh button, not on a timer.
 */
export const deploymentBuildRefetchInterval = (
	data: SnapvisorDeploymentBuildData | undefined | null,
): number | false => {
	if (!data) return false;
	if (data.state === "no-build") return 60_000;
	if (data.state === "ready") {
		return SNAPVISOR_TERMINAL_STATUSES.has(data.buildStatus) ? false : 60_000;
	}
	return false;
};

/**
 * A build only exists for a deployment that finished and recorded its full
 * commit (the `Commit: <sha>` marker every git deploy writes).
 */
export const FULL_COMMIT_DESCRIPTION_RE = /^Commit:\s*[0-9a-f]{40}$/i;

export const deploymentCanHaveSnapvisorBuild = (deployment: {
	status: string | null;
	description: string | null;
}) =>
	deployment.status === "done" &&
	FULL_COMMIT_DESCRIPTION_RE.test(deployment.description?.trim() ?? "");
