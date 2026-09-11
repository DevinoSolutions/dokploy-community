import { BuildPolicyError } from "./errors";

/**
 * Image reference helpers for build-once: tag `<app>:<sha>`, publish the
 * digest out of the remote build shell, deploy by digest.
 */

/** Placeholder the build shell substitutes with `git rev-parse HEAD`. */
export const SHA_PLACEHOLDER = "__DOKPLOY_BUILD_SHA__";

/**
 * Line the build script echoes so the digest can be read back out of the
 * deployment log. The build runs as a detached shell on the build server whose
 * only channel back is that log file.
 */
export const DIGEST_MARKER = "__DOKPLOY_IMAGE_DIGEST__";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Shell/registry-unsafe characters that must never reach a docker command. */
const UNSAFE_REF_RE = /[^A-Za-z0-9._:/@-]/;

export const isValidDigest = (digest: unknown): digest is string =>
	typeof digest === "string" && DIGEST_RE.test(digest);

export const imageTagForSha = (appName: string, sha?: string | null): string =>
	`${appName}:${sha && sha.length > 0 ? sha : SHA_PLACEHOLDER}`;

/** Split a reference into its repository part and its tag, if any. */
export const splitRepositoryAndTag = (
	reference: string,
): { repository: string; tag: string | null } => {
	const lastSlash = reference.lastIndexOf("/");
	const lastColon = reference.lastIndexOf(":");
	// A colon before the last slash belongs to a host:port, not a tag.
	if (lastColon > lastSlash) {
		return {
			repository: reference.slice(0, lastColon),
			tag: reference.slice(lastColon + 1),
		};
	}
	return { repository: reference, tag: null };
};

/** The repository part of a reference: no tag, no digest. */
export const repositoryOf = (reference: string): string =>
	splitRepositoryAndTag(reference.split("@")[0] ?? reference).repository;

export const registryHostOf = (reference: string): string | null => {
	const firstSlash = reference.indexOf("/");
	if (firstSlash === -1) return null;
	const candidate = reference.slice(0, firstSlash);
	if (!candidate.includes(".") && !candidate.includes(":")) return null;
	return candidate;
};

export const buildDigestRef = (reference: string, digest: string): string => {
	if (!isValidDigest(digest)) {
		throw new BuildPolicyError(
			"INVALID_DIGEST",
			`Not a valid image digest: ${String(digest)}`,
			{ digest },
		);
	}
	const withoutDigest = reference.split("@")[0] ?? reference;
	const { repository } = splitRepositoryAndTag(withoutDigest);
	return `${repository}@${digest}`;
};

export const assertSafeImageReference = (reference: string): void => {
	if (
		typeof reference !== "string" ||
		reference.length === 0 ||
		UNSAFE_REF_RE.test(reference)
	) {
		throw new BuildPolicyError(
			"INVALID_IMAGE",
			`Not a valid image reference: ${String(reference)}`,
			{ reference },
		);
	}
};

const markerLines = (log: string | null | undefined): string[] => {
	if (typeof log !== "string" || log.length === 0) return [];
	return log
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith(DIGEST_MARKER));
};

/** `__DOKPLOY_IMAGE_DIGEST__ <fullTag> <digest>` — last one wins. */
const lastMarkerParts = (
	log: string | null | undefined,
): { tag: string; digest: string } | null => {
	const lines = markerLines(log);
	for (let i = lines.length - 1; i >= 0; i--) {
		const parts = (lines[i] as string).split(/\s+/);
		const tag = parts[1];
		const digest = parts[2];
		if (tag && isValidDigest(digest)) return { tag, digest };
	}
	return null;
};

export const parseImageDigestFromLog = (
	log: string | null | undefined,
): string | null => lastMarkerParts(log)?.digest ?? null;

export const parseImageTagFromLog = (
	log: string | null | undefined,
): string | null => lastMarkerParts(log)?.tag ?? null;
