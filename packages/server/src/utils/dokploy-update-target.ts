// What a pinned Dokploy update may install. The repo is fixed here, so a caller
// only ever picks a release tag or a digest inside it, never another image.
export const DOKPLOY_IMAGE_REPO = "ghcr.io/devinosolutions/dokploy-community";

export const DOKPLOY_RELEASE_TAG_REGEX =
	/^v\d+\.\d+\.\d+(-community\.\d+(\.\d+)?)?$/;

export const DOKPLOY_IMAGE_DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/;

// Older releases install another image from their own Update Server button, or
// predate migrations that dropped columns the current schema no longer has, so
// pinning one strands the install.
export const DOKPLOY_MIN_PINNED_VERSION = "v0.30.8-community.1";

export type DokployUpdateTarget =
	| { tag: string; digest?: string }
	| { tag?: undefined; digest: string };

/** A release tag, `<tag>@sha256:<hex>`, or a bare digest; null for anything else. */
export const parseDokployUpdateTarget = (
	target: string,
): DokployUpdateTarget | null => {
	if (DOKPLOY_RELEASE_TAG_REGEX.test(target)) {
		return { tag: target };
	}
	if (DOKPLOY_IMAGE_DIGEST_REGEX.test(target)) {
		return { digest: target };
	}
	const at = target.indexOf("@");
	const tag = target.slice(0, at);
	const digest = target.slice(at + 1);
	if (
		at > 0 &&
		DOKPLOY_RELEASE_TAG_REGEX.test(tag) &&
		DOKPLOY_IMAGE_DIGEST_REGEX.test(digest)
	) {
		return { tag, digest };
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

/** `repo:<tag>`, `repo:<tag>@sha256:<hex>` or `repo@sha256:<hex>`. */
export const dokployUpdateImage = (target: DokployUpdateTarget) => {
	if (target.tag !== undefined && target.digest !== undefined) {
		return `${DOKPLOY_IMAGE_REPO}:${target.tag}@${target.digest}`;
	}
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
