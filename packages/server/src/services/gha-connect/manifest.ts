import { parsePinnedImage } from "../github-deployments/payload";

/**
 * The release manifest (`dokploy.release/v1`): a small JSON file that the
 * `DevinoSolutions/dokploy-release` action uploads as the run artifact
 * `dokploy-release`. The schema and its fixtures live with the action; this
 * parser is the fork's copy of the contract (the fixtures are vendored under
 * apps/dokploy/__test__/gha-connect/fixtures and a test fails when the two
 * drift). Pure: no I/O.
 *
 * Unknown minor fields are ignored. An unknown major version is refused.
 * Phase 1 refuses every manifest that asks for a migration command.
 */

export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MANIFEST_ARTIFACT_NAME = "dokploy-release";

const SCHEMA = /^dokploy\.release\/v(\d+)(?:\.\d+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_ID = /^[0-9]{1,18}$/;
const COMPOSE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMPOSE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;

export interface ManifestImage {
	name: string;
	composeService: string;
	/** `<repository>@sha256:<64 hex>`, never a tag. */
	ref: string;
	repository: string;
	digest: string;
}

export interface ManifestService {
	key: string;
	images: ManifestImage[];
	composePath: string | null;
}

export interface ReleaseManifest {
	schema: string;
	sha: string;
	delivery: "pull" | "push";
	releaseId: string;
	releaseServices: string[];
	source: { forge: "github"; ref: string; runId: string; runAttempt: number };
	environment: string;
	services: ManifestService[];
}

export type ManifestFailure =
	| "invalid-json"
	| "unknown-schema"
	| "invalid"
	| "migrations-unsupported";

export type ManifestParse =
	| { ok: true; manifest: ReleaseManifest }
	| { ok: false; code: ManifestFailure; message: string };

const fail = (code: ManifestFailure, message: string): ManifestParse => ({
	ok: false,
	code,
	message,
});

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const asString = (value: unknown, pattern: RegExp): string | null =>
	typeof value === "string" && pattern.test(value) ? value : null;

const parseImage = (value: unknown, where: string): ManifestImage | string => {
	const image = asObject(value);
	if (!image) return `${where} must be an object`;
	const name = asString(image.name, COMPOSE_SERVICE);
	if (!name) return `${where}.name is missing or malformed`;
	const composeService = asString(image.composeService, COMPOSE_SERVICE);
	if (!composeService) return `${where}.composeService is missing or malformed`;
	const pinned = parsePinnedImage(image.ref);
	if (!pinned) {
		return `${where}.ref must be <repository>@sha256:<64 hex>; an image that is not pinned by digest is never deployed`;
	}
	// A tag next to the digest is dropped by parsePinnedImage; the manifest
	// contract is stricter: the ref must already be in canonical form.
	if (pinned.image !== image.ref) {
		return `${where}.ref must not carry a tag`;
	}
	return {
		name,
		composeService,
		ref: pinned.image,
		repository: pinned.repository,
		digest: pinned.digest,
	};
};

export const parseReleaseManifest = (
	input: string | unknown,
): ManifestParse => {
	let raw: unknown = input;
	if (typeof input === "string") {
		if (Buffer.byteLength(input, "utf8") > MANIFEST_MAX_BYTES) {
			return fail("invalid", "The manifest is larger than 64 KiB");
		}
		try {
			raw = JSON.parse(input);
		} catch {
			return fail("invalid-json", "The manifest is not valid JSON");
		}
	}
	const root = asObject(raw);
	if (!root) return fail("invalid", "The manifest must be a JSON object");

	if (typeof root.schema !== "string") {
		return fail("unknown-schema", "The manifest has no schema field");
	}
	const schema = SCHEMA.exec(root.schema);
	if (!schema || schema[1] !== "1") {
		return fail(
			"unknown-schema",
			`Unsupported manifest schema ${root.schema.slice(0, 40)}; this Dokploy reads dokploy.release/v1`,
		);
	}

	const sha = asString(root.sha, SHA);
	if (!sha) return fail("invalid", "sha must be a 40 character lowercase hex");
	if (root.delivery !== "pull" && root.delivery !== "push") {
		return fail("invalid", 'delivery must be "pull" or "push"');
	}
	const delivery = root.delivery;

	const release = asObject(root.release);
	const releaseId = asString(release?.id, RELEASE_ID);
	if (!release || !releaseId) {
		return fail("invalid", "release.id is missing or malformed");
	}
	if (!Array.isArray(release.services) || release.services.length === 0) {
		return fail("invalid", "release.services must list at least one key");
	}
	const releaseServices: string[] = [];
	for (const key of release.services) {
		const valid = asString(key, KEY);
		if (!valid) return fail("invalid", "release.services has a malformed key");
		if (releaseServices.includes(valid)) {
			return fail("invalid", `release.services repeats ${valid}`);
		}
		releaseServices.push(valid);
	}

	const source = asObject(root.source);
	if (
		!source ||
		source.forge !== "github" ||
		typeof source.ref !== "string" ||
		!source.ref.startsWith("refs/heads/") ||
		source.ref.length > 300
	) {
		return fail("invalid", "source must name forge github and a branch ref");
	}
	const runId = asString(source.runId, RUN_ID);
	if (!runId) return fail("invalid", "source.runId must be a decimal string");
	const runAttempt = source.runAttempt;
	if (
		typeof runAttempt !== "number" ||
		!Number.isSafeInteger(runAttempt) ||
		runAttempt < 1
	) {
		return fail("invalid", "source.runAttempt must be a positive integer");
	}

	if (
		typeof root.environment !== "string" ||
		root.environment.length === 0 ||
		root.environment.length > 255
	) {
		return fail("invalid", "environment is missing or too long");
	}

	if (!Array.isArray(root.services) || root.services.length === 0) {
		return fail("invalid", "services must list at least one service");
	}
	const services: ManifestService[] = [];
	for (const [index, entry] of root.services.entries()) {
		const where = `services[${index}]`;
		const service = asObject(entry);
		if (!service) return fail("invalid", `${where} must be an object`);
		const key = asString(service.key, KEY);
		if (!key) return fail("invalid", `${where}.key is missing or malformed`);
		if (services.some((s) => s.key === key)) {
			return fail("invalid", `${where}.key ${key} appears twice`);
		}
		if (service.migrations !== undefined && service.migrations !== null) {
			return fail(
				"migrations-unsupported",
				`${where} asks for a migration command; this Dokploy does not run migrations yet`,
			);
		}
		if (!Array.isArray(service.images) || service.images.length === 0) {
			return fail("invalid", `${where}.images must list at least one image`);
		}
		const images: ManifestImage[] = [];
		for (const [imageIndex, imageValue] of service.images.entries()) {
			const parsed = parseImage(imageValue, `${where}.images[${imageIndex}]`);
			if (typeof parsed === "string") return fail("invalid", parsed);
			if (images.some((i) => i.composeService === parsed.composeService)) {
				return fail(
					"invalid",
					`${where} has two images for ${parsed.composeService}`,
				);
			}
			images.push(parsed);
		}
		let composePath: string | null = null;
		if (service.compose !== undefined && service.compose !== null) {
			const compose = asObject(service.compose);
			const path = asString(compose?.path, COMPOSE_PATH);
			if (!path || path.includes("..")) {
				return fail("invalid", `${where}.compose.path is malformed`);
			}
			composePath = path;
		}
		services.push({ key, images, composePath });
	}

	const listed = [...releaseServices].sort().join("\n");
	const present = services
		.map((s) => s.key)
		.sort()
		.join("\n");
	if (listed !== present) {
		return fail("invalid", "release.services and services[].key must match");
	}

	return {
		ok: true,
		manifest: {
			schema: root.schema,
			sha,
			delivery,
			releaseId,
			releaseServices,
			source: { forge: "github", ref: source.ref, runId, runAttempt },
			environment: root.environment,
			services,
		},
	};
};
