import { DOKPLOY_RELEASE_TAG_REGEX } from "./dokploy-update-target";

export const UPDATE_ATTEMPT_STATUSES = [
	"pulling",
	"updating",
	"submitted",
	"failed",
] as const;

export type UpdateAttemptStatus = (typeof UPDATE_ATTEMPT_STATUSES)[number];

/**
 * What a failed attempt records. Only these categories and their fixed
 * messages are ever stored or shown: the docker and registry error text can
 * carry credentials (bearer tokens, URLs with userinfo or signed query
 * strings), so it goes to the server log only.
 */
export const UPDATE_ERROR_MESSAGES = {
	manifest_not_found: "The image was not found in the registry.",
	registry_unauthorized: "The registry refused access to the image.",
	registry_rate_limited:
		"The registry is rate limiting pulls. Try again later.",
	docker_unavailable:
		"Docker could not be reached from the Dokploy server. See the Dokploy server logs for details.",
	registry_unreachable: "The registry could not be reached.",
	timeout: "The operation timed out.",
	pull_failed:
		"Pulling the image failed. See the Dokploy server logs for details.",
	service_update_failed:
		"Docker could not update the dokploy service. See the Dokploy server logs for details.",
} as const;

export type UpdateErrorCode = keyof typeof UPDATE_ERROR_MESSAGES;

export const isUpdateErrorCode = (value: unknown): value is UpdateErrorCode =>
	typeof value === "string" && Object.hasOwn(UPDATE_ERROR_MESSAGES, value);

/**
 * Maps a failed docker command to a category. Only the category leaves this
 * function; the message is read here and dropped.
 */
export const classifyUpdateError = (
	error: unknown,
	phase: "pull" | "update",
): UpdateErrorCode => {
	if (phase === "update") {
		return "service_update_failed";
	}
	const text = error instanceof Error ? error.message : String(error ?? "");
	// The local socket first: its "permission denied" is not a registry refusal.
	if (/docker daemon|docker\.sock/i.test(text)) {
		return "docker_unavailable";
	}
	if (
		/manifest unknown|no such manifest|manifest for .* not found/i.test(text)
	) {
		return "manifest_not_found";
	}
	if (
		/unauthorized|pull access denied|denied: |requested access to the resource is denied|authentication required|requires authentication|\b40[13]\b/i.test(
			text,
		)
	) {
		return "registry_unauthorized";
	}
	if (/toomanyrequests|rate limit|\b429\b/i.test(text)) {
		return "registry_rate_limited";
	}
	if (/timeout|timed out|deadline exceeded/i.test(text)) {
		return "timeout";
	}
	if (
		/no such host|connection refused|connection reset|network is unreachable|dial tcp|\bEOF\b|tls:|lookup /i.test(
			text,
		)
	) {
		return "registry_unreachable";
	}
	return "pull_failed";
};

/** The last time an in-panel update was started, kept next to the rollback point. */
export interface IUpdateAttempt {
	/** Identifies this attempt, so a stale job can't overwrite a newer one. */
	attemptId: string;
	/** Dokploy version that was running when the update started. */
	fromVersion: string;
	/**
	 * What was asked for: a release tag, a digest (rollback), or for an unpinned
	 * update the latest release it resolved to.
	 */
	target: string;
	/** True when the caller named the target (a tag or the rollback). */
	pinned?: boolean;
	/**
	 * The version the server reports once the update is applied: the tag, the
	 * resolved latest tag, or for a rollback the recorded point's version.
	 */
	expectedVersion?: string;
	/** The image the update installs. */
	image: string;
	startedAt: string;
	finishedAt?: string;
	status: UpdateAttemptStatus;
	/** Set when `status` is `failed`. */
	errorCode?: UpdateErrorCode;
	/** The fixed message of `errorCode`; derived on read, never stored. */
	error?: string;
}

/** How long a submitted update may take before the running version is doubted. */
export const UPDATE_ATTEMPT_SETTLE_MS = 5 * 60_000;
/**
 * How long a pulling or updating attempt is believed. The swap replaces the
 * container that runs the job, so the record can stay at `updating` for good.
 */
export const UPDATE_ATTEMPT_STALE_MS = 15 * 60_000;

export type UpdateAttemptOutcome =
	| "in_progress"
	| "interrupted"
	| "applied"
	| "submitted"
	| "mismatch"
	| "failed";

/** The version the attempt should leave running, when it is a release. */
export const expectedUpdateVersion = (
	attempt: Pick<IUpdateAttempt, "expectedVersion" | "target">,
) => {
	const expected =
		attempt.expectedVersion ??
		(DOKPLOY_RELEASE_TAG_REGEX.test(attempt.target)
			? attempt.target
			: undefined);
	return expected && DOKPLOY_RELEASE_TAG_REGEX.test(expected)
		? expected
		: undefined;
};

/**
 * Where the attempt stands, judged by the version this process runs. The
 * stored status is never rewritten: a process started by the swap reads the
 * file and reconciles it here.
 * - applied: the running version is the expected one.
 * - in_progress: pulling or updating, started less than 15 minutes ago.
 * - interrupted: pulling or updating for 15 minutes or more, not applied.
 * - mismatch: submitted over 5 minutes ago, yet another version is running.
 * - submitted: handed to Docker, not yet applied nor overdue.
 */
export const getUpdateAttemptOutcome = (
	attempt: IUpdateAttempt,
	runningVersion: string,
	now = Date.now(),
): UpdateAttemptOutcome => {
	if (attempt.status === "failed") {
		return "failed";
	}
	const expected = expectedUpdateVersion(attempt);
	// A reinstall of the running version leaves the version string unchanged,
	// so for it the version proves nothing while the job is still `updating`:
	// the old container would read "applied" before the swap, and stay so if
	// Swarm rolled back. Only the job's own `submitted` (written once Docker
	// returned) counts. A reinstall whose job dies in the swap therefore reads
	// in progress, then interrupted, rather than a false success.
	const reinstall = expected !== undefined && expected === attempt.fromVersion;
	if (
		(attempt.status === "submitted" ||
			(attempt.status === "updating" && !reinstall)) &&
		expected === runningVersion
	) {
		return "applied";
	}
	if (attempt.status === "pulling" || attempt.status === "updating") {
		const age = now - Date.parse(attempt.startedAt);
		return age < UPDATE_ATTEMPT_STALE_MS ? "in_progress" : "interrupted";
	}
	const finished = Date.parse(attempt.finishedAt ?? "");
	return expected &&
		!Number.isNaN(finished) &&
		now - finished > UPDATE_ATTEMPT_SETTLE_MS
		? "mismatch"
		: "submitted";
};

const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;

/** How often the dialog re-reads the attempt: fast while it may still change. */
export const getUpdateAttemptPollMs = (
	outcome: UpdateAttemptOutcome | undefined,
) =>
	outcome === "in_progress" || outcome === "submitted"
		? POLL_ACTIVE_MS
		: POLL_IDLE_MS;
