import { readDeploymentPayload } from "../github-deployments/payload";

/**
 * A GitHub Deployment is a wake-up record, never the source of truth: anyone
 * with write access can create one. All it may say is which run to look at.
 * The release itself is the run artifact (see manifest.ts and acceptance.ts).
 *
 *   task:    "dokploy:<service key>"
 *   payload: {"schema":"dokploy.deployment/v1","run_id":<id>,"run_attempt":<n>,"artifact":"dokploy-release"}
 *            plus the optional hints "job" (GITHUB_JOB) and "runner" (RUNNER_NAME) that say which job of the
 *            run printed the manifest line; they only narrow which job log is read.
 */

export const WAKE_SCHEMA = "dokploy.deployment/v1";
export const TASK_PREFIX = "dokploy:";

const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** The service key of a `dokploy:<key>` task; null for any other task. */
export const parseDeploymentTask = (task: unknown): string | null => {
	if (typeof task !== "string" || !task.startsWith(TASK_PREFIX)) return null;
	const key = task.slice(TASK_PREFIX.length);
	return KEY.test(key) ? key : null;
};

export type WakePayload =
	| {
			ok: true;
			runId: number;
			runAttempt: number;
			/** `GITHUB_JOB` of the release job, when the action sent it. A hint only. */
			job?: string;
			/** `RUNNER_NAME` of the runner that ran it, when the action sent it. A hint only. */
			runner?: string;
	  }
	| { ok: false; reason: string };

const positiveInteger = (value: unknown): number | null => {
	const n =
		typeof value === "string" && /^[0-9]{1,18}$/.test(value)
			? Number(value)
			: value;
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : null;
};

/** A job or runner name: printable ASCII, so it can only ever be compared, never interpreted. */
const hintText = (value: unknown): string | undefined =>
	typeof value === "string" && /^[ -~]{1,120}$/.test(value) ? value : undefined;

export const parseWakePayload = (raw: unknown): WakePayload => {
	const payload = readDeploymentPayload(raw);
	if (!payload)
		return { ok: false, reason: "The payload is not a JSON object" };
	if (payload.schema !== WAKE_SCHEMA) {
		return { ok: false, reason: "The payload names another schema" };
	}
	if (payload.artifact !== "dokploy-release") {
		return { ok: false, reason: "The payload names another artifact" };
	}
	const runId = positiveInteger(payload.run_id);
	const runAttempt = positiveInteger(payload.run_attempt);
	if (runId === null || runAttempt === null) {
		return {
			ok: false,
			reason: "run_id and run_attempt must be positive integers",
		};
	}
	const job = hintText(payload.job);
	const runner = hintText(payload.runner);
	return {
		ok: true,
		runId,
		runAttempt,
		...(job ? { job } : {}),
		...(runner ? { runner } : {}),
	};
};
