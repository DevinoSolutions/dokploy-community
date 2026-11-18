import {
	apiSaveGithubProvider,
	apiUpdateApplication,
	apiUpdateCompose,
} from "@dokploy/server/db/schema";
import { watchPathsSaveProblems } from "@dokploy/server/utils/watch-paths/assert-watch-paths-saveable";
import {
	isSafeWatchPath,
	WATCH_PATH_MAX_LENGTH,
	WATCH_PATHS_MAX_ENTRIES,
	watchPathProblem,
	watchPathsNotice,
	watchPathsProblems,
} from "@dokploy/server/utils/watch-paths/validate-watch-paths";
import { describe, expect, it, vi } from "vitest";

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

describe("watchPathsProblems and watchPathsNotice", () => {
	it("report nothing for a usable list", () => {
		expect(watchPathsProblems(["src/**", "!docs/**"])).toEqual([]);
		expect(watchPathsNotice(["src/**", "!docs/**"])).toBeNull();
		expect(watchPathsNotice(null)).toBeNull();
		expect(watchPathsNotice([])).toBeNull();
	});

	it("name each refused pattern and say the list is ignored", () => {
		const notice = watchPathsNotice(["src/**", "src/**/*.{ts,tsx}", "+(*)"]);
		expect(notice).toMatch(
			/^These watch paths are ignored and every push deploys/,
		);
		expect(notice).toContain('Invalid watch path "src/**/*.{ts,tsx}": brace');
		expect(notice).toContain('Invalid watch path "+(*)": extglob');
	});

	it(`count more than ${WATCH_PATHS_MAX_ENTRIES} entries as a problem`, () => {
		const many = Array.from(
			{ length: WATCH_PATHS_MAX_ENTRIES + 1 },
			(_, i) => `dir${i}/**`,
		);
		expect(watchPathsProblems(many.slice(1))).toEqual([]);
		expect(watchPathsProblems(many)).toEqual([
			{ pattern: null, message: "At most 100 watch paths are allowed" },
		]);
	});
});

// The pattern rules depend on what is stored for the unit, so the zod schemas
// only check the type and the routers apply the rules. A form that sends the
// whole object back with a list saved before the rules existed must still parse.
describe("the API schemas keep accepting a stored list", () => {
	const legacy = ["src/**/*.{ts,tsx}", "+(*)"];

	it("application.update, compose.update and save*Provider parse it", () => {
		expect(
			apiUpdateApplication.safeParse({ applicationId: "a", watchPaths: legacy })
				.success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({ composeId: "c", watchPaths: legacy })
				.success,
		).toBe(true);
		expect(
			apiSaveGithubProvider.safeParse({
				applicationId: "a",
				repository: "repo",
				owner: "owner",
				buildPath: "/",
				githubId: "gh-1",
				branch: "main",
				triggerType: "push",
				enableSubmodules: false,
				watchPaths: legacy,
			}).success,
		).toBe(true);
	});

	it("still refuses a non-string entry", () => {
		expect(
			apiUpdateApplication.safeParse({ applicationId: "a", watchPaths: [1] })
				.success,
		).toBe(false);
	});
});

describe("watchPathsSaveProblems: refused patterns are saveable only when already stored", () => {
	const stored = ["src/**/*.{ts,tsx}", "!docs/**"];
	const load = (current: string[] | null) => vi.fn(async () => current);

	it("accepts a valid list without reading the stored row", async () => {
		const loadCurrent = load(stored);
		expect(
			await watchPathsSaveProblems(["apps/web/**", "!docs/**"], loadCurrent),
		).toEqual([]);
		expect(loadCurrent).not.toHaveBeenCalled();
	});

	it("accepts nothing to save", async () => {
		expect(await watchPathsSaveProblems(undefined, load(stored))).toEqual([]);
		expect(await watchPathsSaveProblems([], load(stored))).toEqual([]);
	});

	it("accepts the unchanged stored list", async () => {
		expect(await watchPathsSaveProblems([...stored], load(stored))).toEqual([]);
	});

	it("accepts the stored bad pattern next to removed or added valid ones", async () => {
		expect(
			await watchPathsSaveProblems(["src/**/*.{ts,tsx}"], load(stored)),
		).toEqual([]);
		expect(
			await watchPathsSaveProblems([...stored, "apps/api/**"], load(stored)),
		).toEqual([]);
	});

	it("refuses a new bad pattern", async () => {
		expect(
			await watchPathsSaveProblems([...stored, "+(*)"], load(stored)),
		).toEqual([
			expect.stringMatching(/^Invalid watch path "\+\(\*\)": extglob/),
		]);
		expect(await watchPathsSaveProblems(["+(*)"], load(null))).toHaveLength(1);
	});

	it("refuses a changed bad pattern", async () => {
		expect(
			await watchPathsSaveProblems(["src/**/*.{js,jsx}"], load(stored)),
		).toEqual([expect.stringMatching(/brace/)]);
	});

	it("refuses a changed list over the entry limit, keeps an unchanged one", async () => {
		const many = Array.from(
			{ length: WATCH_PATHS_MAX_ENTRIES + 1 },
			(_, i) => `dir${i}/**`,
		);
		expect(await watchPathsSaveProblems(many, load(many))).toEqual([]);
		expect(await watchPathsSaveProblems([...many, "x/**"], load(many))).toEqual(
			["At most 100 watch paths are allowed"],
		);
	});
});
