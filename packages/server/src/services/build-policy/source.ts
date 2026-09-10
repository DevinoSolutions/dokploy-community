/**
 * "Is this unit sourced from github.com?"
 *
 * Upstream has no such helper: `deriveGithubApiUrl` compares a *provider*
 * `githubUrl`, never a unit's `customGitUrl`. Enterprise hosts are deliberately
 * excluded — they use a different API base and are not what the org build
 * policy is about.
 */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

const extractHost = (rawUrl: string): string | null => {
	const url = rawUrl.trim();
	if (!url) return null;

	// scp-like syntax: git@github.com:owner/repo.git
	const scpLike = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/.exec(url);
	if (scpLike?.[1]) return scpLike[1].toLowerCase();

	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
};

export const isGithubHostUrl = (url: string | null | undefined): boolean => {
	if (typeof url !== "string") return false;
	const host = extractHost(url);
	return host !== null && GITHUB_HOSTS.has(host);
};

export interface GithubSourceInput {
	sourceType: string;
	customGitUrl?: string | null;
}

export const isGithubSourcedUnit = ({
	sourceType,
	customGitUrl,
}: GithubSourceInput): boolean => {
	if (sourceType === "github") return true;
	if (sourceType === "git") return isGithubHostUrl(customGitUrl);
	return false;
};

/**
 * `owner/repo` for a github.com git URL, so a `sourceType: "git"` unit can
 * still be check-gated. Returns null for anything else.
 */
export const parseGithubOwnerRepo = (
	url: string | null | undefined,
): { owner: string; repo: string } | null => {
	if (!isGithubHostUrl(url) || typeof url !== "string") return null;
	const withoutSuffix = url.trim().replace(/\.git$/, "");
	const path = withoutSuffix.includes("://")
		? new URL(withoutSuffix).pathname
		: (withoutSuffix.split(":")[1] ?? "");
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) return null;
	const [owner, repo] = segments;
	if (!owner || !repo) return null;
	return { owner, repo };
};
