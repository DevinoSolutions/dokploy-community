import {
	hasSkipDeployMarker,
	SKIP_DEPLOY_MARKERS,
} from "@dokploy/server/services/build-policy/skip-deploy";
import {
	isGithubHostUrl,
	isGithubSourcedUnit,
} from "@dokploy/server/services/build-policy/source";
import { deriveDefaultWatchPaths } from "@dokploy/server/services/build-policy/watch-paths";
import { describe, expect, it } from "vitest";

describe("isGithubHostUrl", () => {
	it.each([
		"https://github.com/DevinoSolutions/sendly.git",
		"http://github.com/acme/thing",
		"https://www.github.com/acme/thing.git",
		"git@github.com:acme/thing.git",
		"ssh://git@github.com/acme/thing.git",
		"https://GitHub.com/Acme/Thing.git",
	])("accepts %s", (url) => {
		expect(isGithubHostUrl(url)).toBe(true);
	});

	it.each([
		"https://gitlab.com/acme/thing.git",
		"https://git.example.com/acme/thing.git",
		"git@bitbucket.org:acme/thing.git",
		"https://github.com.evil.example/acme/thing.git",
		"https://notgithub.com/acme/thing.git",
		"",
		null,
		undefined,
	])("rejects %s", (url) => {
		expect(isGithubHostUrl(url as string)).toBe(false);
	});

	it("rejects a github enterprise host, which uses a different API base", () => {
		expect(isGithubHostUrl("https://github.acme-corp.com/acme/thing.git")).toBe(
			false,
		);
	});
});

describe("isGithubSourcedUnit", () => {
	it("accepts sourceType github", () => {
		expect(
			isGithubSourcedUnit({ sourceType: "github", customGitUrl: null }),
		).toBe(true);
	});

	it("accepts sourceType git on github.com", () => {
		expect(
			isGithubSourcedUnit({
				sourceType: "git",
				customGitUrl: "https://github.com/acme/thing.git",
			}),
		).toBe(true);
	});

	it("rejects sourceType git elsewhere", () => {
		expect(
			isGithubSourcedUnit({
				sourceType: "git",
				customGitUrl: "https://gitlab.com/acme/thing.git",
			}),
		).toBe(false);
	});

	it("ignores a github customGitUrl when the source type is not git", () => {
		expect(
			isGithubSourcedUnit({
				sourceType: "docker",
				customGitUrl: "https://github.com/acme/thing.git",
			}),
		).toBe(false);
	});
});

describe("hasSkipDeployMarker", () => {
	it.each(SKIP_DEPLOY_MARKERS)("matches %s", (marker) => {
		expect(hasSkipDeployMarker(`chore: bump deps ${marker}`)).toBe(true);
	});

	it("is case insensitive", () => {
		expect(hasSkipDeployMarker("docs: readme [SKIP DEPLOY]")).toBe(true);
	});

	it("matches a marker on a trailer line", () => {
		expect(hasSkipDeployMarker("feat: thing\n\n[skip deploy]\n")).toBe(true);
	});

	it("does not match a plain mention of deploying", () => {
		expect(
			hasSkipDeployMarker("fix: skip deploy when the queue is empty"),
		).toBe(false);
	});

	it("does not match the unrelated [skip ci] marker", () => {
		expect(hasSkipDeployMarker("chore: lint [skip ci]")).toBe(false);
	});

	it.each([null, undefined, ""])("handles %s", (value) => {
		expect(hasSkipDeployMarker(value as string)).toBe(false);
	});
});

describe("deriveDefaultWatchPaths", () => {
	it("returns the whole repo when the build path is the repo root", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/",
				dockerfile: "Dockerfile",
			}),
		).toEqual(["**"]);
	});

	it("derives the build path directory", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/apps/web",
				dockerfile: "Dockerfile",
			}),
		).toEqual(["apps/web/**"]);
	});

	it("resolves the dockerfile under the build path, so a nested one adds nothing", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/apps/web",
				dockerfile: "docker/web/Dockerfile",
			}),
		).toEqual(["apps/web/**"]);
	});

	it("adds an explicitly configured docker context path outside the build path", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/apps/web",
				dockerfile: "Dockerfile",
				dockerContextPath: "packages/shared",
			}),
		).toEqual(["apps/web/**", "packages/shared/**"]);
	});

	it("ignores an unset docker context path rather than collapsing to the whole repo", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/apps/web",
				dockerfile: "Dockerfile",
				dockerContextPath: null,
			}),
		).toEqual(["apps/web/**"]);
	});

	it("collapses to the whole repo when a configured input is the repo root", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/apps/web",
				dockerfile: "Dockerfile",
				dockerContextPath: ".",
			}),
		).toEqual(["**"]);
	});

	it("derives a compose unit from its compose file directory", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "compose",
				composePath: "./deploy/docker-compose.yml",
			}),
		).toEqual(["deploy/**"]);
	});

	it("returns the whole repo for a compose file at the repo root", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "compose",
				composePath: "./docker-compose.yml",
			}),
		).toEqual(["**"]);
	});

	it("de-duplicates and sorts", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "/services/api",
				dockerfile: "Dockerfile",
				dockerContextPath: "/services/api/",
			}),
		).toEqual(["services/api/**"]);
	});
});
