export type PreviewDeploymentSource = "github" | "gitlab";

export const supportsPreviewDeployments = (
	sourceType: string | null | undefined,
): sourceType is PreviewDeploymentSource =>
	sourceType === "github" || sourceType === "gitlab";
