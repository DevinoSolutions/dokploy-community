import { apiUpdateApplication } from "@dokploy/server/db/schema";
import {
	getPreviewImageTemplateError,
	getPreviewSourceMismatchMessage,
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

	it("fills the placeholder behind a registry port", () => {
		expect(
			resolvePreviewDockerImage("localhost:5000/app:pr-${{preview.prNumber}}", "7"),
		).toBe("localhost:5000/app:pr-7");
	});

	it.each([
		["a placeholder in the registry part", "${{preview.prNumber}}/app:latest"],
		["a placeholder in the repository", "ghcr.io/${{preview.prNumber}}/app:latest"],
		["a placeholder in the repository name", "ghcr.io/org/app-${{preview.prNumber}}:latest"],
		["no placeholder", "ghcr.io/acme/app:staging"],
		["two placeholders", "reg.io/app:${{preview.prNumber}}-${{preview.prNumber}}"],
		["the placeholder in the registry and the tag", "reg.io/${{preview.prNumber}}/app:${{preview.prNumber}}"],
	])("never pulls a stored template with %s", (_name, template) => {
		expect(() =>
			resolvePreviewDockerImage(template, "evil.example.com"),
		).toThrow("Invalid preview image template");
		expect(() => resolvePreviewDockerImage(template, "42")).toThrow(
			"Invalid preview image template",
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

	it.each([
		"",
		"a b",
		"1;rm",
		"$(id)",
		"../x",
		"-1",
		"42-",
		"a/b",
		"evil.example.com",
		"v1.2_rc",
		"x".repeat(64),
		"x".repeat(129),
	])(
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
	it.each(["42", "pr-42", "PR-42", "sha-abc123", "a", "a".repeat(63)])(
		"accepts %s",
		(value) => {
			expect(isValidPreviewIdentifier(value)).toBe(true);
		},
	);

	it.each([
		"",
		" 42",
		"4 2",
		"a:b",
		"a@sha256",
		"é",
		"v1.2.3",
		"feature_login",
		"evil.example.com",
		"-42",
		"42-",
		"a".repeat(64),
	])("rejects %j", (value) => {
		expect(isValidPreviewIdentifier(value)).toBe(false);
	});
});

describe("isValidPreviewImageTemplate", () => {
	it("treats empty as off", () => {
		expect(isValidPreviewImageTemplate("")).toBe(true);
		expect(isValidPreviewImageTemplate(null)).toBe(true);
	});

	it("rejects whitespace and absurd lengths", () => {
		expect(isValidPreviewImageTemplate("a:${{preview.prNumber}} b")).toBe(false);
		expect(isValidPreviewImageTemplate(`a:${"a".repeat(513)}${PREVIEW_IMAGE_PLACEHOLDER}`)).toBe(false);
	});

	it.each([
		"ghcr.io/org/app:pr-${{preview.prNumber}}",
		"org/app:${{preview.prNumber}}",
		"app:${{preview.prNumber}}",
		"localhost:5000/app:pr-${{preview.prNumber}}",
		"registry.example.com:5000/team/app:${{preview.prNumber}}-amd64",
	])("accepts the placeholder in the tag of %s", (template) => {
		expect(isValidPreviewImageTemplate(template)).toBe(true);
		expect(getPreviewImageTemplateError(template)).toBeNull();
	});

	it.each([
		"${{preview.prNumber}}/app:latest",
		"ghcr.io/${{preview.prNumber}}/app:latest",
		"ghcr.io/org/${{preview.prNumber}}:latest",
		"ghcr.io/org/app-${{preview.prNumber}}:latest",
		"${{preview.prNumber}}:5000/app:latest",
		"localhost:${{preview.prNumber}}/app:latest",
		"localhost:5000/${{preview.prNumber}}",
		"localhost:5000/app${{preview.prNumber}}",
		"app${{preview.prNumber}}",
		"${{preview.prNumber}}",
	])("rejects the placeholder outside the tag of %s", (template) => {
		expect(isValidPreviewImageTemplate(template)).toBe(false);
		expect(getPreviewImageTemplateError(template)).toContain(
			"only allowed in the image tag",
		);
	});

	it("rejects a template without a placeholder with a clear message", () => {
		expect(isValidPreviewImageTemplate("ghcr.io/org/app:latest")).toBe(false);
		expect(getPreviewImageTemplateError("localhost:5000/app")).toContain(
			"every preview would pull the same image",
		);
	});

	it("rejects more than one placeholder, even when all are in the tag", () => {
		const template = "org/app:${{preview.prNumber}}-${{preview.prNumber}}";
		expect(isValidPreviewImageTemplate(template)).toBe(false);
		expect(getPreviewImageTemplateError(template)).toContain("exactly once");
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
		expect(parse("${{preview.prNumber}}/app:latest").success).toBe(false);
		expect(parse("ghcr.io/${{preview.prNumber}}/app:x").success).toBe(false);
		expect(parse("ghcr.io/org/app:latest").success).toBe(false);
		expect(parse("org/app:${{preview.prNumber}}-${{preview.prNumber}}").success).toBe(false);
		expect(parse("localhost:5000/app:pr-${{preview.prNumber}}").success).toBe(true);
	});
});

describe("getPreviewSourceMismatchMessage", () => {
	it("accepts rows that match the source", () => {
		expect(getPreviewSourceMismatchMessage(true, "docker-42")).toBeNull();
		expect(getPreviewSourceMismatchMessage(false, "1001")).toBeNull();
	});

	it("refuses a Docker row on a git source and the other way round", () => {
		expect(getPreviewSourceMismatchMessage(false, "docker-42")).toContain(
			"created for a Docker-image source",
		);
		expect(getPreviewSourceMismatchMessage(true, "1001")).toContain(
			"created from a pull request",
		);
	});
});
