/**
 * A pull release whose image the registry does not serve yet (T-15783).
 *
 * GHCR needs a while after a push before the new manifest can be read without
 * a login. A host that pulls anonymously (devino-first has no registry login
 * by rule) can have its swarm task Rejected with
 *
 *   Get "https://ghcr.io/v2/<org>/<repo>/<image>/manifests/sha256:...": denied: denied
 *
 * even though the same digest pulls fine a few minutes later. Settling such a
 * release as failed is final, so a person had to re-run the publish job. These
 * rules decide when a failed deploy is that case, and how long to wait before
 * the poller starts the same release again. Pure: the database writes are in
 * store.ts, the scheduling is the poller's own tick.
 */

/** Waits before retry 1, 2, 3 and 4: 60 s, 120 s, 240 s, 300 s (12 minutes in all). */
export const REGISTRY_RETRY_DELAYS_MS = [
	60_000, 120_000, 240_000, 300_000,
] as const;
export const MAX_REGISTRY_RETRIES = REGISTRY_RETRY_DELAYS_MS.length;

/**
 * The swarm task that could not pull. `waitForSwarmServiceStable` reports it as
 * `Task rejected: <Status.Err>` and the deploy wraps that in
 * `Container did not stay running after deployment: ...`; the deploy job
 * writes the wrapped message on the deployment row (`errorMessage`).
 */
const REJECTED_TASK = /\btask rejected\b/i;
/**
 * What a docker pull says when the registry refuses a read (a compose stack deploy has no task
 * text): a manifest or blob URL of the registry API, or docker's own pull wording.
 */
const PULL_CONTEXT =
	/https?:\/\/[^\s"']+\/v2\/[^\s"']+\/(?:manifests|blobs)\/|pull access denied|failed to (?:resolve reference|pull)|error pulling image/i;

/**
 * The registry's own words for "you may not read this (yet)". A bare "denied" or
 * "not found" is not enough: `permission denied` (a mount or file problem) and
 * `exec: node: not found` (a crashed container) are real failures.
 */
const ACCESS_ERROR: RegExp[] = [
	/\bdenied: denied\b/i,
	/\bpull access denied\b/i,
	/\brequested access to the resource is denied\b/i,
	/\bunauthorized: /i,
	/\bmanifest unknown\b/i,
	// A refusal said right after a manifest or blob reference of the registry API.
	/\/(?:manifests|blobs)\/[^\n]*?(?:(?<!permission )\bdenied\b|\bunauthorized\b|\bnot found\b)/i,
];

/**
 * Whether a failed deploy's error text says the registry refused or did not
 * have the released image. Only a rejected swarm task or a pull error counts: a
 * container that crashed (`Task failed`), `permission denied`, or any other
 * error mentioning "not found" is a real failure and settles as one.
 */
export const isRegistryAccessError = (
	message: string | null | undefined,
): boolean => {
	if (!message) return false;
	if (!REJECTED_TASK.test(message) && !PULL_CONTEXT.test(message)) return false;
	return ACCESS_ERROR.some((pattern) => pattern.test(message));
};

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** The text GitHub and the dashboard show while a retry is waiting: fixed words and numbers only. */
export const registryRetryText = (attempt: number, delayMs: number): string =>
	`Image not readable at the registry yet; retrying in ${seconds(delayMs)} (${attempt}/${MAX_REGISTRY_RETRIES})`;

/** The dashboard's sentence for a retry that is waiting (`retryAt`) or about to start. */
export const describeRegistryRetry = (
	retry: { attempt: number; retryAt: Date },
	now: Date,
): string => {
	const remaining = retry.retryAt.getTime() - now.getTime();
	return remaining > 0
		? registryRetryText(retry.attempt, Math.ceil(remaining / 1000) * 1000)
		: `Image not readable at the registry yet; retrying now (${retry.attempt}/${MAX_REGISTRY_RETRIES})`;
};

export type RegistryRetryDecision =
	/** Not a registry access error: settle as failed, as before. */
	| { kind: "settle" }
	/** A registry access error with no retry left: settle as failed and say why. */
	| { kind: "exhausted" }
	/** Schedule retry number `attempt` (1-based) after `delayMs`. */
	| { kind: "retry"; attempt: number; delayMs: number };

/**
 * What to do with a deploy that ended in error. `registryAccess` is
 * `isRegistryAccessError` of its recorded error text; `retriesDone` is how many
 * retries were already scheduled for this release.
 */
export const decideRegistryRetry = (input: {
	registryAccess: boolean;
	retriesDone: number;
}): RegistryRetryDecision => {
	if (!input.registryAccess) return { kind: "settle" };
	const delayMs = REGISTRY_RETRY_DELAYS_MS[input.retriesDone];
	if (delayMs === undefined) return { kind: "exhausted" };
	return { kind: "retry", attempt: input.retriesDone + 1, delayMs };
};

/** What a settled deploy tells the poll: keep the GitHub Deployment open and wait, or report its end. */
export type ReleaseEndVerdict =
	| { kind: "retry"; text: string }
	| { kind: "exhausted"; note: string }
	| { kind: "settled" };

export const exhaustedNote = (sha: string): string =>
	`Release ${sha.slice(0, 7)} failed: the registry still did not serve the image after ${MAX_REGISTRY_RETRIES} retries.`;
