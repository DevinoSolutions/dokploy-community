/**
 * `[skip deploy]` commit-message marker.
 *
 * Upstream already honours the GitHub Actions `[skip ci]` family, but only in
 * the GitHub App webhook and only to skip the whole delivery. This marker is
 * about the *deploy*, and it is recorded in the build-policy audit log so "why
 * did my push not deploy" has an answer.
 *
 * It is honoured wherever `buildPolicyDeployGate` is wired, which is every
 * **push**-triggered enqueue site: the GitHub App webhook
 * (`pages/api/deploy/github.ts`), the GitLab webhook (`gitlab.ts`) and both
 * deploy-hook routes (`[refreshToken].ts` and `compose/[refreshToken].ts`,
 * which is also how Gitea, Bitbucket and Soft Serve arrive). It is **not**
 * honoured on the two tag-push branches or on preview deployments, because
 * neither carries a commit message the marker could be written into. Keep this
 * list accurate: a marker that is silently ignored on one route is worse than
 * one that does not exist.
 */
export const SKIP_DEPLOY_MARKERS = [
	"[skip deploy]",
	"[deploy skip]",
	"[no deploy]",
] as const;

export const hasSkipDeployMarker = (
	message: string | null | undefined,
): boolean => {
	if (typeof message !== "string" || message.length === 0) return false;
	const haystack = message.toLowerCase();
	return SKIP_DEPLOY_MARKERS.some((marker) => haystack.includes(marker));
};

export const matchedSkipDeployMarker = (
	message: string | null | undefined,
): string | null => {
	if (typeof message !== "string" || message.length === 0) return null;
	const haystack = message.toLowerCase();
	return (
		SKIP_DEPLOY_MARKERS.find((marker) => haystack.includes(marker)) ?? null
	);
};
