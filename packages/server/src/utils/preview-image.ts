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
	"Use an image reference with the preview placeholder in the tag only, for example ghcr.io/acme/app:pr-${{preview.prNumber}}";

export const PREVIEW_IDENTIFIER_GUIDANCE =
	"The preview identifier must be 1 to 63 letters, digits or '-', and start and end with a letter or digit";

export const PREVIEW_IMAGE_TEMPLATE_REQUIRED_MESSAGE =
	"Set a preview image template to enable previews for Docker-image apps";

// The identifier becomes an image tag *and* a hostname label (the preview
// domain template may use `${prNumber}`), so it is limited to what both allow:
// a DNS label of at most 63 characters. Dots and underscores are rejected on
// purpose: a dot lets the value reshape the registry host of a template.
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_IMAGE_LENGTH = 512;

/**
 * The value that fills the placeholder. For git providers it is the pull
 * request number; for a Docker-image app it is whatever the user types (a PR
 * number, a branch slug, a build id). It becomes part of an image tag and of a
 * hostname, so only a DNS label is accepted.
 */
export const isValidPreviewIdentifier = (value: string): boolean =>
	SAFE_IDENTIFIER.test(value);

/**
 * Why a preview image template is unusable, or `null` when it is fine. An
 * empty/missing template means the feature is off and is fine.
 *
 * The placeholder must appear exactly once and only in the tag (after the last
 * `:` that follows the last `/`, so a registry port such as `localhost:5000`
 * is not mistaken for the tag separator). Anywhere else a caller who may only
 * create previews could steer the pull to a host of their choosing, e.g.
 * `${{preview.prNumber}}/app:latest` with the identifier `evil.example.com`,
 * and the registry credentials of the application would follow.
 */
export const getPreviewImageTemplateError = (
	value: string | null | undefined,
): string | null => {
	if (!value) {
		return null;
	}
	if (value.length > MAX_IMAGE_LENGTH) {
		return `The preview image template must be at most ${MAX_IMAGE_LENGTH} characters`;
	}
	if (/\s/.test(value)) {
		return "The preview image template must be a single image reference without whitespace";
	}
	const occurrences = value.split(PREVIEW_IMAGE_PLACEHOLDER).length - 1;
	if (occurrences === 0) {
		return `The preview image template must contain ${PREVIEW_IMAGE_PLACEHOLDER} in the tag, otherwise every preview would pull the same image. ${PREVIEW_IMAGE_GUIDANCE}`;
	}
	if (occurrences > 1) {
		return `The preview image template must contain ${PREVIEW_IMAGE_PLACEHOLDER} exactly once, in the tag. ${PREVIEW_IMAGE_GUIDANCE}`;
	}
	const tagSeparator = value.lastIndexOf(":");
	if (
		tagSeparator <= value.lastIndexOf("/") ||
		value.indexOf(PREVIEW_IMAGE_PLACEHOLDER) < tagSeparator
	) {
		return `${PREVIEW_IMAGE_PLACEHOLDER} is only allowed in the image tag, not in the registry or repository. ${PREVIEW_IMAGE_GUIDANCE}`;
	}
	return null;
};

/**
 * True for an empty/missing template (the feature is simply off) or a single
 * image reference whose tag, and only its tag, holds the placeholder once.
 */
export const isValidPreviewImageTemplate = (
	value: string | null | undefined,
): boolean => getPreviewImageTemplateError(value) === null;

/** Prefix of `previewDeployment.pullRequestId` for Docker-image previews. */
export const DOCKER_PREVIEW_ID_PREFIX = "docker-";

/**
 * A preview row is tied to the kind of source it was created for: a Docker
 * preview has an image identifier but no branch to clone, a pull request
 * preview has a branch but no image. If the application's source type changed
 * since, redeploying would clone a branch named after an image tag (or pull an
 * image for a pull request), so refuse with a message that says what to do.
 * Returns `null` when the row matches the source.
 */
export const getPreviewSourceMismatchMessage = (
	isDockerSource: boolean,
	pullRequestId: string | null | undefined,
): string | null => {
	const isDockerRow = !!pullRequestId?.startsWith(DOCKER_PREVIEW_ID_PREFIX);
	if (isDockerRow && !isDockerSource) {
		return "This preview was created for a Docker-image source; recreate it after changing the source type";
	}
	if (!isDockerRow && isDockerSource) {
		return "This preview was created from a pull request; recreate it after changing the source type to Docker image";
	}
	return null;
};

/**
 * Substitute the preview placeholder into the template. Returns `null` when no
 * template is set so the caller can raise its own error. The template is
 * validated again here, so a value stored before these rules existed (or
 * written around the API) never reaches `docker pull`.
 */
export const resolvePreviewDockerImage = (
	template: string | null | undefined,
	identifier: string,
): string | null => {
	const trimmed = template?.trim();
	if (!trimmed) {
		return null;
	}
	const templateError = getPreviewImageTemplateError(trimmed);
	if (templateError) {
		throw new Error(`Invalid preview image template. ${templateError}`);
	}
	if (!isValidPreviewIdentifier(identifier)) {
		throw new Error(
			`Invalid preview identifier "${identifier}". ${PREVIEW_IDENTIFIER_GUIDANCE}`,
		);
	}
	return trimmed.replaceAll(PREVIEW_IMAGE_PLACEHOLDER, identifier);
};
