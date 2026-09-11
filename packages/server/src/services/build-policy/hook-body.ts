import { BuildPolicyError } from "./errors";
import {
	assertSafeImageReference,
	buildDigestRef,
	isValidDigest,
	repositoryOf,
	splitRepositoryAndTag,
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
	/**
	 * Fully qualified repositories this unit may deploy, e.g.
	 * `ghcr.io/devinosolutions/sendly-web`. A host allowlist is not enough: it
	 * would let any deploy-hook token run any image on a registry the
	 * organization owns. Spec 5.2.9 restricts the body to the unit's own
	 * configured registry.
	 */
	allowedRepositories: string[],
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

	// There is deliberately no "must have a registry host" check here.
	//
	// It bought something when the allowlist was a *host* allowlist. It buys
	// nothing now that the comparison below is whole-repository equality: a
	// hostless reference can only pass if the allowed repository is itself
	// hostless, and then it is the same repository.
	//
	// Requiring a host was also actively wrong. `registryUrl` is
	// `notNull().default("")` and the empty string is the supported Docker Hub
	// configuration, not a misconfiguration, so `getRegistryTag` legitimately
	// returns `prefix/app` with no host. Round-2 nit N2 declined this as needing
	// an odd row; round-3 finding J showed that after the allowlist started
	// resolving through the organization default, an organization whose default
	// registry is Docker Hub had *every* unit's deploy-hook body rejected.
	const repository = repositoryOf(reference);
	if (!allowedRepositories.includes(repository)) {
		throw new BuildPolicyError(
			"REGISTRY_NOT_ALLOWED",
			`Deploy hook image "${reference}" resolves to repository "${repository}", ` +
				`which is not this unit's own repository (${allowedRepositories.join(", ") || "none configured"}).`,
			{ repository, allowedRepositories },
		);
	}

	const explicitTag =
		typeof tag === "string" && tag.trim().length > 0 ? tag.trim() : null;
	const embeddedTag = splitRepositoryAndTag(reference).tag;

	return {
		kind: "image",
		image: reference,
		tag: explicitTag ?? embeddedTag,
		digest,
		ref: buildDigestRef(reference, digest),
	};
};
