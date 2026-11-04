/**
 * What a service's source type means for a deploy. A service that follows
 * GitHub Actions can carry the source type `github-actions` (the Provider tab
 * of the connection, PR 5): for a deploy it behaves as a Docker image source
 * for an application and as a stored file ("raw") for a compose stack.
 *
 * Kept here, small and local, so the poller never hard-codes `"docker"` or
 * `"raw"`. PR 5 (feat/gha-provider-t13879) brings the same mapping in
 * `provider.ts` with the same signature, `deploySourceTypeOf(kind, sourceType)`.
 * This file is NOT in the gha-connect barrel, so the two never collide; once
 * #601 is on canary it becomes a re-export of provider.ts and call sites stay.
 */

type DeployServiceKind = "application" | "compose";

const GITHUB_ACTIONS_SOURCE_TYPE = "github-actions";

export const deploySourceTypeOf = (
	kind: DeployServiceKind,
	sourceType: unknown,
): string | null => {
	if (sourceType === GITHUB_ACTIONS_SOURCE_TYPE) {
		return kind === "application" ? "docker" : "raw";
	}
	return typeof sourceType === "string" ? sourceType : null;
};
