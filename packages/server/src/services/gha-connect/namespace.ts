/**
 * Which image repositories a connection may deploy. Pure.
 *
 * A release may only name images in the connection's own namespace, and once
 * a service runs an image it may only move to new digests of the repositories
 * it already runs. `<repo>/preview/*` belongs to pull request previews and is
 * refused for a service release, the first one included.
 */

const lower = (value: string) => value.trim().toLowerCase();

export interface NamespaceInput {
	/** GitHub owner of the connected repository. */
	owner: string;
	/** Name of the connected repository (without the owner). */
	repo: string;
	/**
	 * Where mirrored images live, as written in the images of a release:
	 * host[:port][/path]. The tunnel mirror's is `localhost:5000/registry.devino.ca`.
	 */
	registryPrefix: string | null;
}

/** A registry prefix without case or trailing slashes. */
export const normalizePrefix = (prefix: string) =>
	lower(prefix).replace(/\/+$/, "");

/** Repository prefixes (always ending in "/") a release of this connection may use. */
export const allowedNamespaces = (input: NamespaceInput): string[] => {
	const repo = lower(input.repo);
	const namespaces = [`ghcr.io/${lower(input.owner)}/${repo}/`];
	if (input.registryPrefix) {
		namespaces.push(`${normalizePrefix(input.registryPrefix)}/${repo}/`);
	}
	return namespaces;
};

/**
 * The GHCR repository a mirrored image was copied from, or null when the
 * repository is not under the prefix. The mirror step copies
 * `ghcr.io/<owner>/<repo>/<service>` to `<prefix>/<repo>/<service>`, so the name
 * after the prefix is the name after the owner. Provenance and, in phase 3,
 * retention use it; acceptance does not depend on it.
 */
export const canonicalRepository = (input: {
	repository: string;
	owner: string;
	registryPrefix: string | null;
}): string | null => {
	if (!input.registryPrefix) return null;
	const prefix = `${normalizePrefix(input.registryPrefix)}/`;
	const repository = lower(input.repository);
	if (!repository.startsWith(prefix)) return null;
	return `ghcr.io/${lower(input.owner)}/${repository.slice(prefix.length)}`;
};

export type RepositoryCheck =
	| { ok: true }
	| {
			ok: false;
			code: "image-namespace" | "image-repository";
			message: string;
	  };

/**
 * @param repository the image repository named by the release, e.g. `registry.devino.ca/shorty/web`
 * @param currentRepositories the repositories the service runs now (empty before its first image)
 */
export const checkImageRepository = (input: {
	repository: string;
	namespaces: string[];
	currentRepositories: string[];
}): RepositoryCheck => {
	const repository = lower(input.repository);
	const namespace = input.namespaces.find((ns) => repository.startsWith(ns));
	if (!namespace) {
		return {
			ok: false,
			code: "image-namespace",
			message: `${input.repository} is outside this connection's registry namespace (${input.namespaces.join(", ")})`,
		};
	}
	if (repository.slice(namespace.length).startsWith("preview/")) {
		return {
			ok: false,
			code: "image-namespace",
			message: `${input.repository} belongs to pull request previews, which a service release never uses`,
		};
	}
	const current = input.currentRepositories.map(lower);
	if (current.length > 0 && !current.includes(repository)) {
		return {
			ok: false,
			code: "image-repository",
			message: `${input.repository} is not an image this service runs (${input.currentRepositories.join(", ")})`,
		};
	}
	return { ok: true };
};

/** `host/path` split at the first segment; null for Docker Hub style names that have no host. */
export const splitRepository = (
	repository: string,
): { host: string; name: string } | null => {
	const slash = repository.indexOf("/");
	if (slash <= 0) return null;
	const host = repository.slice(0, slash);
	if (!host.includes(".") && !host.includes(":") && host !== "localhost") {
		return null;
	}
	return { host: host.toLowerCase(), name: repository.slice(slash + 1) };
};
