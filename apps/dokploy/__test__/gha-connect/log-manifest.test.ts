import { readFileSync } from "node:fs";
import path from "node:path";
import {
	decodeMarkerPayload,
	encodeMarkerPayload,
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

const hex = (text: string) => encodeMarkerPayload(text);
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
		["a character outside g-v", `${LOG_MARKER}zz`],
		["a hex digit (the alphabet has no digits)", `${LOG_MARKER}7b7d`],
		["an uppercase letter", `${LOG_MARKER}NR`],
		["an empty payload", LOG_MARKER],
		["an odd number of letters", `${LOG_MARKER}nrn`],
		["trailing garbage", `${LOG_MARKER}${hex("{}")} extra`],
		["bytes that are not UTF-8", `${LOG_MARKER}vv`],
		[
			"an oversize payload",
			`${LOG_MARKER}${"gg".repeat(MANIFEST_MAX_BYTES + 1)}`,
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
			`${LOG_MARKER}nrii***ng`,
			`${LOG_MARKER}***`,
			`${LOG_MARKER}${hex("{}")}***`,
		]) {
			const result = extractLogManifest([`${TS}${masked}`, good]);
			expect(result).toMatchObject({ ok: false, code: "masked" });
			if (!result.ok) {
				expect(result.message).toMatch(/masked/);
				expect(result.message).toMatch(/secret/);
				expect(result.message).toMatch(/digests/);
				expect(result.message).toMatch(/short secret/);
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

describe("the payload alphabet", () => {
	it("writes one letter per nibble, g for 0 to v for 15, high nibble first", () => {
		expect(encodeMarkerPayload("{")).toBe("nr"); // 0x7b
		expect(encodeMarkerPayload("ÿ")).toBe("sjrv"); // 0xc3 0xbf
	});
	it("never contains a digit or a letter a-f, whatever the manifest says", () => {
		const text = JSON.stringify({
			port: 5000,
			pin: "0123456789abcdef",
			u: "é✓",
		});
		expect(encodeMarkerPayload(text)).toMatch(/^[g-v]+$/);
	});
	it("round-trips text, and refuses anything the encoder would not write", () => {
		const text = 'az AZ 09 {}"\\ é✓\u{1f600}';
		expect(decodeMarkerPayload(encodeMarkerPayload(text))).toBe(text);
		expect(decodeMarkerPayload("")).toBeNull();
		expect(decodeMarkerPayload("n")).toBeNull();
		expect(decodeMarkerPayload("NR")).toBeNull();
		expect(decodeMarkerPayload("vv")).toBeNull();
	});
});

describe("releaseJobs", () => {
	const job = (patch: Record<string, unknown> = {}) => ({
		id: 1,
		runId: 10 as number | null,
		attempt: 1 as number | null,
		name: "ship",
		status: "completed",
		conclusion: "success" as string | null,
		headSha: "a".repeat(40) as string | null,
		runnerName: "runner-1" as string | null,
		stepNames: ["Run actions/checkout"],
		...patch,
	});
	const pick = (
		jobs: ReturnType<typeof job>[],
		extra: {
			releaseJobName?: string | null;
			hint?: { job?: string; runner?: string };
		} = {},
	) => {
		const result = releaseJobs({
			jobs,
			runId: 10,
			attempt: 1,
			headSha: "a".repeat(40),
			...extra,
		});
		return {
			preferred: result.preferred.map((j) => j.id),
			rest: result.rest.map((j) => j.id),
			overCap: result.overCap,
		};
	};

	it("with no hint and no job name, every successful job is a candidate, release-like ones first", () => {
		const result = pick([
			job({ id: 1, name: "build" }),
			job({ id: 2, name: "test" }),
			job({
				id: 3,
				name: "ship",
				stepNames: ["Run DevinoSolutions/dokploy-release@v1"],
			}),
			job({ id: 4, name: "Release prod" }),
		]);
		expect(result).toEqual({
			preferred: [],
			rest: [3, 4, 1, 2],
			overCap: false,
		});
	});

	it("narrowing only orders: the runner a hint names comes first, the others still follow", () => {
		const jobs = [
			job({ id: 1, runnerName: "r1" }),
			job({ id: 2, runnerName: "r2", name: "ship" }),
			job({ id: 3, runnerName: "r3", name: "other" }),
		];
		expect(pick(jobs, { hint: { runner: "r2" } })).toMatchObject({
			preferred: [2],
			rest: [1, 3],
		});
		expect(pick(jobs, { hint: { job: "other" } })).toMatchObject({
			preferred: [3],
			rest: [1, 2],
		});
		expect(pick(jobs, { hint: { runner: "r2", job: "other" } })).toMatchObject({
			preferred: [2],
		});
		// A hint that matches nothing narrows nothing.
		expect(pick(jobs, { hint: { runner: "nope", job: "nope" } })).toMatchObject(
			{ preferred: [], rest: [1, 2, 3] },
		);
	});

	it("an exact job name of the connection comes before the hint, and excludes nothing", () => {
		const jobs = [
			job({ id: 1, runnerName: "r1" }),
			job({ id: 2, name: "publish", runnerName: "r2" }),
		];
		expect(
			pick(jobs, { releaseJobName: "publish", hint: { runner: "r1" } }),
		).toMatchObject({ preferred: [2], rest: [1] });
		expect(pick(jobs, { releaseJobName: "none" })).toMatchObject({
			preferred: [],
			rest: [1, 2],
		});
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
		).toEqual({ preferred: [], rest: [], overCap: false });
	});

	it("keeps jobs whose run fields GitHub left out, and says when there are more than ten", () => {
		const jobs = Array.from({ length: 12 }, (_, i) =>
			job({ id: i + 1, runId: null, attempt: null, headSha: null }),
		);
		expect(MAX_LOG_JOBS).toBe(10);
		const result = pick(jobs);
		expect(result.rest).toHaveLength(12);
		expect(result.overCap).toBe(true);
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

	it("is the compact JSON of the manifest, one letter g-v per nibble", () => {
		const extracted = extractLogManifest([log]);
		if (!extracted.ok) throw new Error("no marker");
		expect(extracted.text).toBe(JSON.stringify(JSON.parse(extracted.text)));
		const line = log.split("\n").find((l) => l.includes(LOG_MARKER)) ?? "";
		expect(line.slice(line.indexOf(LOG_MARKER) + LOG_MARKER.length)).toBe(
			hex(extracted.text),
		);
	});

	it("never yields a manifest when the line is damaged", () => {
		const tampered = log.replace(`${LOG_MARKER}nrii`, `${LOG_MARKER}nrij`);
		expect(tampered).not.toBe(log);
		const extracted = extractLogManifest([tampered]);
		expect(extracted.ok ? parseReleaseManifest(extracted.text).ok : false).toBe(
			false,
		);
	});
});
