import type { JobInfo } from "./actions-api";
import { MANIFEST_MAX_BYTES } from "./manifest";

/**
 * The second source of the release manifest: the job log of the release job.
 *
 * GitHub Free's Actions storage can be used up, which blocks every artifact
 * upload of the organization. The action therefore also writes the manifest to
 * its job log, on ONE line of its own:
 *
 *   ::dokploy-release::<standard base64 of the manifest JSON>
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

export const LOG_MARKER = "::dokploy-release::";

/** Largest job log read, in bytes. A release job is small; a build log is not asked for. */
export const JOB_LOG_MAX_BYTES = 16 * 1024 * 1024;

/** Most jobs of one attempt whose logs are read. */
export const MAX_LOG_JOBS = 3;

/** `2026-11-03T12:34:56.1234567Z ` in front of every line GitHub serves. */
const TIMESTAMP = /^﻿?(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z )?/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_ENCODED = Math.ceil(MANIFEST_MAX_BYTES / 3) * 4;

export type LogManifest =
	| { ok: true; text: string }
	| { ok: false; code: "none" | "ambiguous" | "invalid"; message: string };

/** Marker lines of a log, in order, as decoded JSON text (null for one that is not valid base64). */
const markerLines = (log: string): Array<string | null> => {
	const found: Array<string | null> = [];
	for (const raw of log.split("\n")) {
		const line = raw.replace(TIMESTAMP, "").replace(/\r$/, "");
		if (!line.startsWith(LOG_MARKER)) continue;
		const encoded = line.slice(LOG_MARKER.length);
		if (
			encoded.length === 0 ||
			encoded.length > MAX_ENCODED ||
			encoded.length % 4 !== 0 ||
			!BASE64.test(encoded)
		) {
			found.push(null);
			continue;
		}
		const bytes = Buffer.from(encoded, "base64");
		// Strict: the text must encode back to the same characters.
		found.push(
			bytes.toString("base64") === encoded ? bytes.toString("utf8") : null,
		);
	}
	return found;
};

/**
 * The one manifest the logs of the release job(s) carry. The same manifest
 * printed twice is one manifest; two different ones, or a marker line that is
 * not valid base64, make the source unusable rather than a guess.
 */
export const extractLogManifest = (logs: string[]): LogManifest => {
	const texts = new Set<string>();
	let malformed = false;
	for (const log of logs) {
		for (const text of markerLines(log)) {
			if (text === null) malformed = true;
			else texts.add(text);
		}
	}
	if (malformed) {
		return {
			ok: false,
			code: "invalid",
			message: "A manifest marker line of the job log is not valid base64",
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

const RELEASE_STEP = /dokploy/i;

/**
 * The jobs whose log may hold the marker: completed with success, of this run
 * and attempt, on the run's commit, and named for the release. A job is the
 * release job when its name equals the connection's `releaseJobName`; without
 * one, when its name or one of its step names mentions dokploy (the action's
 * own step is called "Run DevinoSolutions/dokploy-release@...").
 */
export const releaseJobs = (input: {
	jobs: JobInfo[];
	runId: number;
	attempt: number;
	headSha: string;
	releaseJobName?: string | null;
}): JobInfo[] =>
	input.jobs
		.filter(
			(job) =>
				job.status === "completed" &&
				job.conclusion === "success" &&
				(job.runId === null || job.runId === input.runId) &&
				(job.attempt === null || job.attempt === input.attempt) &&
				(job.headSha === null || job.headSha === input.headSha),
		)
		.filter((job) =>
			input.releaseJobName
				? job.name === input.releaseJobName
				: RELEASE_STEP.test(job.name) ||
					job.stepNames.some((name) => RELEASE_STEP.test(name)),
		)
		.slice(0, MAX_LOG_JOBS);
