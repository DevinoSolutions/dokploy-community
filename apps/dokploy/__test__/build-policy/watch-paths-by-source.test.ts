import {
	buildPathForSource,
	deriveDefaultWatchPaths,
} from "@dokploy/server/services/build-policy/watch-paths";
import { describe, expect, it } from "vitest";

/**
 * Round-3 review finding K.
 *
 * `deriveDefaultWatchPaths` read `buildPath`, and the `watch-paths.ts` docstring
 * claimed it matched `getBuildAppDirectory`. It matched it for
 * `sourceType: "github"` only: `getBuildAppDirectory`
 * (`utils/filesystem/directory.ts:104-123`) selects per source type —
 * `gitlabBuildPath`, `bitbucketBuildPath`, `giteaBuildPath`, `dropBuildPath`,
 * `customGitBuildPath`.
 *
 * Mostly benign, because `buildPath` defaults to `"/"`, which derives to `**`
 * and deploys everything. The case that bites is a unit **migrated** from
 * GitHub to GitLab: `saveGitlabProvider` writes `gitlabBuildPath` and never
 * resets `buildPath`, so the stale GitHub path survived and became the derived
 * watch path, and pushes touching the real GitLab build path were skipped.
 *
 * Adding the GitLab gate in round 2's finding G is what made this pre-existing
 * mismatch reachable on a new route.
 */

describe("buildPathForSource mirrors getBuildAppDirectory", () => {
	const ALL = {
		buildPath: "apps/web",
		gitlabBuildPath: "services/api",
		bitbucketBuildPath: "bb/app",
		giteaBuildPath: "gitea/app",
		dropBuildPath: "drop/app",
		customGitBuildPath: "custom/app",
	};

	it.each([
		["github", "apps/web"],
		["gitlab", "services/api"],
		["bitbucket", "bb/app"],
		["gitea", "gitea/app"],
		["drop", "drop/app"],
		["git", "custom/app"],
	])("selects the %s column", (sourceType, expected) => {
		expect(buildPathForSource({ ...ALL, sourceType })).toBe(expected);
	});

	it("returns nothing for a source type that has no build path, such as docker", () => {
		expect(buildPathForSource({ ...ALL, sourceType: "docker" })).toBeNull();
	});

	it("falls back to buildPath when the source type is not known", () => {
		// Keeps every existing caller that passes only `buildPath` behaving as it
		// did, rather than silently widening them to the repo root.
		expect(buildPathForSource({ buildPath: "apps/web" })).toBe("apps/web");
	});
});

describe("deriveDefaultWatchPaths picks the build path for the unit's source", () => {
	const MIGRATED = {
		unitType: "application" as const,
		// The stale GitHub value `saveGitlabProvider` leaves behind.
		buildPath: "apps/old-github-app",
		gitlabBuildPath: "services/api",
	};

	it("uses the GitLab build path for a GitLab unit, not the stale GitHub one", () => {
		expect(
			deriveDefaultWatchPaths({ ...MIGRATED, sourceType: "gitlab" }),
		).toEqual(["services/api/**"]);
	});

	it("still uses buildPath for a GitHub unit", () => {
		expect(
			deriveDefaultWatchPaths({ ...MIGRATED, sourceType: "github" }),
		).toEqual(["apps/old-github-app/**"]);
	});

	it("derives the repo root when the unit's own source has no build path set", () => {
		// A GitLab unit with no gitlabBuildPath watches everything, which is the
		// safe direction: it deploys rather than silently skipping.
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				sourceType: "gitlab",
				buildPath: "apps/old-github-app",
			}),
		).toEqual(["**"]);
	});

	it("resolves the Dockerfile under the source's own build path, and absorbs it", () => {
		// The Dockerfile directory is joined onto the *gitlab* build path, and is
		// then contained by it, so it adds nothing — the documented behaviour.
		// The point of the assertion is the base it was joined onto.
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				sourceType: "gitlab",
				buildPath: "apps/old-github-app",
				gitlabBuildPath: "services/api",
				dockerfile: "docker/Dockerfile",
			}),
		).toEqual(["services/api/**"]);
	});

	/**
	 * Gitea and Bitbucket units arrive through the shared `[refreshToken]`
	 * deploy-hook route, so they hit the same gate and had the same mismatch.
	 */
	it.each([
		["bitbucket", "bitbucketBuildPath"],
		["gitea", "giteaBuildPath"],
		["git", "customGitBuildPath"],
		["drop", "dropBuildPath"],
	])("uses the %s column, not the stale buildPath", (sourceType, column) => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				sourceType,
				buildPath: "apps/old-github-app",
				[column]: "services/api",
			}),
		).toEqual(["services/api/**"]);
	});

	it("watches everything for a docker-source unit, which has no build path", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				sourceType: "docker",
				buildPath: "apps/old-github-app",
			}),
		).toEqual(["**"]);
	});

	it("is unchanged for a compose unit, which has only composePath", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "compose",
				sourceType: "gitlab",
				buildPath: "apps/old-github-app",
				composePath: "./stacks/api/docker-compose.yml",
			}),
		).toEqual(["stacks/api/**"]);
	});

	it("keeps behaving as before when no source type is given", () => {
		expect(
			deriveDefaultWatchPaths({
				unitType: "application",
				buildPath: "apps/web",
			}),
		).toEqual(["apps/web/**"]);
	});
});
