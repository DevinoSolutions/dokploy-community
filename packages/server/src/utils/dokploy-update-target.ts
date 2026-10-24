// What a pinned Dokploy update may install. The repo is fixed here, so a caller
// only ever picks a release tag or a digest inside it, never another image.
export const DOKPLOY_IMAGE_REPO = "ghcr.io/devinosolutions/dokploy-community";

export const DOKPLOY_RELEASE_TAG_REGEX =
	/^v\d+\.\d+\.\d+(-community\.\d+(\.\d+)?)?$/;

export const DOKPLOY_IMAGE_DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;

export const isDokployUpdateTarget = (target: string) =>
	DOKPLOY_RELEASE_TAG_REGEX.test(target) ||
	DOKPLOY_IMAGE_DIGEST_REGEX.test(target);

/** `repo:<tag>` or `repo@sha256:<hex>` for a valid target, otherwise null. */
export const resolveDokployUpdateImage = (target: string): string | null => {
	if (DOKPLOY_RELEASE_TAG_REGEX.test(target)) {
		return `${DOKPLOY_IMAGE_REPO}:${target}`;
	}
	if (DOKPLOY_IMAGE_DIGEST_REGEX.test(target)) {
		return `${DOKPLOY_IMAGE_REPO}@${target}`;
	}
	return null;
};
