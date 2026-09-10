import { BuildPolicyError } from "./errors";
import {
	assertSafeImageReference,
	buildDigestRef,
	isValidDigest,
	registryHostOf,
} from "./image";

/**
 * Optional deploy-hook body `{image, tag, digest}` (spec 5.2.9).
 *
 * When present the deploy skips the build entirely and deploys that image by
 * digest. The image must live on a registry this organization has configured,
 * so a deploy hook token cannot be turned into "run any image on my swarm".
 */
export type DeployHookImage =
	| { kind: "none" }
	| {
			kind: "image";
			image: string;
			tag: string | null;
			digest: string;
			ref: string;
	  };

const asRecord = (body: unknown): Record<string, unknown> | null =>
	body !== null && typeof body === "object" && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: null;

export const parseDeployHookImage = (
	body: unknown,
	allowedRegistryHosts: string[],
): DeployHookImage => {
	const record = asRecord(body);
	if (!record) return { kind: "none" };
	if (record.image === undefined || record.image === null) {
		return { kind: "none" };
	}

	const { image, tag, digest } = record;

	if (typeof image !== "string" || image.trim().length === 0) {
		throw new BuildPolicyError(
			"INVALID_IMAGE",
			"Deploy hook body has an `image` that is not a non-empty string.",
		);
	}
	const reference = image.trim();
	assertSafeImageReference(reference);

	if (!isValidDigest(digest)) {
		throw new BuildPolicyError(
			"INVALID_DIGEST",
			"Deploy hook body must carry a `digest` of the form sha256:<64 hex chars>; " +
				"build-policy deploys are always by digest.",
		);
	}

	const host = registryHostOf(reference);
	if (!host) {
		throw new BuildPolicyError(
			"REGISTRY_NOT_ALLOWED",
			`Deploy hook image "${reference}" has no registry host. It must be fully ` +
				"qualified and point at a registry configured on this organization.",
		);
	}
	if (!allowedRegistryHosts.includes(host)) {
		throw new BuildPolicyError(
			"REGISTRY_NOT_ALLOWED",
			`Deploy hook image "${reference}" is on registry "${host}", which is not ` +
				"configured on this organization.",
			{ host, allowedRegistryHosts },
		);
	}

	const explicitTag =
		typeof tag === "string" && tag.trim().length > 0 ? tag.trim() : null;
	const embeddedTag = (() => {
		const lastSlash = reference.lastIndexOf("/");
		const lastColon = reference.lastIndexOf(":");
		return lastColon > lastSlash ? reference.slice(lastColon + 1) : null;
	})();

	return {
		kind: "image",
		image: reference,
		tag: explicitTag ?? embeddedTag,
		digest,
		ref: buildDigestRef(reference, digest),
	};
};
