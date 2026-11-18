import {
	apiSaveBitbucketProvider,
	apiSaveGiteaProvider,
	apiSaveGithubProvider,
	apiSaveGitlabProvider,
	apiSaveGitProvider,
	apiUpdateApplication,
	apiUpdateCompose,
} from "@dokploy/server/db/schema";
import {
	isSafeWatchPath,
	WATCH_PATH_MAX_LENGTH,
	WATCH_PATHS_MAX_ENTRIES,
	watchPathProblem,
	watchPathsSchema,
} from "@dokploy/server/utils/watch-paths/validate-watch-paths";
import { describe, expect, it } from "vitest";

// picomatch GHSA-fc5q-39xc-vjpf: watch paths reach micromatch on every push.

const accepted = [
	"src/**",
	"apps/web/**",
	"*.ts",
	"src/**/*.tsx",
	"src/**/*.test.ts",
	"apps/*/src/**/*.ts",
	"**/*.config.*",
	"!docs/**",
	"!CHANGELOG.md",
	"!src/**/*.test.ts",
	"Dockerfile",
	"docker-compose.yml",
	"src/routes/**/+page.svelte",
	"c++/src/**",
	"lib/[abc]*.js",
	"file?.txt",
	"apps/web/@scope/pkg/**",
	"**",
	"a".repeat(WATCH_PATH_MAX_LENGTH),
];

const rejected: [string, RegExp][] = [
	// the advisory's own shapes
	["+(*)", /extglob/],
	["*(a|aa)", /extglob/],
	["*(*(a|aa))b", /extglob/],
	["src/+(*)/**", /extglob/],
	["?(foo)", /extglob/],
	["@(a|b)/**", /extglob/],
	["!(docs)/**", /extglob/],
	// braces
	["src/**/*.{ts,tsx}", /brace/],
	["{a,b}/**", /brace/],
	["a{1..1000}", /brace/],
	["}", /brace/],
	// a group is a regex group, and a + after it is a raw quantifier
	["(a+)+b", /parentheses/],
	["app/(site)/**", /parentheses/],
	["a)", /parentheses/],
	// a + after a class is a raw quantifier too
	["[a-z]+b", /character class/],
	// polynomial backtracking without any extglob
	["*a*a*a*b", /in one folder or file name/],
	["a**a**a**b", /in one folder or file name/],
	["**/a/**/a/**/b", /\*\* wildcards/],
	["*/*/*/*", /at most 3 wildcards/],
	// size
	["a".repeat(WATCH_PATH_MAX_LENGTH + 1), /at most 256 characters/],
];

describe("watchPathProblem", () => {
	it.each(accepted)("accepts %s", (pattern) => {
		expect(watchPathProblem(pattern)).toBeNull();
		expect(isSafeWatchPath(pattern)).toBe(true);
	});

	it.each(rejected)("rejects %s", (pattern, reason) => {
		expect(watchPathProblem(pattern)).toMatch(reason);
		expect(isSafeWatchPath(pattern)).toBe(false);
	});

	it("rejects values that are not strings", () => {
		for (const value of [null, undefined, 1, {}, ["src/**"]]) {
			expect(watchPathProblem(value)).toMatch(/must be a string/);
		}
	});
});

describe("watchPathsSchema", () => {
	it("accepts an empty list and a list of plain globs", () => {
		expect(watchPathsSchema.safeParse([]).success).toBe(true);
		expect(watchPathsSchema.safeParse(accepted).success).toBe(true);
	});

	it("names the refused pattern and the reason", () => {
		const result = watchPathsSchema.safeParse(["src/**", "+(*)"]);
		expect(result.success).toBe(false);
		const issue = result.error?.issues[0];
		expect(issue?.path).toEqual([1]);
		expect(issue?.message).toMatch(/^Invalid watch path "\+\(\*\)": extglob/);
	});

	it(`allows ${WATCH_PATHS_MAX_ENTRIES} entries and refuses one more`, () => {
		const many = Array.from({ length: WATCH_PATHS_MAX_ENTRIES }, (_, i) =>
			`dir${i}/**`,
		);
		expect(watchPathsSchema.safeParse(many).success).toBe(true);
		const result = watchPathsSchema.safeParse([...many, "one-more/**"]);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.message).toMatch(/At most 100/);
	});
});

describe("every API schema that accepts watchPaths refuses a bad pattern", () => {
	const bad = ["src/**", "+(*)"];
	const good = ["src/**", "!docs/**"];

	const cases = [
		[
			"application.update",
			(watchPaths: string[]) =>
				apiUpdateApplication.safeParse({ applicationId: "app-1", watchPaths }),
		],
		[
			"compose.update",
			(watchPaths: string[]) =>
				apiUpdateCompose.safeParse({ composeId: "compose-1", watchPaths }),
		],
		[
			"application.saveGithubProvider",
			(watchPaths: string[]) =>
				apiSaveGithubProvider.safeParse({
					applicationId: "app-1",
					repository: "repo",
					owner: "owner",
					buildPath: "/",
					githubId: "gh-1",
					branch: "main",
					triggerType: "push",
					enableSubmodules: false,
					watchPaths,
				}),
		],
		[
			"application.saveGitlabProvider",
			(watchPaths: string[]) =>
				apiSaveGitlabProvider.safeParse({
					applicationId: "app-1",
					gitlabBuildPath: "/",
					gitlabOwner: "owner",
					gitlabRepository: "repo",
					gitlabId: "gl-1",
					gitlabProjectId: 1,
					gitlabPathNamespace: "owner/repo",
					gitlabBranch: "main",
					watchPaths,
				}),
		],
		[
			"application.saveBitbucketProvider",
			(watchPaths: string[]) =>
				apiSaveBitbucketProvider.safeParse({
					applicationId: "app-1",
					bitbucketBuildPath: "/",
					bitbucketOwner: "owner",
					bitbucketRepository: "repo",
					bitbucketRepositorySlug: "repo",
					bitbucketId: "bb-1",
					bitbucketBranch: "main",
					watchPaths,
				}),
		],
		[
			"application.saveGiteaProvider",
			(watchPaths: string[]) =>
				apiSaveGiteaProvider.safeParse({
					applicationId: "app-1",
					giteaBuildPath: "/",
					giteaOwner: "owner",
					giteaRepository: "repo",
					giteaId: "gt-1",
					giteaBranch: "main",
					watchPaths,
				}),
		],
		[
			"application.saveGitProvider",
			(watchPaths: string[]) =>
				apiSaveGitProvider.safeParse({
					applicationId: "app-1",
					customGitBuildPath: "/",
					customGitUrl: "https://github.com/owner/repo.git",
					customGitBranch: "main",
					enableSubmodules: false,
					watchPaths,
				}),
		],
	] as const;

	it.each(cases)("%s", (_name, parse) => {
		const ok = parse(good);
		expect(ok.error?.issues ?? []).toEqual([]);
		const refused = parse(bad);
		expect(refused.success).toBe(false);
		expect(
			refused.error?.issues.some((issue) =>
				/Invalid watch path "\+\(\*\)"/.test(issue.message),
			),
		).toBe(true);
	});
});
