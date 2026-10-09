/**
 * Pure helpers for the Docker image of a preview deployment
 * (`application.previewDockerImage`).
 *
 * An application whose source is a Docker image has no repository to clone, so
 * its previews pull an image that CI pushed for the change instead. The image
 * is a template that reuses the placeholder the preview environment already
 * understands (`${{preview.prNumber}}`), e.g.
 * `ghcr.io/acme/app:pr-${{preview.prNumber}}`.
 *
 * Kept free of server-only imports so the settings form can share the exact
 * rules the deploy path applies.
 */

export const PREVIEW_IMAGE_PLACEHOLDER = "${{preview.prNumber}}";

export const PREVIEW_IMAGE_GUIDANCE =
	"Use an image reference with the preview placeholder, for example ghcr.io/acme/app:pr-${{preview.prNumber}}";

export const PREVIEW_IMAGE_TEMPLATE_REQUIRED_MESSAGE =
	"Set a preview image template to enable previews for Docker-image apps";

// A tag or any identifier that ends up inside an image reference.
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_IMAGE_LENGTH = 512;

/**
 * The value that fills the placeholder. For git providers it is the pull
 * request number; for a Docker-image app it is whatever the user types (a PR
 * number, a branch slug, a build id). It becomes part of an image tag, so only
 * characters valid in a tag are accepted.
 */
export const isValidPreviewIdentifier = (value: string): boolean =>
	SAFE_IDENTIFIER.test(value);

/**
 * True for an empty/missing template (the feature is simply off) or a single
 * image reference without whitespace.
 */
export const isValidPreviewImageTemplate = (
	value: string | null | undefined,
): boolean => {
	if (!value) {
		return true;
	}
	return value.length <= MAX_IMAGE_LENGTH && !/\s/.test(value);
};

/**
 * Substitute the preview placeholder into the template. Returns `null` when no
 * template is set so the caller can raise its own error.
 */
export const resolvePreviewDockerImage = (
	template: string | null | undefined,
	identifier: string,
): string | null => {
	const trimmed = template?.trim();
	if (!trimmed) {
		return null;
	}
	if (!isValidPreviewImageTemplate(trimmed)) {
		throw new Error(`Invalid preview image template. ${PREVIEW_IMAGE_GUIDANCE}`);
	}
	if (!isValidPreviewIdentifier(identifier)) {
		throw new Error(
			`Invalid preview identifier "${identifier}": use letters, digits, ".", "_" or "-"`,
		);
	}
	return trimmed.replaceAll(PREVIEW_IMAGE_PLACEHOLDER, identifier);
};
