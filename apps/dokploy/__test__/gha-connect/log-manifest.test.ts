import { readFileSync } from "node:fs";
import path from "node:path";
import {
	extractLogManifest,
	LOG_MARKER,
	MAX_LOG_JOBS,
	releaseJobs,
} from "@dokploy/server/services/gha-connect/log-manifest";
import {
	MANIFEST_MAX_BYTES,
	parseReleaseManifest,
} from "@dokploy/server/services/gha-connect/manifest";
import { describe, expect, it } from "vitest";

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
const TS = "2026-11-03T12:00:02.1234567Z ";
const BOM = String.fromCharCode(0xfeff);

describe("extractLogManifest", () => {
	it("defines the marker: no leading colons, exactly one space", () => {
		expect(LOG_MARKER).toBe("dokploy-release/v1 ");
		expect(LOG_MARKER.startsWith(":")).toBe(false);
	});

	it("reads the line after the timestamp GitHub puts in front, with or without it", () => {
		const text = JSON.stringify({ a: 1 });
		expect(extractLogManifest([`${TS}${LOG_MARKER}${hex(text)}\n`])).toEqual({
			ok: true,
			text,
		});
		expect(extractLogManifest([`${LOG_MARKER}${hex(text)}`])).toEqual({
			ok: true,
			text,
		});
	});

	it("keeps multi-byte text intact", () => {
		const text = JSON.stringify({ name: "café ✓" });
		expect(extractLogManifest([`${TS}${LOG_MARKER}${hex(text)}`])).toEqual({
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
		const a = `${TS}${LOG_MARKER}${hex('{"a":1}')}`;
		const b = `${TS}${LOG_MARKER}${hex('{"b":2}')}`;
		expect(extractLogManifest([a, a]).ok).toBe(true);
		expect(extractLogManifest([a, b])).toMatchObject({
			ok: false,
			code: "ambiguous",
		});
	});

	it.each([
		["a character that is not hex", `${LOG_MARKER}zz`],
		["an uppercase digit (the round trip must be exact)", `${LOG_MARKER}7B7D`],
		["an empty payload", LOG_MARKER],
		["an odd number of digits", `${LOG_MARKER}7b7`],
		["trailing garbage", `${LOG_MARKER}${hex("{}")} extra`],
		["bytes that are not UTF-8", `${LOG_MARKER}ff`],
		[
			"an oversize payload",
			`${LOG_MARKER}${"aa".repeat(MANIFEST_MAX_BYTES + 1)}`,
		],
	])("calls %s invalid, never a miss", (_name, line) => {
		expect(extractLogManifest([`${TS}${line}`])).toMatchObject({
			ok: false,
			code: "invalid",
		});
	});

	it("accepts a manifest at the 64 KiB cap, a ~128 KiB line", () => {
		const text = ` ${"x".repeat(MANIFEST_MAX_BYTES - 1)}`;
		expect(Buffer.byteLength(text)).toBe(MANIFEST_MAX_BYTES);
		const line = `${TS}${LOG_MARKER}${hex(text)}`;
		expect(line.length).toBeGreaterThan(2 * MANIFEST_MAX_BYTES);
		expect(extractLogManifest([line])).toEqual({ ok: true, text });
	});

	it("says a masked payload was masked, whatever else is in the log", () => {
		const good = `${TS}${LOG_MARKER}${hex("{}")}`;
		for (const masked of [
			`${LOG_MARKER}7b22***7d`,
			`${LOG_MARKER}***`,
			`${LOG_MARKER}${hex("{}")}***`,
		]) {
			const result = extractLogManifest([`${TS}${masked}`, good]);
			expect(result).toMatchObject({ ok: false, code: "masked" });
			if (!result.ok) {
				expect(result.message).toMatch(/masked/);
				expect(result.message).toMatch(/secret/);
				expect(result.message).toMatch(/digests/);
			}
		}
	});

	it("does not count a marker that merely appears inside another line", () => {
		const m = `${LOG_MARKER}${hex("{}")}`;
		for (const line of [
			`${TS}echo "${m}"`,
			`${TS}  ${m}`,
			`${TS}##[debug]${m}`,
			`${TS}note: ${m}`,
			`${TS}::${m}`,
		]) {
			expect(extractLogManifest([line])).toMatchObject({
				ok: false,
				code: "none",
			});
		}
	});

	it("reads a line after a byte order mark, with CRLF", () => {
		expect(
			extractLogManifest([`${BOM}${TS}${LOG_MARKER}${hex("{}")}\r\n`]),
		).toEqual({ ok: true, text: "{}" });
		expect(extractLogManifest([`${BOM}${LOG_MARKER}${hex("{}")}`])).toEqual({
			ok: true,
			text: "{}",
		});
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
		runnerName: "runner-1" as string | null,
		stepNames: ["Run DevinoSolutions/dokploy-release@v1"],
		...patch,
	});
	const pick = (
		jobs: ReturnType<typeof job>[],
		extra: {
			releaseJobName?: string | null;
			hint?: { job?: string; runner?: string };
		} = {},
	) =>
		releaseJobs({
			jobs,
			runId: 10,
			attempt: 1,
			headSha: "a".repeat(40),
			...extra,
		}).map((j) => j.id);

	it("takes every successful job of the attempt, not only ones named for dokploy", () => {
		expect(
			pick([
				job({ id: 1 }),
				job({ id: 2, name: "build", stepNames: ["docker build"] }),
			]),
		).toEqual([1, 2]);
	});

	it("narrows to the runner the wake-up hint names, else to the hinted job name", () => {
		const jobs = [
			job({ id: 1, runnerName: "r1" }),
			job({ id: 2, runnerName: "r2", name: "ship" }),
			job({ id: 3, runnerName: "r3", name: "other" }),
		];
		expect(pick(jobs, { hint: { runner: "r2" } })).toEqual([2]);
		expect(pick(jobs, { hint: { job: "other" } })).toEqual([3]);
		expect(pick(jobs, { hint: { runner: "r2", job: "other" } })).toEqual([2]);
		// A hint that matches nothing narrows nothing.
		expect(pick(jobs, { hint: { runner: "nope", job: "nope" } })).toEqual([
			1, 2, 3,
		]);
	});

	it("an exact job name of the connection wins over the hint", () => {
		const jobs = [
			job({ id: 1, runnerName: "r1" }),
			job({ id: 2, name: "ship", runnerName: "r2" }),
		];
		expect(
			pick(jobs, { releaseJobName: "ship", hint: { runner: "r1" } }),
		).toEqual([2]);
		expect(pick(jobs, { releaseJobName: "none" })).toEqual([]);
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

	it("keeps jobs whose run fields GitHub left out, and reads at most ten", () => {
		const jobs = Array.from({ length: 12 }, (_, i) =>
			job({ id: i + 1, runId: null, attempt: null, headSha: null }),
		);
		expect(MAX_LOG_JOBS).toBe(10);
		expect(pick(jobs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});
});

describe("the line the patched dokploy-release action prints", () => {
	// job-log-fixture/release-job.log: the marker line is the real stdout of the patched action (scripts/cli.mjs
	// manifest, DevinoSolutions/dokploy-release main 80aea9ab + dokploy-release-marker.patch); the lines around it only
	// imitate the timestamps and groups of a GitHub job log.
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

	it("is the compact JSON of the manifest, in lowercase hex", () => {
		const extracted = extractLogManifest([log]);
		if (!extracted.ok) throw new Error("no marker");
		expect(extracted.text).toBe(JSON.stringify(JSON.parse(extracted.text)));
		const line = log.split("\n").find((l) => l.includes(LOG_MARKER)) ?? "";
		expect(line.slice(line.indexOf(LOG_MARKER) + LOG_MARKER.length)).toBe(
			hex(extracted.text),
		);
	});

	it("never yields a manifest when the line is damaged", () => {
		const tampered = log.replace(`${LOG_MARKER}7b22`, `${LOG_MARKER}7b23`);
		expect(tampered).not.toBe(log);
		const extracted = extractLogManifest([tampered]);
		expect(extracted.ok ? parseReleaseManifest(extracted.text).ok : false).toBe(
			false,
		);
	});
});
