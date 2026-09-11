import { BuildPolicyError } from "./errors";

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
 *
 * The fallback is real, not decorative: `saveGitProvider` sets
 * `sourceType: "git"` without clearing `githubId`, so a unit moved from the
 * GitHub App to a plain git remote keeps a usable installation token. A unit
 * that never had an App connection cannot be check-gated at all, which is what
 * `describeRequiredChecksSupport` below exists to say up front.
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

/**
 * Can this unit's `requiredChecks` ever be satisfied?
 *
 * Round-2 review finding F. Reading a commit's checks needs three things, and
 * before this only the first two were tested — at deploy time, after the image
 * had already been built, tagged and pushed:
 *
 * 1. the unit is sourced from github.com (`isGithubSourcedUnit`);
 * 2. an `owner`/`repo` can be resolved, from the unit's own columns for a
 *    GitHub App unit or from its `customGitUrl` for a plain git remote;
 * 3. a GitHub App installation exists to read them with — `githubId`. The
 *    checks and statuses endpoints are authenticated; there is no anonymous
 *    path, so a unit with no App connection can never pass the gate.
 *
 * Callers use this at the API boundary, so an operator who configures a check
 * on a unit that cannot honour it is told immediately rather than discovering
 * it one wasted build at a time.
 */
export interface RequiredChecksSupportInput extends GithubSourceInput {
	unitName: string;
	githubId?: string | null;
	owner?: string | null;
	repository?: string | null;
}

export type RequiredChecksSupport =
	| { supported: true }
	| { supported: false; reason: string };

export const describeRequiredChecksSupport = (
	unit: RequiredChecksSupportInput,
): RequiredChecksSupport => {
	const name = unit.unitName;

	if (!isGithubSourcedUnit(unit)) {
		return {
			supported: false,
			reason:
				`Required checks cannot be used on "${name}": they are read from the ` +
				"GitHub checks and commit-statuses APIs, and this unit is not sourced " +
				"from github.com. Clear the required checks, or connect the unit to a " +
				"github.com repository.",
		};
	}

	if (!unit.githubId) {
		return {
			supported: false,
			reason:
				`Required checks cannot be used on "${name}": reading a commit's ` +
				"checks needs an authenticated GitHub App installation, and this unit " +
				"is not connected to one. Connect a GitHub App provider on the unit's " +
				"Git tab, or clear the required checks.",
		};
	}

	const hasOwnerRepo =
		(unit.sourceType === "github" && !!unit.owner && !!unit.repository) ||
		parseGithubOwnerRepo(unit.customGitUrl) !== null;

	if (!hasOwnerRepo) {
		return {
			supported: false,
			reason:
				`Required checks cannot be used on "${name}": its owner and ` +
				"repository could not be determined, so there is no commit to read " +
				"checks for. Reconnect the repository, or clear the required checks.",
		};
	}

	return { supported: true };
};

/**
 * Throws when a non-empty `requiredChecks` is being written to a unit that can
 * never satisfy it. Setting an empty list is always allowed, so an operator can
 * always clear a unit out of an unsupported state.
 */
export const assertRequiredChecksSupported = (
	unit: RequiredChecksSupportInput,
	requiredChecks: string[] | null | undefined,
): void => {
	const wanted = (requiredChecks ?? []).filter(
		(check) => typeof check === "string" && check.trim().length > 0,
	);
	if (wanted.length === 0) return;

	const support = describeRequiredChecksSupport(unit);
	if (support.supported) return;

	throw new BuildPolicyError("REQUIRED_CHECKS_UNSUPPORTED", support.reason, {
		unitName: unit.unitName,
		requiredChecks: wanted,
	});
};

/**
 * The same assertion for a partial update, where the patch may be changing the
 * source fields in the very call that sets the checks. A field absent from the
 * patch keeps its stored value; a field explicitly set to null in the patch is
 * honoured as null, which is why this cannot be written with `??`.
 */
export const assertRequiredChecksSupportedForUpdate = (
	current: RequiredChecksSupportInput,
	patch: Partial<RequiredChecksSupportInput> & {
		requiredChecks?: string[] | null;
	},
): void => {
	const pick = <K extends keyof RequiredChecksSupportInput>(
		key: K,
	): RequiredChecksSupportInput[K] =>
		patch[key] !== undefined
			? (patch[key] as RequiredChecksSupportInput[K])
			: current[key];

	assertRequiredChecksSupported(
		{
			unitName: pick("unitName"),
			sourceType: pick("sourceType"),
			githubId: pick("githubId"),
			owner: pick("owner"),
			repository: pick("repository"),
			customGitUrl: pick("customGitUrl"),
		},
		patch.requiredChecks,
	);
};
