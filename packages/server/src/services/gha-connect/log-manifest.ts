import type { JobInfo } from "./actions-api";
import { MANIFEST_MAX_BYTES } from "./manifest";

/**
 * The second source of the release manifest: the job log of the release job.
 *
 * GitHub Free's Actions storage can be used up, which blocks every artifact
 * upload of the organization. The action therefore also writes the manifest to
 * its job log, on ONE line of its own:
 *
 *   dokploy-release/v1 <payload>
 *
 * The payload is the UTF-8 bytes of the compact manifest JSON, one letter per
 * nibble: nibble 0 is "g", nibble 15 is "v", high nibble of a byte first. So it
 * only ever contains the letters g to v: no digit and no a-f.
 *
 * Why not base64 or hex: the runner masks the values of secrets in logs, and
 * also their base64 forms (all three alignments), so a base64 payload can be
 * corrupted by a secret whose value happens to occur in the manifest (an
 * organization has already seen image digests masked this way). Hex is not
 * masked as such, but a short secret made only of 0-9a-f (a port, a PIN) occurs
 * by chance inside hex text. A letters-only alphabet has no digits, so such a
 * secret cannot match; a secret that is letters g-v only and long enough to
 * occur in the payload is not a thing a manifest is encoded around. And the
 * prefix does not start with "::", so the runner's workflow-command parser is
 * never involved. A "*" in the payload means the runner masked something
 * anyway; that is reported as such, never guessed at.
 *
 * Size: the manifest is capped at 64 KiB, so a line is at most ~128 KiB (two
 * letters per byte) plus the prefix and GitHub's timestamp.
 *
 * Dokploy reads the line back through the Actions API (a job of the same run
 * and attempt), so it carries exactly the trust of the artifact: both are
 * output of a run that rule 1 proved to be this connection's own release run,
 * and the same rules 3 to 6 apply to either. Pure: no I/O.
 *
 * A line is a marker only when it STARTS with the marker (after GitHub's
 * timestamp prefix). The echo of the command that prints it, a quoted copy in
 * a message or a shell trace line start with something else and are ignored.
 */

export const LOG_MARKER = "dokploy-release/v1 ";

/** Largest job log read, in bytes. A release job is small; a build log is not asked for. */
export const JOB_LOG_MAX_BYTES = 16 * 1024 * 1024;

/** Most jobs of one attempt whose logs are read. */
export const MAX_LOG_JOBS = 10;

const BOM = String.fromCharCode(0xfeff);
/** `2026-11-03T12:34:56.1234567Z ` in front of every line GitHub serves. */
const TIMESTAMP = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z )?/;
const NIBBLES = /^[g-v]+$/;
const MASKED = /^[g-v*]+$/;
const MAX_ENCODED = MANIFEST_MAX_BYTES * 2;

export type LogManifest =
	| { ok: true; text: string }
	| {
			ok: false;
			code: "none" | "ambiguous" | "invalid" | "masked";
			message: string;
	  };

type Line = { kind: "text"; text: string } | { kind: "masked" } | null;

const A = "g".charCodeAt(0);

/** The payload for a manifest text: one letter per nibble, g (0) to v (15). */
export const encodeMarkerPayload = (text: string): string => {
	let out = "";
	for (const byte of Buffer.from(text, "utf8")) {
		out += String.fromCharCode(A + (byte >> 4), A + (byte & 15));
	}
	return out;
};

/** The text of a payload, or null when it is not exactly what encodeMarkerPayload writes. */
export const decodeMarkerPayload = (payload: string): string | null => {
	if (payload.length === 0 || payload.length % 2 !== 0) return null;
	if (!NIBBLES.test(payload)) return null;
	const bytes = Buffer.alloc(payload.length / 2);
	for (let i = 0; i < bytes.length; i += 1) {
		bytes[i] =
			((payload.charCodeAt(2 * i) - A) << 4) |
			(payload.charCodeAt(2 * i + 1) - A);
	}
	const text = bytes.toString("utf8");
	// Strict: the text must encode back to the same payload (rejects invalid UTF-8).
	return encodeMarkerPayload(text) === payload ? text : null;
};

/** Marker lines of a log, in order: decoded JSON text, or null for one that is not a valid payload. */
const markerLines = (log: string): Line[] => {
	const found: Line[] = [];
	for (const raw of log.split("\n")) {
		const unbommed = raw.startsWith(BOM) ? raw.slice(1) : raw;
		const line = unbommed.replace(TIMESTAMP, "").replace(/\r$/, "");
		if (!line.startsWith(LOG_MARKER)) continue;
		const encoded = line.slice(LOG_MARKER.length);
		if (encoded.length === 0 || encoded.length > MAX_ENCODED) {
			found.push(null);
			continue;
		}
		if (encoded.includes("*") && MASKED.test(encoded)) {
			found.push({ kind: "masked" });
			continue;
		}
		const text = decodeMarkerPayload(encoded);
		found.push(text === null ? null : { kind: "text", text });
	}
	return found;
};

/**
 * The one manifest the logs of the release job(s) carry. The same manifest
 * printed twice is one manifest; two different ones, or a marker line that is
 * not a valid payload, make the source unusable rather than a guess.
 */
export const extractLogManifest = (logs: string[]): LogManifest => {
	const texts = new Set<string>();
	let malformed = false;
	let masked = false;
	for (const log of logs) {
		for (const line of markerLines(log)) {
			if (line === null) malformed = true;
			else if (line.kind === "masked") masked = true;
			else texts.add(line.text);
		}
	}
	if (masked) {
		return {
			ok: false,
			code: "masked",
			message:
				"The runner masked part of the manifest in the job log: a repository, environment or organization secret has a value that appears in it. " +
				"That includes a short secret (a port, a PIN, a word) that happens to occur in the encoded text. " +
				"Move values that are image digests, registry hosts, repository names or service keys out of secrets, and avoid very short secrets (keep only real credentials there), then run the release again.",
		};
	}
	if (malformed) {
		return {
			ok: false,
			code: "invalid",
			message: "A manifest marker line of the job log is not a valid payload",
		};
	}
	if (texts.size === 0) {
		return {
			ok: false,
			code: "none",
			message: "The job log has no manifest marker",
		};
	}
	if (texts.size > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: "The job log carries more than one manifest",
		};
	}
	const [text] = texts;
	return { ok: true, text: text ?? "" };
};

/** What the wake-up record says about where the release ran. A hint only: it narrows the search, it proves nothing. */
export interface JobHint {
	/** `GITHUB_JOB` of the release job (the key in the workflow). */
	job?: string | null;
	/** `RUNNER_NAME` of the runner that ran it. */
	runner?: string | null;
}

const RELEASE_LIKE = /dokploy|release/i;

/**
 * The jobs whose log may hold the marker: completed with success, of this run
 * and attempt, on the run's commit. Narrowing only ORDERS them, it never
 * excludes: `preferred` are the jobs the connection's exact `releaseJobName`
 * names, else those that ran on the runner the wake-up hint names, else those
 * with the hinted job name (the hint comes from a Deployment anyone with write
 * access can create, so a wrong one must cost a few reads, never the release).
 * `rest` are all the other successful jobs, those whose name or any step name
 * mentions dokploy or release first. The caller reads preferred, then rest, at
 * most MAX_LOG_JOBS logs in all; `overCap` says more jobs exist than that.
 */
export const releaseJobs = (input: {
	jobs: JobInfo[];
	runId: number;
	attempt: number;
	headSha: string;
	releaseJobName?: string | null;
	hint?: JobHint | null;
}): { preferred: JobInfo[]; rest: JobInfo[]; overCap: boolean } => {
	const successful = input.jobs.filter(
		(job) =>
			job.status === "completed" &&
			job.conclusion === "success" &&
			(job.runId === null || job.runId === input.runId) &&
			(job.attempt === null || job.attempt === input.attempt) &&
			(job.headSha === null || job.headSha === input.headSha),
	);
	let preferred: JobInfo[] = [];
	if (input.releaseJobName) {
		preferred = successful.filter((job) => job.name === input.releaseJobName);
	} else {
		const runner = input.hint?.runner;
		const name = input.hint?.job;
		preferred = runner
			? successful.filter((job) => job.runnerName === runner)
			: [];
		if (preferred.length === 0 && name) {
			preferred = successful.filter((job) => job.name === name);
		}
	}
	const chosen = new Set(preferred.map((job) => job.id));
	const others = successful.filter((job) => !chosen.has(job.id));
	const releaseLike = (job: JobInfo) =>
		RELEASE_LIKE.test(job.name) ||
		job.stepNames.some((step) => RELEASE_LIKE.test(step));
	const rest = [
		...others.filter(releaseLike),
		...others.filter((job) => !releaseLike(job)),
	];
	return {
		preferred: preferred.slice(0, MAX_LOG_JOBS),
		rest,
		overCap: successful.length > MAX_LOG_JOBS,
	};
};
