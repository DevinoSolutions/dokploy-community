import { readFileSync } from "node:fs";
import path from "node:path";
import {
	extractLogManifest,
	LOG_MARKER,
	releaseJobs,
} from "@dokploy/server/services/gha-connect/log-manifest";
import { parseReleaseManifest } from "@dokploy/server/services/gha-connect/manifest";
import { describe, expect, it } from "vitest";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const TS = "2026-11-03T12:00:02.1234567Z ";

describe("extractLogManifest", () => {
	it("defines the marker", () => {
		expect(LOG_MARKER).toBe("::dokploy-release::");
	});

	it("reads the line after the timestamp GitHub puts in front, with or without it", () => {
		const text = JSON.stringify({ a: 1 });
		expect(extractLogManifest([`${TS}${LOG_MARKER}${b64(text)}\n`])).toEqual({
			ok: true,
			text,
		});
		expect(extractLogManifest([`${LOG_MARKER}${b64(text)}`])).toEqual({
			ok: true,
			text,
		});
	});

	it("keeps multi-byte text intact", () => {
		const text = JSON.stringify({ name: "café ✓" });
		expect(extractLogManifest([`${TS}${LOG_MARKER}${b64(text)}`])).toEqual({
			ok: true,
			text,
		});
	});

	it("finds no marker in an ordinary log", () => {
		expect(extractLogManifest([`${TS}hello\n${TS}world`])).toMatchObject({
			ok: false,
			code: "none",
		});
		expect(extractLogManifest([])).toMatchObject({ ok: false, code: "none" });
	});

	it("treats the same manifest in several jobs as one, different ones as ambiguous", () => {
		const a = `${TS}${LOG_MARKER}${b64('{"a":1}')}`;
		const b = `${TS}${LOG_MARKER}${b64('{"b":2}')}`;
		expect(extractLogManifest([a, a]).ok).toBe(true);
		expect(extractLogManifest([a, b])).toMatchObject({
			ok: false,
			code: "ambiguous",
		});
	});

	it.each([
		["not base64 characters", `${LOG_MARKER}%%%%`],
		["an empty payload", LOG_MARKER],
		["a length that is not a multiple of four", `${LOG_MARKER}YWJj=`],
		["padding in the middle", `${LOG_MARKER}YW=j`],
		["trailing garbage", `${LOG_MARKER}${b64("{}")} extra`],
		["an oversize payload", `${LOG_MARKER}${"A".repeat(90_000)}`],
	])("calls %s invalid, never a miss", (_name, line) => {
		expect(extractLogManifest([`${TS}${line}`])).toMatchObject({
			ok: false,
			code: "invalid",
		});
	});

	it("does not count a marker that merely appears inside another line", () => {
		const m = `${LOG_MARKER}${b64("{}")}`;
		for (const line of [
			`${TS}echo "${m}"`,
			`${TS}  ${m}`,
			`${TS}##[debug]${m}`,
			`${TS}note: ${m}`,
		]) {
			expect(extractLogManifest([line])).toMatchObject({
				ok: false,
				code: "none",
			});
		}
	});
});

describe("releaseJobs", () => {
	const job = (patch: Record<string, unknown> = {}) => ({
		id: 1,
		runId: 10 as number | null,
		attempt: 1 as number | null,
		name: "release",
		status: "completed",
		conclusion: "success" as string | null,
		headSha: "a".repeat(40) as string | null,
		stepNames: ["Run DevinoSolutions/dokploy-release@v1"],
		...patch,
	});
	const pick = (
		jobs: ReturnType<typeof job>[],
		releaseJobName?: string | null,
	) =>
		releaseJobs({
			jobs,
			runId: 10,
			attempt: 1,
			headSha: "a".repeat(40),
			releaseJobName,
		}).map((j) => j.id);

	it("takes successful jobs of the run that run the action, or are named for it", () => {
		expect(
			pick([
				job({ id: 1 }),
				job({ id: 2, name: "dokploy-publish", stepNames: [] }),
				job({ id: 3, name: "build", stepNames: ["docker build"] }),
			]),
		).toEqual([1, 2]);
	});

	it("an exact job name wins over the heuristic", () => {
		expect(
			pick([job({ id: 1 }), job({ id: 2, name: "ship" })], "ship"),
		).toEqual([2]);
	});

	it("drops jobs of another run, attempt or commit and jobs that did not succeed", () => {
		expect(
			pick([
				job({ id: 1, runId: 11 }),
				job({ id: 2, attempt: 2 }),
				job({ id: 3, headSha: "b".repeat(40) }),
				job({ id: 4, conclusion: "failure" }),
				job({ id: 5, status: "queued", conclusion: null }),
			]),
		).toEqual([]);
	});

	it("keeps jobs whose run fields GitHub left out, and reads at most three", () => {
		expect(
			pick(
				[1, 2, 3, 4].map((id) =>
					job({ id, runId: null, attempt: null, headSha: null }),
				),
			),
		).toEqual([1, 2, 3]);
	});
});

describe("the line the patched dokploy-release action prints", () => {
	// job-log-fixture/release-job.log: the marker line is the real stdout of the patched action (scripts/cli.mjs
	// manifest, DevinoSolutions/dokploy-release main 80aea9ab + the marker patch); the lines around it only imitate
	// the timestamps and groups of a GitHub job log.
	const log = readFileSync(
		path.join(__dirname, "job-log-fixture", "release-job.log"),
		"utf8",
	);

	it("is found among the log lines and is a manifest the parser accepts", () => {
		const extracted = extractLogManifest([log]);
		expect(extracted.ok).toBe(true);
		if (!extracted.ok) return;
		const parsed = parseReleaseManifest(extracted.text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.manifest).toMatchObject({
			sha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
			delivery: "pull",
			environment: "development",
			source: { ref: "refs/heads/dev", runId: "9876543210", runAttempt: 1 },
		});
		expect(parsed.manifest.services[0]?.images[0]?.repository).toBe(
			"localhost:5000/registry.devino.ca/voicelabs/web",
		);
	});

	it("never yields a manifest when the line is damaged", () => {
		const tampered = log.replace(
			"::dokploy-release::eyJ",
			"::dokploy-release::eyK",
		);
		const extracted = extractLogManifest([tampered]);
		expect(extracted.ok ? parseReleaseManifest(extracted.text).ok : false).toBe(
			false,
		);
	});
});
