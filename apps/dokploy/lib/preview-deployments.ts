export type PreviewDeploymentSource = "github" | "gitlab" | "gitea";

export const supportsPreviewDeployments = (
	sourceType: string | null | undefined,
): sourceType is PreviewDeploymentSource =>
	sourceType === "github" ||
	sourceType === "gitlab" ||
	sourceType === "gitea";
