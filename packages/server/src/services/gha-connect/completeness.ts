import { parseDeploymentTask, parseWakePayload } from "./wake-payload";

/**
 * A release can name several services (release.services in the manifest), each
 * with its own GitHub Deployment. A service waits until every other service of
 * the release has its Deployment for the same run attempt, so one repository
 * never ends up half-released by a workflow that died between two Deployments.
 * After the timeout the release is incomplete and the service is Blocked.
 * Pure.
 */

export const RELEASE_COMPLETE_TIMEOUT_MS = 15 * 60 * 1000;

export type Completeness =
	| { complete: true }
	| { complete: false; missing: string[]; timedOut: boolean };

export const checkReleaseComplete = (input: {
	ownKey: string;
	releaseServices: readonly string[];
	runId: number;
	runAttempt: number;
	/** The Deployments of the repository as listed this tick. */
	deployments: ReadonlyArray<{ task?: string | null; payload?: unknown }>;
	now: number;
	/** When the run finished (epoch ms); null when GitHub did not say. */
	runEndedAt: number | null;
	timeoutMs?: number;
}): Completeness => {
	const seen = new Set<string>();
	for (const deployment of input.deployments) {
		const key = parseDeploymentTask(deployment.task);
		if (key === null) continue;
		const wake = parseWakePayload(deployment.payload);
		if (
			wake.ok &&
			wake.runId === input.runId &&
			wake.runAttempt === input.runAttempt
		) {
			seen.add(key);
		}
	}
	const missing = input.releaseServices.filter(
		(key) => key !== input.ownKey && !seen.has(key),
	);
	if (missing.length === 0) return { complete: true };
	const timeout = input.timeoutMs ?? RELEASE_COMPLETE_TIMEOUT_MS;
	return {
		complete: false,
		missing,
		timedOut:
			input.runEndedAt !== null && input.now - input.runEndedAt > timeout,
	};
};
