import {
	GHA_TITLE_LIKE,
	GHA_TITLE_PREFIX,
	GHA_TITLE_TOKEN,
	GITHUB_DEPLOYMENT_HANDLE_LIKE,
	ghaTitleEndingWithHandleLike,
	githubDeploymentHandle,
	isGhaTitle,
	isGhaTitleEndingWithHandle,
	parseGithubDeploymentHandle,
} from "@dokploy/server/services/gha-deployment-title";
import { describe, expect, it } from "vitest";

/**
 * The title is the only link between a deployment row and the GitHub deployment it belongs to: the poller finds the
 * row by the handle at its end, the registry retry check reads the id back out of it. These tests pin the pieces
 * together, so changing one without the others fails here.
 */

// A LIKE pattern as Postgres reads it, for the patterns this module builds (only `%` is a wildcard in them).
const likeToRegExp = (pattern: string) =>
	new RegExp(
		`^${pattern
			.split("%")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
		"s",
	);

const title = (id: number) =>
	`GHA production 01234567 ${githubDeploymentHandle(id)}`;

describe("the pieces of a GHA title", () => {
	it("spells the prefix, the token and the SQL pattern the same way", () => {
		expect(GHA_TITLE_TOKEN).toBe("GHA");
		expect(GHA_TITLE_PREFIX).toBe("GHA ");
		expect(GHA_TITLE_LIKE).toBe("GHA %");
		expect(githubDeploymentHandle(120)).toBe("[deployment #120]");
	});
});

describe("isGhaTitle", () => {
	it.each([
		["a GHA title", "GHA production 01234567 [deployment #1]", true],
		["a registered run title", "GHA run #42", true],
		["the prefix alone", "GHA ", true],
		["the word without its space", "GHA", false],
		["the word run into the next", "GHAproduction", false],
		["a lower-case prefix", "gha production", false],
		["a title that mentions GHA later", "Deploy GHA production", false],
		["an empty title", "", false],
		["no title", null, false],
		["a title left out", undefined, false],
	])("%s", (_name, value, expected) => {
		expect(isGhaTitle(value)).toBe(expected);
	});
});

describe("the handle at the end of a title", () => {
	it("is found again from a title built with it, for any id", () => {
		for (const id of [0, 7, 120, 1120, 9007199254]) {
			expect(parseGithubDeploymentHandle(title(id))).toBe(id);
		}
	});

	it("is read from a title that ends in it, with or without trailing whitespace", () => {
		expect(parseGithubDeploymentHandle("GHA [deployment #5]")).toBe(5);
		expect(parseGithubDeploymentHandle("GHA [deployment #5] ")).toBe(5);
		expect(parseGithubDeploymentHandle("GHA [deployment #5]\n")).toBe(5);
		// The parser alone does not say the title is a GHA title.
		expect(parseGithubDeploymentHandle("Manual [deployment #5]")).toBe(5);
	});

	it.each([
		["a handle in the middle", "GHA [deployment #5] production"],
		["a handle with no id", "GHA [deployment #]"],
		["a handle with a non-numeric id", "GHA [deployment #x1]"],
		["an unclosed handle", "GHA [deployment #5"],
		["a registered run title", "GHA run #5"],
		["an empty title", ""],
	])("is not found in %s", (_name, value) => {
		expect(parseGithubDeploymentHandle(value)).toBeNull();
	});

	it("is not found without a title", () => {
		expect(parseGithubDeploymentHandle(null)).toBeNull();
		expect(parseGithubDeploymentHandle(undefined)).toBeNull();
	});
});

describe("the GHA title that ends with exactly one handle", () => {
	const like = (id: number) =>
		likeToRegExp(ghaTitleEndingWithHandleLike(githubDeploymentHandle(id)));

	it.each([
		["the title built for the deployment", title(120), true],
		["no environment or commit", "GHA [deployment #120]", true],
		["the handle of another deployment", title(1120), false],
		["a handle that only ends like it", "GHA x [deployment #1120]", false],
		["a trailing space", `${title(120)} `, false],
		["no GHA prefix", "Manual [deployment #120]", false],
		["a registered run title", "GHA run #120", false],
	])(
		"matches the same titles in SQL and in memory: %s",
		(_name, value, expected) => {
			expect(like(120).test(value)).toBe(expected);
			expect(
				isGhaTitleEndingWithHandle(value, githubDeploymentHandle(120)),
			).toBe(expected);
		},
	);

	it("is false for a missing title", () => {
		expect(isGhaTitleEndingWithHandle(null, githubDeploymentHandle(1))).toBe(
			false,
		);
		expect(
			isGhaTitleEndingWithHandle(undefined, githubDeploymentHandle(1)),
		).toBe(false);
	});
});

describe("the rows the pull poller started itself (GITHUB_DEPLOYMENT_HANDLE_LIKE)", () => {
	const like = likeToRegExp(GITHUB_DEPLOYMENT_HANDLE_LIKE);

	it("matches a title that ends with a handle of any deployment, after a space", () => {
		expect(like.test(title(120))).toBe(true);
		expect(like.test(title(1))).toBe(true);
		expect(like.test("anything [deployment #9]")).toBe(true);
	});

	it.each([
		["a handle with no text before it", "[deployment #9]"],
		["a handle with no space before it", "GHA[deployment #9]"],
		["a registered run title", "GHA run #9"],
		["a title with no handle", "GHA production 01234567"],
	])("does not match %s", (_name, value) => {
		expect(like.test(value)).toBe(false);
	});
});
