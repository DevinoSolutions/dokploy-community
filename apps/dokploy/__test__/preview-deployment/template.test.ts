import { expect, test } from "vitest";
import { interpolateSubdomainTemplate } from "../../../../packages/server/src/services/preview-deployment";

const baseVars = {
	appName: "my-app",
	prNumber: "123",
	branchName: "feature/login-page",
	uniqueId: "abc123",
};

test("replaces ${prNumber} variable", () => {
	const result = interpolateSubdomainTemplate(
		"${prNumber}.previews.example.com",
		baseVars,
	);
	expect(result).toBe("123.previews.example.com");
});

test("replaces ${branchName} with slugified value", () => {
	const result = interpolateSubdomainTemplate(
		"${branchName}.previews.example.com",
		baseVars,
	);
	expect(result).toBe("feature-login-page.previews.example.com");
});

test("replaces ${appName} variable", () => {
	const result = interpolateSubdomainTemplate(
		"${appName}-${prNumber}.example.com",
		baseVars,
	);
	expect(result).toBe("my-app-123.example.com");
});

test("replaces ${uniqueId} variable", () => {
	const result = interpolateSubdomainTemplate(
		"preview-${uniqueId}.example.com",
		baseVars,
	);
	expect(result).toBe("preview-abc123.example.com");
});

test("replaces all variables in a complex template", () => {
	const result = interpolateSubdomainTemplate(
		"${appName}-pr${prNumber}-${branchName}.example.com",
		baseVars,
	);
	expect(result).toBe("my-app-pr123-feature-login-page.example.com");
});

test("leaves template unchanged when no variables present", () => {
	const result = interpolateSubdomainTemplate("*.traefik.me", baseVars);
	expect(result).toBe("*.traefik.me");
});

test("slugifies branch names with special characters", () => {
	const result = interpolateSubdomainTemplate("${branchName}.example.com", {
		...baseVars,
		branchName: "feat/SOME_THING@v2.0",
	});
	expect(result).toBe("feat-some-thing-v2-0.example.com");
});

test("truncates slugified branch to 63 chars for DNS compliance", () => {
	const longBranch = "a".repeat(100);
	const result = interpolateSubdomainTemplate("${branchName}.example.com", {
		...baseVars,
		branchName: longBranch,
	});
	const subdomain = result.split(".")[0]!;
	expect(subdomain.length).toBeLessThanOrEqual(63);
});

test("handles multiple occurrences of the same variable", () => {
	const result = interpolateSubdomainTemplate(
		"${prNumber}-${prNumber}.example.com",
		baseVars,
	);
	expect(result).toBe("123-123.example.com");
});

test("lower-cases a mixed-case ${prNumber} for the hostname", () => {
	const result = interpolateSubdomainTemplate(
		"${prNumber}.previews.example.com",
		{ ...baseVars, prNumber: "PR-Fix-42" },
	);
	expect(result).toBe("pr-fix-42.previews.example.com");
});

test("keeps the branch label within 63 chars when the template adds a suffix", () => {
	const result = interpolateSubdomainTemplate(
		"${branchName}-backend-preview.example.com",
		{
			...baseVars,
			branchName:
				"feature/PROJ-1234-a-very-long-branch-name-describing-the-change",
		},
	);
	const label = result.split(".")[0]!;
	expect(label.length).toBeLessThanOrEqual(63);
	expect(result).toBe(
		"feature-proj-1234-a-very-long-branch-nam-e4abf6-backend-preview.example.com",
	);
});

test("leaves a branch untouched when its label already fits", () => {
	const result = interpolateSubdomainTemplate(
		"${branchName}-backend-preview.example.com",
		baseVars,
	);
	expect(result).toBe("feature-login-page-backend-preview.example.com");
});

test("gives distinct hosts to long branches sharing a prefix", () => {
	const prefix = "feature/PROJ-1234-a-very-long-branch-name-describing-the-";
	const a = interpolateSubdomainTemplate("${branchName}-preview.example.com", {
		...baseVars,
		branchName: `${prefix}first-change`,
	});
	const b = interpolateSubdomainTemplate("${branchName}-preview.example.com", {
		...baseVars,
		branchName: `${prefix}second-change`,
	});
	expect(a).not.toBe(b);
	expect(a.split(".")[0]!.length).toBeLessThanOrEqual(63);
	expect(b.split(".")[0]!.length).toBeLessThanOrEqual(63);
	expect(a).toBe(
		"feature-proj-1234-a-very-long-branch-name-descri-f95dab-preview.example.com",
	);
	expect(b).toBe(
		"feature-proj-1234-a-very-long-branch-name-descri-f89b70-preview.example.com",
	);
});

test("shortens a long branch the same way every time", () => {
	const vars = {
		...baseVars,
		branchName:
			"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
	};
	const expected =
		"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-d929cd-preview.example.com";
	expect(
		interpolateSubdomainTemplate("${branchName}-preview.example.com", vars),
	).toBe(expected);
	expect(
		interpolateSubdomainTemplate("${branchName}-preview.example.com", vars),
	).toBe(expected);
});

test("never ends the shortened slug with a dash", () => {
	const result = interpolateSubdomainTemplate(
		"${branchName}-preview.example.com",
		{
			...baseVars,
			branchName:
				"ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-tail",
		},
	);
	expect(result).toBe(
		"ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-de2d98-preview.example.com",
	);
});

test("shares the budget between two occurrences in the same label", () => {
	const result = interpolateSubdomainTemplate(
		"${branchName}-${branchName}.example.com",
		{
			...baseVars,
			branchName:
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		},
	);
	const shortened = "bbbbbbbbbbbbbbbbbbbbbbbb-18766a";
	expect(result).toBe(`${shortened}-${shortened}.example.com`);
});

test("only shortens the label that holds the branch", () => {
	const result = interpolateSubdomainTemplate(
		"${prNumber}.${branchName}.example.com",
		{
			...baseVars,
			branchName:
				"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		},
	);
	expect(result).toBe(
		"123.cccccccccccccccccccccccccccccccccccccccccccccccccccccccc-4b884e.example.com",
	);
});
