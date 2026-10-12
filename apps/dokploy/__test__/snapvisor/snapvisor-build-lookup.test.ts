import {
	classifySnapvisorError,
	createSnapvisorBuildLookup,
	isTerminalSnapvisorStatus,
	pickLatestSnapvisorBuild,
} from "@dokploy/server/utils/snapvisor/build-lookup";
import {
	createSnapvisorClient,
	parseRetryAfterSeconds,
	type SnapvisorBuild,
	SnapvisorError,
} from "@dokploy/server/utils/snapvisor/client";
import { describe, expect, it, vi } from "vitest";

/**
 * The cache in front of the per-commit build lookup is what keeps a long
 * deployments list from turning into one live Snapvisor call per row.
 */

const build = (status: SnapvisorBuild["status"]): SnapvisorBuild => ({
	id: "b1",
	number: 1,
	head: { sha: "a".repeat(40), branch: "main" },
	base: null,
	status,
	stats: null,
	url: "",
});

const clock = (start = 1_000_000) => {
	let at = start;
	return {
		now: () => at,
		advance: (ms: number) => {
			at += ms;
		},
	};
};

describe("createSnapvisorBuildLookup", () => {
	it("makes one call for many concurrent lookups of the same key", async () => {
		const lookup = createSnapvisorBuildLookup();
		const fetchBuild = vi.fn(async () => build("changes-detected"));

		const results = await Promise.all(
			Array.from({ length: 30 }, () => lookup.lookup("org:p:sha", fetchBuild)),
		);

		expect(fetchBuild).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.kind === "build")).toBe(true);
	});

	it("keeps separate keys separate", async () => {
		const lookup = createSnapvisorBuildLookup();
		const fetchBuild = vi.fn(async () => build("accepted"));
		await lookup.lookup("org-1:p:sha", fetchBuild);
		await lookup.lookup("org-2:p:sha", fetchBuild);
		await lookup.lookup("org-1:q:sha", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(3);
	});

	it("keeps a running or unreviewed build for 30s, then asks again", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => build("changes-detected"));

		await lookup.lookup("k", fetchBuild);
		time.advance(29_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(2_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("keeps a finished build for 10 minutes", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => build("accepted"));

		await lookup.lookup("k", fetchBuild);
		time.advance(9 * 60_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(2 * 60_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("caches 'no build yet' briefly", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => null);

		await expect(lookup.lookup("k", fetchBuild)).resolves.toEqual({
			kind: "none",
		});
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(31_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("turns a failure into a value and caches it for a minute", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => {
			throw new SnapvisorError("rejected", { status: 401 });
		});

		await expect(lookup.lookup("k", fetchBuild)).resolves.toEqual({
			kind: "unavailable",
			reason: "auth",
		});
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(61_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("honours a longer Retry-After on a 429", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => {
			throw new SnapvisorError("slow down", {
				status: 429,
				retryAfterSeconds: 300,
			});
		});

		await expect(lookup.lookup("k", fetchBuild)).resolves.toEqual({
			kind: "unavailable",
			reason: "rate-limited",
		});
		time.advance(4 * 60_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(2 * 60_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("caps how long a Retry-After can keep a failure cached at ten minutes", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => {
			throw new SnapvisorError("slow down", {
				status: 429,
				retryAfterSeconds: 24 * 60 * 60,
			});
		});

		await lookup.lookup("k", fetchBuild);
		time.advance(9 * 60_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(2 * 60_000);
		await lookup.lookup("k", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("never throws, whatever the fetcher throws", async () => {
		const lookup = createSnapvisorBuildLookup();
		await expect(
			lookup.lookup("k", async () => {
				throw "not even an Error";
			}),
		).resolves.toEqual({ kind: "unavailable", reason: "unreachable" });
	});

	it("lets a forced refresh through, but not more than once per 5s", async () => {
		const time = clock();
		const lookup = createSnapvisorBuildLookup({ now: time.now });
		const fetchBuild = vi.fn(async () => build("pending"));

		await lookup.lookup("k", fetchBuild);
		await lookup.lookup("k", fetchBuild, { force: true });
		expect(fetchBuild).toHaveBeenCalledTimes(1);

		time.advance(6_000);
		await lookup.lookup("k", fetchBuild, { force: true });
		expect(fetchBuild).toHaveBeenCalledTimes(2);
		await lookup.lookup("k", fetchBuild, { force: true });
		expect(fetchBuild).toHaveBeenCalledTimes(2);
	});

	it("shares one in-flight call between a forced and a normal lookup", async () => {
		const lookup = createSnapvisorBuildLookup();
		let release: (b: SnapvisorBuild) => void = () => {};
		const fetchBuild = vi.fn(
			() =>
				new Promise<SnapvisorBuild>((resolve) => {
					release = resolve;
				}),
		);
		const first = lookup.lookup("k", fetchBuild);
		const second = lookup.lookup("k", fetchBuild, { force: true });
		release(build("accepted"));
		await Promise.all([first, second]);
		expect(fetchBuild).toHaveBeenCalledTimes(1);
	});

	it("is bounded: the oldest entries are dropped", async () => {
		const lookup = createSnapvisorBuildLookup({ maxEntries: 3 });
		const fetchBuild = vi.fn(async () => build("accepted"));
		for (const key of ["a", "b", "c", "d"]) {
			await lookup.lookup(key, fetchBuild);
		}
		expect(lookup.size()).toBe(3);

		await lookup.lookup("a", fetchBuild);
		expect(fetchBuild).toHaveBeenCalledTimes(5);
	});
});

describe("classifySnapvisorError", () => {
	it.each([
		[401, "auth"],
		[403, "auth"],
		[429, "rate-limited"],
		[404, "project"],
		[500, "unreachable"],
		[undefined, "unreachable"],
	])("status %s is %s", (status, reason) => {
		expect(classifySnapvisorError(new SnapvisorError("x", { status }))).toBe(
			reason,
		);
	});

	it("treats anything else as unreachable", () => {
		expect(classifySnapvisorError(new TypeError("fetch failed"))).toBe(
			"unreachable",
		);
	});
});

describe("isTerminalSnapvisorStatus", () => {
	it.each([
		"accepted",
		"rejected",
		"no-changes",
		"error",
		"aborted",
		"expired",
	] as const)("%s is terminal", (status) => {
		expect(isTerminalSnapvisorStatus(status)).toBe(true);
	});

	it.each(["pending", "progress", "changes-detected"] as const)(
		"%s is not terminal",
		(status) => {
			expect(isTerminalSnapvisorStatus(status)).toBe(false);
		},
	);
});

describe("Retry-After", () => {
	it("parses seconds and HTTP dates, and ignores junk", () => {
		expect(parseRetryAfterSeconds("30")).toBe(30);
		expect(parseRetryAfterSeconds(" 7 ")).toBe(7);
		expect(parseRetryAfterSeconds("0")).toBeUndefined();
		expect(parseRetryAfterSeconds("soon")).toBeUndefined();
		expect(parseRetryAfterSeconds(null)).toBeUndefined();
		const now = Date.parse("2026-10-11T12:00:00Z");
		expect(parseRetryAfterSeconds("Sun, 11 Oct 2026 12:01:00 GMT", now)).toBe(
			60,
		);
		expect(
			parseRetryAfterSeconds("Sun, 11 Oct 2026 11:00:00 GMT", now),
		).toBeUndefined();
	});

	it("the client surfaces a 429 with its Retry-After", async () => {
		const client = createSnapvisorClient({
			baseUrl: "https://api.snapvisor.io",
			accessToken: "tok",
			fetchImpl: (async () => ({
				ok: false,
				status: 429,
				headers: {
					get: (name: string) => (name === "retry-after" ? "45" : null),
				},
				text: async () => "",
			})) as unknown as typeof fetch,
		});

		await expect(
			client.listBuilds({ accountSlug: "t", projectName: "p", headSha: "x" }),
		).rejects.toMatchObject({ status: 429, retryAfterSeconds: 45 });
	});
});

describe("pickLatestSnapvisorBuild", () => {
	const numbered = (number: number): SnapvisorBuild => ({
		...build("changes-detected"),
		id: `b${number}`,
		number,
	});

	it("picks the highest build number whatever order the page came in", () => {
		expect(
			pickLatestSnapvisorBuild([numbered(3), numbered(9), numbered(5)])?.number,
		).toBe(9);
		expect(
			pickLatestSnapvisorBuild([numbered(1), numbered(2), numbered(3)])?.number,
		).toBe(3);
		expect(
			pickLatestSnapvisorBuild([numbered(3), numbered(2), numbered(1)])?.number,
		).toBe(3);
	});

	it("returns the only build, and null for none", () => {
		expect(pickLatestSnapvisorBuild([numbered(4)])?.number).toBe(4);
		expect(pickLatestSnapvisorBuild([])).toBeNull();
	});
});
