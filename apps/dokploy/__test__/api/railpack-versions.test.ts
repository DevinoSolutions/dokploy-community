import {
	getRailpackVersions,
	RAILPACK_VERSIONS_CACHE_TTL,
	resetRailpackVersionsCache,
} from "@/server/api/utils/railpack-versions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const okResponse = (tags: string[]) =>
	({
		ok: true,
		status: 200,
		json: async () => tags.map((tag_name) => ({ tag_name })),
	}) as Response;

const failResponse = () => ({ ok: false, status: 403 }) as Response;

describe("getRailpackVersions", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		resetRailpackVersionsCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns the releases with the leading v stripped", async () => {
		fetchMock.mockResolvedValueOnce(okResponse(["v0.2.1", "0.2.0"]));
		await expect(getRailpackVersions()).resolves.toEqual(["0.2.1", "0.2.0"]);
	});

	it("serves the stale cached list when GitHub answers with an error", async () => {
		fetchMock.mockResolvedValueOnce(okResponse(["v0.2.1"]));
		await getRailpackVersions();
		vi.advanceTimersByTime(RAILPACK_VERSIONS_CACHE_TTL + 1000);
		fetchMock.mockResolvedValueOnce(failResponse());
		await expect(getRailpackVersions()).resolves.toEqual(["0.2.1"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("serves the stale cached list when fetch throws", async () => {
		fetchMock.mockResolvedValueOnce(okResponse(["v0.2.1"]));
		await getRailpackVersions();
		vi.advanceTimersByTime(RAILPACK_VERSIONS_CACHE_TTL + 1000);
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		await expect(getRailpackVersions()).resolves.toEqual(["0.2.1"]);
	});

	it("throws SERVICE_UNAVAILABLE without a cache when GitHub answers with an error", async () => {
		fetchMock.mockResolvedValueOnce(failResponse());
		await expect(getRailpackVersions()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
	});

	it("throws SERVICE_UNAVAILABLE without a cache when fetch throws", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network down"));
		await expect(getRailpackVersions()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
	});
});
