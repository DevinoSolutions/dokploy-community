// What a pinned Dokploy update may install. The repo is fixed here, so a caller
// only ever picks a release tag or a digest inside it, never another image.
export const DOKPLOY_IMAGE_REPO = "ghcr.io/devinosolutions/dokploy-community";

export const DOKPLOY_RELEASE_TAG_REGEX =
	/^v\d+\.\d+\.\d+(-community\.\d+(\.\d+)?)?$/;

export const DOKPLOY_IMAGE_DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;

// Older releases install another image from their own Update Server button, or
// predate migrations that dropped columns the current schema no longer has, so
// pinning one strands the install. A migration after 0206 that drops, renames
// or tightens something must move this up (see the drizzle scan test).
export const DOKPLOY_MIN_PINNED_VERSION = "v0.30.8-community.1";

// A tag is pinned by its digest when it is pulled. A digest is only taken on
// its own, as the recorded rollback: nothing proves which version any other
// digest is, so it could get past the floor.
export type DokployUpdateTarget =
	| { tag: string; digest?: undefined }
	| { tag?: undefined; digest: string };

/** A release tag or a bare digest; null for anything else. */
export const parseDokployUpdateTarget = (
	target: string,
): DokployUpdateTarget | null => {
	if (DOKPLOY_RELEASE_TAG_REGEX.test(target)) {
		return { tag: target };
	}
	if (DOKPLOY_IMAGE_DIGEST_REGEX.test(target)) {
		return { digest: target };
	}
	return null;
};

export const isDokployUpdateTarget = (target: string) =>
	parseDokployUpdateTarget(target) !== null;

const versionParts = (version: string) => {
	const match = /^v(\d+)\.(\d+)\.(\d+)(?:-community\.(\d+)(?:\.(\d+))?)?$/.exec(
		version,
	);
	return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
};

/**
 * Orders release tags by X.Y.Z, then community.N, then .N. A tag without the
 * community suffix is the upstream base, so it sorts before community.1.
 * Returns null when either side is not a release tag.
 */
export const compareDokployVersions = (a: string, b: string) => {
	const left = versionParts(a);
	const right = versionParts(b);
	if (!left || !right) {
		return null;
	}
	for (let i = 0; i < left.length; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) {
			return Math.sign(diff);
		}
	}
	return 0;
};

export const isBelowDokployPinFloor = (tag: string) =>
	(compareDokployVersions(tag, DOKPLOY_MIN_PINNED_VERSION) ?? -1) < 0;

/** `repo:<tag>` or `repo@sha256:<hex>`. */
export const dokployUpdateImage = (target: DokployUpdateTarget) => {
	if (target.tag !== undefined) {
		return `${DOKPLOY_IMAGE_REPO}:${target.tag}`;
	}
	return `${DOKPLOY_IMAGE_REPO}@${target.digest}`;
};

/** The image for a valid target, otherwise null. */
export const resolveDokployUpdateImage = (target: string): string | null => {
	const parsed = parseDokployUpdateTarget(target);
	return parsed ? dokployUpdateImage(parsed) : null;
};
