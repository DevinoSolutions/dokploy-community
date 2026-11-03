import type { JobInfo } from "./actions-api";
import { MANIFEST_MAX_BYTES } from "./manifest";

/**
 * The second source of the release manifest: the job log of the release job.
 *
 * GitHub Free's Actions storage can be used up, which blocks every artifact
 * upload of the organization. The action therefore also writes the manifest to
 * its job log, on ONE line of its own:
 *
 *   dokploy-release/v1 <lowercase hex of the UTF-8 bytes of the compact manifest JSON>
 *
 * Why hex and why no leading "::": the runner masks the values of secrets in
 * logs, and also their base64 forms (all three alignments), so a base64 payload
 * can be corrupted by a secret whose value happens to occur in the manifest
 * (an organization has already seen image digests masked this way). The runner
 * has no hex masking. And the prefix does not start with "::", so the runner's
 * workflow-command parser is never involved. A "*" in the payload means the
 * runner masked something anyway; that is reported as such, never guessed at.
 *
 * Size: the manifest is capped at 64 KiB, so a line is at most ~128 KiB (two
 * hex digits per byte) plus the prefix and GitHub's timestamp.
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
const HEX = /^[0-9a-f]+$/;
const MASKED = /^[0-9a-f*]+$/;
const MAX_ENCODED = MANIFEST_MAX_BYTES * 2;

export type LogManifest =
	| { ok: true; text: string }
	| {
			ok: false;
			code: "none" | "ambiguous" | "invalid" | "masked";
			message: string;
	  };

type Line = { kind: "text"; text: string } | { kind: "masked" } | null;

/** Marker lines of a log, in order: decoded JSON text, or null for one that is not valid hex. */
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
		if (encoded.length % 2 !== 0 || !HEX.test(encoded)) {
			found.push(null);
			continue;
		}
		const bytes = Buffer.from(encoded, "hex");
		// Strict: the text must encode back to the same bytes (rejects invalid UTF-8).
		const text = bytes.toString("utf8");
		found.push(
			Buffer.from(text, "utf8").toString("hex") === encoded
				? { kind: "text", text }
				: null,
		);
	}
	return found;
};

/**
 * The one manifest the logs of the release job(s) carry. The same manifest
 * printed twice is one manifest; two different ones, or a marker line that is
 * not valid hex, make the source unusable rather than a guess.
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
				"Move values that are image digests, registry hosts, repository names or service keys out of secrets (keep only real credentials there), then run the release again.",
		};
	}
	if (malformed) {
		return {
			ok: false,
			code: "invalid",
			message: "A manifest marker line of the job log is not valid hex",
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

/**
 * The jobs whose log may hold the marker: completed with success, of this run
 * and attempt, on the run's commit. Narrowed, in order, by the connection's
 * exact `releaseJobName`, else by the runner named in the wake-up hint, else by
 * the hinted job name; with no match every successful job of the attempt is a
 * candidate. At most MAX_LOG_JOBS.
 */
export const releaseJobs = (input: {
	jobs: JobInfo[];
	runId: number;
	attempt: number;
	headSha: string;
	releaseJobName?: string | null;
	hint?: JobHint | null;
}): JobInfo[] => {
	const successful = input.jobs.filter(
		(job) =>
			job.status === "completed" &&
			job.conclusion === "success" &&
			(job.runId === null || job.runId === input.runId) &&
			(job.attempt === null || job.attempt === input.attempt) &&
			(job.headSha === null || job.headSha === input.headSha),
	);
	let pool = successful;
	if (input.releaseJobName) {
		pool = successful.filter((job) => job.name === input.releaseJobName);
	} else {
		const runner = input.hint?.runner;
		const byRunner = runner
			? successful.filter((job) => job.runnerName === runner)
			: [];
		const name = input.hint?.job;
		const byName = name ? successful.filter((job) => job.name === name) : [];
		if (byRunner.length > 0) pool = byRunner;
		else if (byName.length > 0) pool = byName;
	}
	return pool.slice(0, MAX_LOG_JOBS);
};
