import { describe, expect, it } from "vitest";
import { supportsPreviewDeployments } from "@/lib/preview-deployments";

describe("supportsPreviewDeployments", () => {
	it.each(["github", "gitlab"])("accepts the %s provider", (sourceType) => {
		expect(supportsPreviewDeployments(sourceType)).toBe(true);
	});

	it.each(["bitbucket", "docker", "drop", "git", "gitea", null, undefined])(
		"rejects the %s provider",
		(sourceType) => {
			expect(supportsPreviewDeployments(sourceType)).toBe(false);
		},
	);
});
