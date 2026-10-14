import { TRPCError } from "@trpc/server";

export const RAILPACK_VERSIONS_CACHE_TTL = 1000 * 60 * 60 * 24;
const RAILPACK_VERSIONS_FETCH_TIMEOUT = 10_000;

let railpackVersionsCache:
	| { versions: string[]; fetchedAt: number }
	| undefined;

export const resetRailpackVersionsCache = () => {
	railpackVersionsCache = undefined;
};

/**
 * Lists Railpack releases from GitHub, cached for a day. When GitHub fails
 * (rate limit, outage, network error) the last known list is served even if it
 * has expired. With nothing cached it throws SERVICE_UNAVAILABLE, which is an
 * environment condition and not reported to Sentry like a 500.
 */
export const getRailpackVersions = async (): Promise<string[]> => {
	if (
		railpackVersionsCache &&
		Date.now() - railpackVersionsCache.fetchedAt < RAILPACK_VERSIONS_CACHE_TTL
	) {
		return railpackVersionsCache.versions;
	}

	try {
		const res = await fetch(
			"https://api.github.com/repos/railwayapp/railpack/releases",
			{
				headers: {
					Accept: "application/vnd.github+json",
					...(process.env.GITHUB_TOKEN
						? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
						: {}),
				},
				signal: AbortSignal.timeout(RAILPACK_VERSIONS_FETCH_TIMEOUT),
			},
		);
		if (!res.ok) {
			throw new Error(`GitHub responded with ${res.status}`);
		}
		const releases = (await res.json()) as Array<{ tag_name: string }>;
		const versions = releases.map((r) => r.tag_name.replace(/^v/i, ""));
		railpackVersionsCache = { versions, fetchedAt: Date.now() };
		return versions;
	} catch (error) {
		if (railpackVersionsCache) {
			console.warn(
				`[railpack] GitHub releases unavailable, serving cached versions: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return railpackVersionsCache.versions;
		}
		throw new TRPCError({
			code: "SERVICE_UNAVAILABLE",
			message:
				"Could not fetch Railpack versions from GitHub right now. Try again later or enter the version manually.",
			cause: error,
		});
	}
};
