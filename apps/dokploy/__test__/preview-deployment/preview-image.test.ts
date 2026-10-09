import { apiUpdateApplication } from "@dokploy/server/db/schema";
import {
	isValidPreviewIdentifier,
	isValidPreviewImageTemplate,
	PREVIEW_IMAGE_PLACEHOLDER,
	resolvePreviewDockerImage,
} from "@dokploy/server/utils/preview-image";
import { describe, expect, it } from "vitest";

describe("resolvePreviewDockerImage", () => {
	it("fills the preview placeholder", () => {
		expect(
			resolvePreviewDockerImage("ghcr.io/acme/app:pr-${{preview.prNumber}}", "42"),
		).toBe("ghcr.io/acme/app:pr-42");
	});

	it("fills every occurrence", () => {
		expect(
			resolvePreviewDockerImage(
				"reg.io/${{preview.prNumber}}/app:${{preview.prNumber}}",
				"7",
			),
		).toBe("reg.io/7/app:7");
	});

	it("leaves a template without a placeholder untouched", () => {
		expect(resolvePreviewDockerImage("ghcr.io/acme/app:staging", "42")).toBe(
			"ghcr.io/acme/app:staging",
		);
	});

	it("trims the template", () => {
		expect(
			resolvePreviewDockerImage("  app:pr-${{preview.prNumber}}\n", "9"),
		).toBe("app:pr-9");
	});

	it.each([null, undefined, "", "   "])(
		"returns null when the template is %j",
		(template) => {
			expect(resolvePreviewDockerImage(template, "42")).toBeNull();
		},
	);

	it("rejects a template that is not a single image reference", () => {
		expect(() =>
			resolvePreviewDockerImage("app:pr-1 --privileged", "42"),
		).toThrow("Invalid preview image template");
	});

	it.each(["", "a b", "1;rm", "$(id)", "../x", "-1", "a/b", "x".repeat(129)])(
		"rejects the identifier %j",
		(identifier) => {
			expect(() => resolvePreviewDockerImage("app:${{preview.prNumber}}", identifier)).toThrow(
				"Invalid preview identifier",
			);
		},
	);

	it("is the placeholder the preview environment already uses", () => {
		expect(PREVIEW_IMAGE_PLACEHOLDER).toBe("${{preview.prNumber}}");
	});
});

describe("isValidPreviewIdentifier", () => {
	it.each(["42", "pr-42", "v1.2.3", "feature_login", "sha-abc123"])(
		"accepts %s",
		(value) => {
			expect(isValidPreviewIdentifier(value)).toBe(true);
		},
	);

	it.each(["", " 42", "4 2", "a:b", "a@sha256", "é"])("rejects %j", (value) => {
		expect(isValidPreviewIdentifier(value)).toBe(false);
	});
});

describe("isValidPreviewImageTemplate", () => {
	it("treats empty as off", () => {
		expect(isValidPreviewImageTemplate("")).toBe(true);
		expect(isValidPreviewImageTemplate(null)).toBe(true);
	});

	it("rejects whitespace and absurd lengths", () => {
		expect(isValidPreviewImageTemplate("a b")).toBe(false);
		expect(isValidPreviewImageTemplate("a".repeat(513))).toBe(false);
	});
});

describe("application update schema", () => {
	it("accepts, clears and validates previewDockerImage", () => {
		const parse = (previewDockerImage: unknown) =>
			apiUpdateApplication.safeParse({
				applicationId: "app-1",
				previewDockerImage,
			});

		expect(parse("ghcr.io/acme/app:pr-${{preview.prNumber}}").success).toBe(true);
		expect(parse(null).success).toBe(true);
		expect(parse("two words").success).toBe(false);
	});
});
