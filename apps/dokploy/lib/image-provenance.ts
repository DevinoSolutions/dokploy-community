// Pure classification for the image-restorability view: can a service's image
// be pulled back without rebuilding, and from which registry? No React / DB
// imports so the logic stays unit-testable.

/** The default registry when an image reference carries no host. */
export const DEFAULT_REGISTRY_HOST = "docker.io";

/**
 * Parse the registry host from a docker image reference, defaulting to
 * `docker.io` when none is present. Follows Docker's own rule: the first
 * path component is a registry host only when it contains a `.` or `:` or is
 * exactly `localhost` AND the reference has a `/`. Otherwise the first
 * component is a Docker Hub namespace/official image.
 *
 * Handles bare names (`nginx`), namespaced repos (`bitnami/nginx`), hosts
 * (`ghcr.io/acme/app`), host:port (`localhost:5000/app`), tags (`:1.2`) and
 * digests (`@sha256:...`). Returns null for empty input.
 */
export const parseRegistryHost = (
	imageRef: string | null | undefined,
): string | null => {
	const ref = imageRef?.trim();
	if (!ref) return null;
	const firstComponent = ref.split("/")[0] ?? "";
	const looksLikeHost =
		firstComponent === "localhost" ||
		firstComponent.includes(".") ||
		firstComponent.includes(":");
	if (ref.includes("/") && looksLikeHost) {
		return firstComponent;
	}
	return DEFAULT_REGISTRY_HOST;
};

/**
 * Image restorability of a service:
 * - `re-pullable`: the image is a ready reference (docker-source app, or a
 *   compose child with `image:`) — pull it back, no rebuild needed.
 * - `in-registry`: a source-built app that pushes to an assigned registry —
 *   the built image lives in that registry.
 * - `rebuild-only`: a source-built app with no registry, or a compose child
 *   with `build:` — the image exists only in the local docker daemon.
 */
export type ImageRestorability = "re-pullable" | "in-registry" | "rebuild-only";

/** Application source types that are built from source (vs. a docker image). */
export type ApplicationSourceType =
	| "docker"
	| "git"
	| "github"
	| "gitlab"
	| "bitbucket"
	| "gitea"
	| "drop";

export interface ApplicationProvenanceInput {
	sourceType: ApplicationSourceType;
	dockerImage: string | null;
	registryId: string | null;
}

export interface ApplicationProvenance {
	restorability: ImageRestorability;
	/** The image reference for docker-source apps. */
	image: string | null;
	/** Parsed registry host for docker-source apps. */
	registryHost: string | null;
}

/** Classify an application's image restorability from its source/registry. */
export const classifyApplicationProvenance = (
	app: ApplicationProvenanceInput,
): ApplicationProvenance => {
	if (app.sourceType === "docker") {
		return {
			restorability: "re-pullable",
			image: app.dockerImage ?? null,
			registryHost: parseRegistryHost(app.dockerImage),
		};
	}
	// Built from source: recoverable only if it is pushed to a registry.
	if (app.registryId) {
		return { restorability: "in-registry", image: null, registryHost: null };
	}
	return { restorability: "rebuild-only", image: null, registryHost: null };
};

export interface ComposeChildProvenance {
	restorability: Extract<ImageRestorability, "re-pullable" | "rebuild-only">;
	registryHost: string | null;
}

/**
 * Classify a compose child container by whether it declares an `image:`
 * (re-pullable) or is built from a `build:` context (rebuild-only). Mirrors the
 * `image` field returned by `extractComposeChildren`, where a build-only
 * service has no image.
 */
export const classifyComposeChildImage = (child: {
	image: string | null;
}): ComposeChildProvenance =>
	child.image
		? {
				restorability: "re-pullable",
				registryHost: parseRegistryHost(child.image),
			}
		: { restorability: "rebuild-only", registryHost: null };
