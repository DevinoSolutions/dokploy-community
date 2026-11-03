import { normalizeBuildRunUrl, parseBuildRunUrl } from "../build-origin-shared";

/**
 * The payload a workflow puts on a GitHub Deployment to ask Dokploy to deploy:
 *
 *   {"dokploy":{"serviceId":"<id>","image":"<repo>@sha256:<64 hex>","runUrl":"<optional>"}}
 *
 * Pure parsing, no I/O. A deployment is only ever acted on when its payload
 * names THIS watch's service and carries an image pinned by digest.
 */

const DIGEST = /^sha256:[0-9a-f]{64}$/;

// repository part: optional host[:port], then one or more path segments. Lower
// case only (registries require it), no tag, no spaces, no shell characters.
const SEGMENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const HOST = "[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?";
const REPOSITORY = new RegExp(`^(?:${HOST}/)?${SEGMENT}(?:/${SEGMENT})*$`);

export type ParsedPayload =
	| { kind: "ignore"; reason: string }
	| { kind: "invalid"; reason: string }
	| {
			kind: "deploy";
			/** `<repository>@sha256:<hex>`, the only form that is ever deployed. */
			image: string;
			repository: string;
			digest: string;
			/** A github.com Actions run link, when the workflow sent a valid one. */
			buildRunUrl?: string;
	  };

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/**
 * GitHub returns the payload as the JSON object the workflow sent, or as a
 * string when the workflow sent a string. Accept both; anything else is not ours.
 */
export const readDeploymentPayload = (
	raw: unknown,
): Record<string, unknown> | null => {
	if (typeof raw === "string") {
		if (raw.length > 64 * 1024) return null;
		try {
			return asObject(JSON.parse(raw));
		} catch {
			return null;
		}
	}
	return asObject(raw);
};

/** Split `repo[:tag]@sha256:hex` into its parts; null when it is not pinned by digest. */
export const parsePinnedImage = (
	value: unknown,
): { image: string; repository: string; digest: string } | null => {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0 || text.length > 512) return null;
	const at = text.indexOf("@");
	if (at <= 0 || text.indexOf("@", at + 1) !== -1) return null;
	const digest = text.slice(at + 1);
	if (!DIGEST.test(digest)) return null;
	let repository = text.slice(0, at);
	// A tag next to the digest is allowed by registries but carries no weight:
	// the digest is what is deployed, so drop the tag.
	const lastSlash = repository.lastIndexOf("/");
	const lastColon = repository.lastIndexOf(":");
	if (lastColon > lastSlash) repository = repository.slice(0, lastColon);
	if (!REPOSITORY.test(repository)) return null;
	return { image: `${repository}@${digest}`, repository, digest };
};

/**
 * The run link a payload may carry: a valid github.com Actions run link (the
 * same check the deploy API applies, normalizeBuildRunUrl) of the repository
 * the watch follows. A link to another repository is dropped: it would put a
 * foreign run in the deployment's history as the build of this image.
 */
export const watchedRunUrl = (
	value: unknown,
	watched: { owner: string; repo: string },
): string | undefined => {
	const parts = parseBuildRunUrl(value);
	if (!parts) return undefined;
	if (
		parts.repository.toLowerCase() !==
		`${watched.owner}/${watched.repo}`.toLowerCase()
	) {
		return undefined;
	}
	return normalizeBuildRunUrl(value) ?? undefined;
};

/**
 * Classify one deployment for the watch of `serviceId`.
 *
 * - no `dokploy` key, or another service's id: "ignore" (another watch or a
 *   human's deployment; never answered, never failed).
 * - this service's id but a bad image: "invalid" (answered with a failure
 *   status, so the workflow waiting on it stops instead of hanging).
 */
export const parseDeploymentPayload = (
	raw: unknown,
	serviceId: string,
	watched: { owner: string; repo: string },
): ParsedPayload => {
	const payload = readDeploymentPayload(raw);
	const dokploy = asObject(payload?.dokploy);
	if (!dokploy) return { kind: "ignore", reason: "no dokploy payload" };
	if (
		typeof dokploy.serviceId !== "string" ||
		dokploy.serviceId !== serviceId
	) {
		return { kind: "ignore", reason: "payload names another service" };
	}
	const pinned = parsePinnedImage(dokploy.image);
	if (!pinned) {
		return {
			kind: "invalid",
			reason:
				"dokploy.image must be <repository>@sha256:<64 hex>; an image that is not pinned by digest is never deployed",
		};
	}
	const buildRunUrl = watchedRunUrl(
		dokploy.runUrl ?? dokploy.buildRunUrl,
		watched,
	);
	return {
		kind: "deploy",
		image: pinned.image,
		repository: pinned.repository,
		digest: pinned.digest,
		...(buildRunUrl ? { buildRunUrl } : {}),
	};
};
