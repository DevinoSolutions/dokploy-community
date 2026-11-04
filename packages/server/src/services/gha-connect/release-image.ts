import {
	listPinnedComposeRepositories,
	runningImageRepository,
} from "../github-deployments/service-image";
import {
	allowedNamespaces,
	type NamespaceInput,
	normalizePrefix,
} from "./namespace";

/**
 * The image repository a GitHub Actions release pins for a service: ONE derivation, used by the generated workflow
 * (what it builds and pushes), by the status panel (the "Image" row) and by Connect (which refuses a service that
 * runs an image no release could ever replace). Pure.
 *
 * The rule it mirrors is acceptance's (`checkImageRepository`): a release may only name images inside the
 * connection's namespaces, and once the service runs an image it may only move to new digests of that repository.
 * So:
 * - a running repository INSIDE the namespaces is the image: the workflow pushes that repository, the panel shows it;
 * - a running repository OUTSIDE them can never be replaced by a release: Connect refuses it, naming the namespace;
 * - nothing running yet (or, for compose, nothing pinned in a namespace): the image is expected to be
 *   `<namespace>/<service key>`, a guess the panel labels as such.
 */

const lower = (value: string) => value.trim().toLowerCase();

export type ReleaseImageInput = NamespaceInput & {
	kind: "application" | "compose";
	serviceKey: string;
	/** An application's current image reference (a Docker image source), if any. */
	dockerImage?: string | null;
	/** A compose stack's stored file; the lines that pin an image by digest are the running images. */
	composeFile?: string | null;
};

/** The name a workflow built for this connection pushes when the service runs nothing of its own yet. */
export const expectedImageRepository = (
	input: NamespaceInput & { serviceKey: string },
): string => {
	const repo = lower(input.repo);
	const key = lower(input.serviceKey);
	return input.registryPrefix
		? `${normalizePrefix(input.registryPrefix)}/${repo}/${key}`
		: `ghcr.io/${lower(input.owner)}/${repo}/${key}`;
};

/** Whether a release of this connection may name the repository (inside a namespace, not a preview image). */
export const isInsideNamespaces = (
	repository: string,
	namespaces: readonly string[],
): boolean => {
	const value = lower(repository);
	const namespace = namespaces.find((ns) => value.startsWith(ns));
	if (!namespace) return false;
	const rest = value.slice(namespace.length);
	return rest !== "" && !rest.startsWith("preview/");
};

export type ReleaseImage =
	| {
			ok: true;
			repositories: string[];
			/** `running`: what the service runs now. `expected`: a guess at `<namespace>/<service key>`. */
			source: "running" | "expected";
	  }
	| {
			ok: false;
			running: string;
			namespaces: string[];
			message: string;
	  };

export const outsideNamespaceMessage = (
	running: string,
	namespaces: readonly string[],
): string => {
	const where = namespaces.join(" or ");
	return `This service runs ${running}, which is outside ${where}. A release can only pin images under ${where}; switch the service to an image there first, or pick the registry prefix that matches.`;
};

export const deriveReleaseImage = (input: ReleaseImageInput): ReleaseImage => {
	const namespaces = allowedNamespaces(input);
	const expected = expectedImageRepository(input);
	if (input.kind === "application") {
		const running = runningImageRepository(input.dockerImage);
		if (!running) {
			return { ok: true, repositories: [expected], source: "expected" };
		}
		if (isInsideNamespaces(running, namespaces)) {
			return { ok: true, repositories: [running], source: "running" };
		}
		return {
			ok: false,
			running,
			namespaces,
			message: outsideNamespaceMessage(running, namespaces),
		};
	}
	// A compose stack pins several images, some of them never a release's (a database): only the pinned images
	// inside the namespaces are the ones a release moves, and none being there is no reason to refuse.
	const inside = listPinnedComposeRepositories(input.composeFile ?? "").filter(
		(repository) => isInsideNamespaces(repository, namespaces),
	);
	return inside.length > 0
		? { ok: true, repositories: inside, source: "running" }
		: { ok: true, repositories: [expected], source: "expected" };
};
