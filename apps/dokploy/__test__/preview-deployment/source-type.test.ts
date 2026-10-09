import { describe, expect, it } from "vitest";
import {
	supportsApplicationPreviewDeployments,
	supportsPreviewDeployments,
} from "@/lib/preview-deployments";

describe("supportsPreviewDeployments", () => {
	it.each(["github", "gitlab", "gitea"])(
		"accepts the %s provider",
		(sourceType) => {
			expect(supportsPreviewDeployments(sourceType)).toBe(true);
		},
	);

	it.each(["bitbucket", "docker", "drop", "git", null, undefined])(
		"rejects the %s provider",
		(sourceType) => {
			expect(supportsPreviewDeployments(sourceType)).toBe(false);
		},
	);
});

describe("supportsApplicationPreviewDeployments", () => {
	it.each(["github", "gitlab", "gitea", "docker"])(
		"accepts the %s source",
		(sourceType) => {
			expect(supportsApplicationPreviewDeployments(sourceType)).toBe(true);
		},
	);

	it.each(["bitbucket", "drop", "git", null, undefined])(
		"rejects the %s source",
		(sourceType) => {
			expect(supportsApplicationPreviewDeployments(sourceType)).toBe(false);
		},
	);
});
