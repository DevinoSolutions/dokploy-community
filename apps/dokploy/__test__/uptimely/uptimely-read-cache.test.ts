import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getUptimelyBackoffUntil,
	invalidateUptimelyCache,
	isUptimelyQuotaError,
	readUptimelyCached,
	resetUptimelyCacheForTests,
	UPTIMELY_DEFAULT_BACKOFF_MS,
	UPTIMELY_READ_CACHE_TTL_MS,
	UptimelyQuotaError,
} from "@dokploy/server/utils/uptimely/read-cache";
import {
	parseRetryAfterMs,
	UptimelyError,
} from "@dokploy/server/utils/uptimely/client";

const scope = {
	organizationId: "org-1",
	uptimelyId: "upt-1",
	projectId: "proj-1",
	baseUrl: "https://uptimely.test",
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
	resetUptimelyCacheForTests();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("readUptimelyCached", () => {
	it("serves a second caller from the cache (one upstream call)", async () => {
		const fetcher = vi.fn(async () => ["m1"]);
		const a = await readUptimelyCached(scope, "list", fetcher);
		const b = await readUptimelyCached(scope, "list", fetcher);
		expect(a).toEqual(["m1"]);
		expect(b).toEqual(["m1"]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("shares one in-flight request between concurrent callers", async () => {
		let release: (v: string) => void = () => {};
		const fetcher = vi.fn(
			() => new Promise<string>((resolve) => (release = resolve)),
		);
		const first = readUptimelyCached(scope, "list", fetcher);
		const second = readUptimelyCached(scope, "list", fetcher);
		release("ok");
		expect(await Promise.all([first, second])).toEqual(["ok", "ok"]);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("refetches after the TTL expires", async () => {
		const fetcher = vi.fn(async () => "v");
		await readUptimelyCached(scope, "list", fetcher);
		vi.advanceTimersByTime(UPTIMELY_READ_CACHE_TTL_MS - 1);
		await readUptimelyCached(scope, "list", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2);
		await readUptimelyCached(scope, "list", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("does not cache failures", async () => {
		const fetcher = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new UptimelyError("boom"))
			.mockResolvedValueOnce("ok");
		await expect(readUptimelyCached(scope, "list", fetcher)).rejects.toThrow(
			"boom",
		);
		expect(await readUptimelyCached(scope, "list", fetcher)).toBe("ok");
	});

	it("keeps organizations, integrations, projects and names apart", async () => {
		const fetcher = vi.fn(async () => Math.random());
		const a = await readUptimelyCached(scope, "list", fetcher);
		const otherOrg = await readUptimelyCached(
			{ ...scope, organizationId: "org-2", uptimelyId: "upt-2" },
			"list",
			fetcher,
		);
		const otherProject = await readUptimelyCached(
			{ ...scope, projectId: "proj-2" },
			"list",
			fetcher,
		);
		const otherName = await readUptimelyCached(scope, "get|m1", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(new Set([a, otherOrg, otherProject, otherName]).size).toBe(4);
	});

	it("backs off on 429: serves cached data and never calls upstream again", async () => {
		await readUptimelyCached(scope, "list", async () => "cached");
		vi.advanceTimersByTime(UPTIMELY_READ_CACHE_TTL_MS + 1);
		const limited = vi.fn(async () => {
			throw new UptimelyError("limited", { code: 429, retryAfterMs: 120_000 });
		});

		expect(await readUptimelyCached(scope, "list", limited)).toBe("cached");
		expect(getUptimelyBackoffUntil(scope)).toBe(Date.now() + 120_000);

		const next = vi.fn(async () => "fresh");
		expect(await readUptimelyCached(scope, "list", next)).toBe("cached");
		expect(next).not.toHaveBeenCalled();
		expect(limited).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(120_001);
		expect(await readUptimelyCached(scope, "list", next)).toBe("fresh");
	});

	it("throws a quota error with the reset time when nothing is cached", async () => {
		const limited = vi.fn(async () => {
			throw new UptimelyError("over quota", { code: "QUOTA_EXHAUSTED" });
		});
		const error = await readUptimelyCached(scope, "list", limited).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(UptimelyQuotaError);
		expect(error.retryAt).toBe(Date.now() + UPTIMELY_DEFAULT_BACKOFF_MS);
		expect(error.message).toContain("quota exhausted");

		const other = vi.fn(async () => "x");
		await expect(readUptimelyCached(scope, "get|m2", other)).rejects.toThrow(
			UptimelyQuotaError,
		);
		expect(other).not.toHaveBeenCalled();
	});

	it("backoff is per integration", async () => {
		await readUptimelyCached(scope, "list", async () => {
			throw new UptimelyError("limited", { code: 429 });
		}).catch(() => {});
		const other = { ...scope, organizationId: "org-2", uptimelyId: "upt-2" };
		expect(getUptimelyBackoffUntil(other)).toBeNull();
		expect(await readUptimelyCached(other, "list", async () => "ok")).toBe(
			"ok",
		);
	});

	it("invalidate drops cached reads and the backoff for that integration only", async () => {
		const fetcher = vi.fn(async () => "v");
		const other = { ...scope, organizationId: "org-2", uptimelyId: "upt-2" };
		await readUptimelyCached(scope, "list", fetcher);
		await readUptimelyCached(other, "list", fetcher);
		invalidateUptimelyCache(scope);
		await readUptimelyCached(scope, "list", fetcher);
		await readUptimelyCached(other, "list", fetcher);
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
});

describe("isUptimelyQuotaError / parseRetryAfterMs", () => {
	it("recognises 429 and quota style codes only", () => {
		expect(isUptimelyQuotaError(new UptimelyError("x", { code: 429 }))).toBe(
			true,
		);
		expect(
			isUptimelyQuotaError(new UptimelyError("x", { code: "QUOTA_EXHAUSTED" })),
		).toBe(true);
		expect(
			isUptimelyQuotaError(new UptimelyError("x", { code: "RATE_LIMITED" })),
		).toBe(true);
		expect(isUptimelyQuotaError(new UptimelyError("x", { code: 401 }))).toBe(
			false,
		);
		expect(isUptimelyQuotaError(new Error("x"))).toBe(false);
	});

	it("reads Retry-After seconds, dates and reset headers", () => {
		const now = Date.parse("2026-10-23T12:00:00Z");
		const h = (o: Record<string, string>) => new Headers(o);
		expect(parseRetryAfterMs(h({ "retry-after": "30" }), now)).toBe(30_000);
		expect(
			parseRetryAfterMs(h({ "retry-after": "Fri, 23 Oct 2026 12:01:00 GMT" }), now),
		).toBe(60_000);
		expect(
			parseRetryAfterMs(h({ "x-ratelimit-reset": String(now / 1000 + 90) }), now),
		).toBe(90_000);
		expect(parseRetryAfterMs(h({}), now)).toBeUndefined();
	});
});
