export type PreviewDeploymentSource = "github" | "gitlab" | "gitea";

export const supportsPreviewDeployments = (
	sourceType: string | null | undefined,
): sourceType is PreviewDeploymentSource =>
	sourceType === "github" ||
	sourceType === "gitlab" ||
	sourceType === "gitea";

/**
 * Applications can also preview a Docker image: there is no repository to
 * clone, so the preview pulls the image named by the preview image template.
 * Compose services have no such source, hence the separate predicate.
 */
export const supportsApplicationPreviewDeployments = (
	sourceType: string | null | undefined,
): boolean => supportsPreviewDeployments(sourceType) || sourceType === "docker";
