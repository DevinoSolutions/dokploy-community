import { deploySourceTypeOf } from "../gha-connect/provider";
import type { ParsedPayload } from "./payload";

/**
 * Which image a watch may put on its service, and how it is written into the
 * service. Pure: the caller does the database writes.
 *
 * The rule that keeps a repository admin from running arbitrary images: the
 * deployment can only move the service to another DIGEST OF THE REPOSITORY IT
 * ALREADY RUNS (application: its current dockerImage; compose: the one pinned
 * `image:` line). A service that has no image yet may only take one under
 * ghcr.io/<owner>/ of the watched repository's owner.
 */

type Deploy = Extract<ParsedPayload, { kind: "deploy" }>;

export type ImageDecision =
	| { ok: true; dockerImage: string }
	| { ok: false; reason: string };

const lower = (value: string) => value.toLowerCase();

/** `host/path[:tag][@digest]` to `host/path`. */
export const repositoryOfReference = (reference: string): string => {
	const withoutDigest = reference.split("@")[0] ?? reference;
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	return lastColon > lastSlash
		? withoutDigest.slice(0, lastColon)
		: withoutDigest;
};

export const decideApplicationImage = (
	application: { sourceType: string; dockerImage: string | null },
	payload: Deploy,
	owner: string,
): ImageDecision => {
	// A service that follows GitHub Actions (T-13879) deploys an image like a Docker image service.
	if (deploySourceTypeOf("application", application.sourceType) !== "docker") {
		return {
			ok: false,
			reason:
				"This application does not deploy a Docker image (its source is not Docker), so a GitHub deployment cannot set one.",
		};
	}
	const current = application.dockerImage?.trim();
	if (current) {
		if (lower(repositoryOfReference(current)) !== lower(payload.repository)) {
			return {
				ok: false,
				reason: `The image repository ${payload.repository} is not the one this application runs (${repositoryOfReference(current)}).`,
			};
		}
	} else if (
		!lower(payload.repository).startsWith(`ghcr.io/${lower(owner)}/`)
	) {
		return {
			ok: false,
			reason: `The application has no image yet, so only ghcr.io/${lower(owner)}/... images are accepted.`,
		};
	}
	return { ok: true, dockerImage: payload.image };
};

/**
 * Whether a compose stack keeps its file in Dokploy, so a release may move the digest in it: a stored (raw) file, or a
 * stack that follows GitHub Actions (T-13879), whose file stays stored.
 */
export const isStoredComposeSource = (sourceType: string): boolean =>
	deploySourceTypeOf("compose", sourceType) === "raw";

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ComposePin =
	| { ok: true; composeFile: string; previousDigest: string; changed: boolean }
	| { ok: false; reason: string };

/**
 * Replace the digest on the single `image: <repository>@sha256:<hex>` line of a
 * compose file, touching nothing else (the same rule as the `render` step of
 * the dokploy-deploy action's deploy.sh).
 */
export const pinComposeImage = (
	composeFile: string,
	repository: string,
	digest: string,
): ComposePin => {
	const repo = escapeRegExp(repository);
	const line = new RegExp(
		String.raw`^[ \t]*(?:-[ \t]*)?image:[ \t]*["']?${repo}@(sha256:[0-9a-f]{64})(?=["'\s#]|$)`,
		"gm",
	);
	const matches = [...composeFile.matchAll(line)];
	if (matches.length !== 1) {
		return {
			ok: false,
			reason:
				matches.length === 0
					? `The compose file has no 'image: ${repository}@sha256:...' line. Pin it by digest once, then deployments can move it.`
					: `The compose file has ${matches.length} 'image: ${repository}@sha256:...' lines; exactly one is required.`,
		};
	}
	const previousDigest = matches[0]?.[1] as string;
	if (previousDigest === digest) {
		return { ok: true, composeFile, previousDigest, changed: false };
	}
	const oldRef = `${repository}@${previousDigest}`;
	const parts = composeFile.split(oldRef);
	if (parts.length !== 2) {
		return {
			ok: false,
			reason: `The reference ${oldRef} must appear exactly once in the compose file.`,
		};
	}
	return {
		ok: true,
		composeFile: parts.join(`${repository}@${digest}`),
		previousDigest,
		changed: true,
	};
};

const SERVICE_KEY =
	/^([A-Za-z0-9][A-Za-z0-9._-]*|"[^"]+"|'[^']+')[ \t]*:[ \t]*(?:#.*)?$/;

/**
 * The compose service whose `image:` line pins `repository` by digest, or null
 * when the line is not found inside the top-level `services:` block (an
 * unusual layout: the caller then refuses rather than guesses).
 */
export const composeServiceOfImage = (
	composeFile: string,
	repository: string,
): string | null => {
	const image = new RegExp(
		String.raw`^[ \t]*(?:-[ \t]*)?image:[ \t]*["']?${escapeRegExp(repository)}@sha256:[0-9a-f]{64}(?=["'\s#]|$)`,
	);
	const lines = composeFile.split(/\r?\n/);
	let inServices = false;
	let childIndent: number | null = null;
	let current: string | null = null;
	for (const line of lines) {
		if (/^[ \t]*(#.*)?$/.test(line)) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) {
			inServices = /^services[ \t]*:[ \t]*(#.*)?$/.test(line);
			childIndent = null;
			current = null;
			continue;
		}
		if (!inServices) continue;
		if (childIndent === null) childIndent = indent;
		if (indent === childIndent) {
			const key = SERVICE_KEY.exec(line.trim());
			current = key ? (key[1] as string).replace(/^["']|["']$/g, "") : null;
			continue;
		}
		if (image.test(line)) return current;
	}
	return null;
};

/**
 * Pin several images of one compose file (a release that built more than one
 * image). Every repository must appear on exactly one `image:` line, as for
 * `pinComposeImage`, and each repository may be named once. An image that names
 * its compose service (the manifest always does) is pinned only on the line of
 * that service: a digest never moves another service's image.
 */
export const pinComposeImages = (
	composeFile: string,
	images: Array<{
		repository: string;
		digest: string;
		composeService?: string | null;
	}>,
): ComposePin => {
	const seen = new Set<string>();
	let file = composeFile;
	let changed = false;
	let previousDigest = "";
	for (const image of images) {
		const key = lower(image.repository);
		if (seen.has(key)) {
			return {
				ok: false,
				reason: `The release names ${image.repository} twice.`,
			};
		}
		seen.add(key);
		if (image.composeService) {
			const holder = composeServiceOfImage(file, image.repository);
			if (holder !== image.composeService) {
				return {
					ok: false,
					reason: holder
						? `The release puts ${image.repository} on the compose service '${image.composeService}', but the compose file has it on '${holder}'.`
						: `The release puts ${image.repository} on the compose service '${image.composeService}', but that image line is not inside the services block of the compose file.`,
				};
			}
		}
		const pinned = pinComposeImage(file, image.repository, image.digest);
		if (!pinned.ok) return pinned;
		file = pinned.composeFile;
		changed = changed || pinned.changed;
		if (previousDigest === "") previousDigest = pinned.previousDigest;
	}
	return { ok: true, composeFile: file, previousDigest, changed };
};

/**
 * The repositories a compose file pins by digest (`image: <repository>@sha256:...`),
 * each once. Before the first release there are none.
 */
export const listPinnedComposeRepositories = (
	composeFile: string,
): string[] => {
	const line =
		/^[ \t]*(?:-[ \t]*)?image:[ \t]*["']?([^\s"'#@]+)@sha256:[0-9a-f]{64}(?=["'\s#]|$)/gm;
	return [
		...new Set(
			[...composeFile.matchAll(line)].map((match) =>
				repositoryOfReference(match[1] as string),
			),
		),
	];
};
