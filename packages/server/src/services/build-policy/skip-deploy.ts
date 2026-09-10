/**
 * `[skip deploy]` commit-message marker.
 *
 * Upstream already honours the GitHub Actions `[skip ci]` family, but only in
 * the GitHub App webhook and only to skip the whole delivery. This marker is
 * about the *deploy*, is honoured on every provider route, and is recorded in
 * the build-policy audit log so "why did my push not deploy" has an answer.
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
