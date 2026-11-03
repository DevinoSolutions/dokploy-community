/**
 * The connection state machine of "Build on GitHub Actions". Pure: the poller
 * feeds events, the database stores the result (state, detail, since).
 *
 *   not_connected -> proposed -> detected -> waiting -> connected
 *                                   connected <-> stale
 *                          (any live state) -> blocked -> connected
 *                                   (any state) -> disconnected -> waiting | connected
 *
 * `proposed` (a pull request is open) and `detected` (the workflow is on the
 * tracked branch) belong to the wizard of phase 2; phase 1 creates a
 * connection the moment the user confirms, in `waiting`. The reducer already
 * knows them so phase 2 only adds events.
 */

export const CONNECTION_STATES = [
	"not_connected",
	"proposed",
	"detected",
	"waiting",
	"connected",
	"stale",
	"blocked",
	"disconnected",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface StateView {
	state: ConnectionState;
	/** Short reason shown after the state text (a refusal, a stale cause). */
	detail: string | null;
}

export type ConnectionEvent =
	| { type: "proposed" }
	| { type: "proposal-closed" }
	| { type: "workflow-detected" }
	/** The user confirmed Connect. */
	| { type: "connect" }
	/** A release was deployed (or a pull release matched what runs). */
	| { type: "release-deployed" }
	| { type: "release-refused"; message: string; block: boolean }
	| { type: "stale"; reason: string }
	| { type: "fresh"; hasRelease: boolean }
	| { type: "token-revoked" }
	| { type: "token-restored"; hasRelease: boolean }
	| { type: "unblock"; hasRelease: boolean };

const view = (
	state: ConnectionState,
	detail: string | null = null,
): StateView => ({
	state,
	detail,
});

export const reduceConnection = (
	current: StateView,
	event: ConnectionEvent,
): StateView => {
	const { state } = current;
	switch (event.type) {
		case "proposed":
			return state === "not_connected" ? view("proposed") : current;
		case "proposal-closed":
			return state === "proposed" ? view("not_connected") : current;
		case "workflow-detected":
			return state === "not_connected" || state === "proposed"
				? view("detected")
				: current;
		case "connect":
			return state === "not_connected" ||
				state === "proposed" ||
				state === "detected"
				? view("waiting")
				: current;
		case "release-deployed":
			return state === "disconnected" ||
				state === "not_connected" ||
				state === "proposed" ||
				state === "detected"
				? current
				: view("connected");
		case "release-refused":
			if (!event.block) return current;
			return state === "disconnected" ||
				state === "not_connected" ||
				state === "proposed" ||
				state === "detected"
				? current
				: view("blocked", event.message);
		case "stale":
			return state === "waiting" || state === "connected" || state === "stale"
				? view("stale", event.reason)
				: current;
		case "fresh":
			return state === "stale"
				? view(event.hasRelease ? "connected" : "waiting")
				: current;
		case "token-revoked":
			return state === "not_connected" ? current : view("disconnected");
		case "token-restored":
			return state === "disconnected"
				? view(event.hasRelease ? "connected" : "waiting")
				: current;
		case "unblock":
			return state === "blocked"
				? view(event.hasRelease ? "connected" : "waiting")
				: current;
	}
};

export interface DescribeContext {
	/** The commit the connection waits for (the branch head at Connect). */
	expectedSha: string | null;
	/** The commit running now. */
	deployedSha: string | null;
	/** Pull request number while `proposed`. */
	pullRequest?: number | null;
	/** When the last release was deployed. */
	lastReleaseAt: Date | null;
	/** The commit of the last release, for the stale line. */
	lastReleaseSha?: string | null;
	now: Date;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

const ago = (from: Date, now: Date): string => {
	const minutes = Math.max(
		0,
		Math.round((now.getTime() - from.getTime()) / 60_000),
	);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	return `${Math.round(hours / 24)} days ago`;
};

/** The row text of the design's state table. */
export const describeState = (
	current: StateView,
	context: DescribeContext,
): string | null => {
	switch (current.state) {
		case "not_connected":
			return null;
		case "proposed":
			return context.pullRequest
				? `Waiting for you to merge pull request #${context.pullRequest}.`
				: "Waiting for you to merge the pull request.";
		case "detected":
			return "Workflow found. Waiting for a release.";
		case "waiting":
			return context.expectedSha
				? `Waiting for GitHub Actions to publish ${short(context.expectedSha)}. Git autodeploy is off.`
				: "Waiting for GitHub Actions to publish a release. Git autodeploy is off.";
		case "connected":
			return "Deployed from GitHub Actions.";
		case "stale": {
			const last =
				context.lastReleaseAt && context.lastReleaseSha
					? ` Last release ${short(context.lastReleaseSha)}, ${ago(context.lastReleaseAt, context.now)}.`
					: "";
			return `${current.detail ?? "GitHub Actions has not published the latest commit."}${last}`;
		}
		case "blocked":
			return current.detail ?? "A release was refused.";
		case "disconnected":
			return "GitHub access was lost. Reconnect.";
	}
};
