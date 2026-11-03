/**
 * What a service's source type means for a deploy. A service that follows
 * GitHub Actions can carry the source type `github-actions` (the Provider tab
 * of the connection, PR 5): for a deploy it behaves as a Docker image source
 * for an application and as a stored file ("raw") for a compose stack.
 *
 * Kept here, small and local, so the poller never hard-codes `"docker"` or
 * `"raw"`. PR 5 (feat/gha-provider-t13879) brings the same mapping in
 * `provider.ts` (`deploySourceTypeOf`); when both are on canary, this file
 * becomes a re-export of that helper and nothing else changes.
 */

export type DeployServiceKind = "application" | "compose";

export const GITHUB_ACTIONS_SOURCE_TYPE = "github-actions";

export const deploySourceTypeOf = (
	row: { sourceType?: unknown },
	kind: DeployServiceKind,
): string | null => {
	if (row.sourceType === GITHUB_ACTIONS_SOURCE_TYPE) {
		return kind === "application" ? "docker" : "raw";
	}
	return typeof row.sourceType === "string" ? row.sourceType : null;
};
