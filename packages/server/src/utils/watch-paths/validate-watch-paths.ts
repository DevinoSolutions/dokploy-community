import { z } from "zod";

/**
 * Watch paths are user-supplied globs that the deploy webhooks match against
 * the changed files of a push (`should-deploy.ts`). picomatch, which
 * micromatch runs underneath, has an unpatched ReDoS (GHSA-fc5q-39xc-vjpf,
 * every version through 4.0.7, micromatch/picomatch#194): an extglob such as
 * `+(*)` or `*(a|aa)` compiles to a regex with catastrophic backtracking, so
 * one stored pattern can pin the webhook handler's event loop. Brace patterns
 * carry the related `braces` advisory (GHSA-vfj7-8cjw-p6xm, deep nesting).
 *
 * Turning extglobs and braces off (`noextglob`, `nobrace`) is not enough on
 * its own. Measured against picomatch 2.3.2 with both options on:
 *
 * - `(…)` still compiles to a regex group and a `+` after it is passed through
 *   as a quantifier, so `(a+)+b` hangs on 40 characters. A literal `(` never
 *   matched anyway: `app/(site)/**` compiles to a group that matches
 *   `app/site/...`, not the route-group folder.
 * - `[…]+` is passed through the same way.
 * - Every `*` run is a lazy `[^/]*?`, so three in one path segment
 *   (`*a*a*a*b`) or three globstars (`**\/a/**\/a/**\/b`) backtrack
 *   polynomially and take seconds on a 1,000 to 4,000 character path.
 *
 * So a watch path is refused when it has:
 *
 * - an extglob opener: one of `@ ! ? * +` directly followed by `(`;
 * - a brace `{ }` or a parenthesis `( )`;
 * - `]+`;
 * - more than 2 `*` runs in one path segment, more than 2 globstar runs
 *   (`**`), or more than 3 `*` runs in total;
 * - more than WATCH_PATH_MAX_LENGTH characters; and a list may hold at most
 *   WATCH_PATHS_MAX_ENTRIES patterns.
 *
 * `src/**`, `*.ts`, `src/**\/*.tsx`, `apps/*\/src/**\/*.ts`, `**\/*.config.*`,
 * `src/routes/**\/+page.svelte`, character classes and `!docs/**` negation stay
 * valid. Every pattern this allows matched a 4,096 character path in under
 * 100 ms in the same measurement.
 *
 * The check runs in three places:
 *
 * - on save (`assert-watch-paths-saveable.ts`, called by the application and
 *   compose routers), for every pattern that is not already stored on that
 *   unit, so a bad pattern is refused with a clear message while a row stored
 *   before this check existed can still be saved unchanged (same rule as
 *   `assertGitUrlSaveable`, T-8420);
 * - in `shouldDeploy`, so such a stored row never reaches the matcher;
 * - in the watch-paths form fields, which show `watchPathsNotice` so the user
 *   sees that the list is being ignored.
 */
export const WATCH_PATH_MAX_LENGTH = 256;
export const WATCH_PATHS_MAX_ENTRIES = 100;
const MAX_STAR_RUNS = 3;
const MAX_STAR_RUNS_PER_SEGMENT = 2;
const MAX_GLOBSTAR_RUNS = 2;

const EXTGLOB_OPENER = /[@!?*+]\(/;
const BRACE = /[{}]/;
const PAREN = /[()]/;
const CLASS_QUANTIFIER = /\]\+/;
const STAR_RUN = /\*+/g;

const countStarRuns = (value: string) => value.match(STAR_RUN)?.length ?? 0;

/**
 * Why `pattern` is not an acceptable watch path, or `null` when it is.
 * Non-strings are refused too, since the runtime check reads database rows.
 */
export const watchPathProblem = (pattern: unknown): string | null => {
	if (typeof pattern !== "string") return "a watch path must be a string";
	if (pattern.length > WATCH_PATH_MAX_LENGTH) {
		return `a watch path can be at most ${WATCH_PATH_MAX_LENGTH} characters`;
	}
	if (EXTGLOB_OPENER.test(pattern)) {
		return "extglob patterns such as +(…), *(…), ?(…), @(…) or !(…) are not supported; use plain globs like src/** or *.ts";
	}
	if (BRACE.test(pattern)) {
		return "brace patterns such as {a,b} are not supported; add one watch path per alternative instead";
	}
	if (PAREN.test(pattern)) {
		return "parentheses are not supported (they are not matched literally); use ? or * for that character, e.g. app/?site?/**";
	}
	if (CLASS_QUANTIFIER.test(pattern)) {
		return "a + after a character class ([…]+) is not supported";
	}
	const segments = pattern.split("/");
	if (segments.some((s) => countStarRuns(s) > MAX_STAR_RUNS_PER_SEGMENT)) {
		return `a watch path can have at most ${MAX_STAR_RUNS_PER_SEGMENT} wildcards in one folder or file name`;
	}
	if ((pattern.match(/\*{2,}/g)?.length ?? 0) > MAX_GLOBSTAR_RUNS) {
		return `a watch path can have at most ${MAX_GLOBSTAR_RUNS} ** wildcards`;
	}
	if (countStarRuns(pattern) > MAX_STAR_RUNS) {
		return `a watch path can have at most ${MAX_STAR_RUNS} wildcards (* or **)`;
	}
	return null;
};

export const isSafeWatchPath = (pattern: unknown): pattern is string =>
	watchPathProblem(pattern) === null;

/** `Invalid watch path "…": reason` for one refused pattern. */
export const watchPathMessage = (pattern: unknown, problem: string) =>
	`Invalid watch path ${JSON.stringify(String(pattern).slice(0, 64))}: ${problem}`;

/**
 * The refused patterns of a list, each with its message. A list over
 * WATCH_PATHS_MAX_ENTRIES is reported as one more entry with pattern `null`.
 */
export const watchPathsProblems = (
	paths: readonly unknown[] | null | undefined,
): { pattern: unknown; message: string }[] => {
	if (!Array.isArray(paths)) return [];
	const problems: { pattern: unknown; message: string }[] = [];
	for (const pattern of paths) {
		const problem = watchPathProblem(pattern);
		if (problem) {
			problems.push({ pattern, message: watchPathMessage(pattern, problem) });
		}
	}
	if (paths.length > WATCH_PATHS_MAX_ENTRIES) {
		problems.push({
			pattern: null,
			message: `At most ${WATCH_PATHS_MAX_ENTRIES} watch paths are allowed`,
		});
	}
	return problems;
};

/**
 * What the watch-paths field shows when `shouldDeploy` would ignore the list,
 * or `null` when the list is usable.
 */
export const watchPathsNotice = (
	paths: readonly unknown[] | null | undefined,
): string | null => {
	const problems = watchPathsProblems(paths);
	if (problems.length === 0) return null;
	return `These watch paths are ignored and every push deploys until this is fixed. ${problems
		.map((p) => p.message)
		.join(" ")}`;
};

/**
 * zod shape for the API inputs that accept watch paths. It only checks the
 * type: the pattern rules depend on what is already stored for the unit, so
 * the routers apply them with `assertWatchPathsSaveable`.
 */
export const watchPathsSchema = z
	.array(z.string())
	.describe(
		`Glob patterns. Saving refuses a pattern not already stored on this unit that has an extglob (+(…) *(…) ?(…) @(…) !(…)), a brace or parenthesis, "]+", more than 2 * in one name, more than 2 ** or 3 * in total, or more than ${WATCH_PATH_MAX_LENGTH} characters, and a changed list of more than ${WATCH_PATHS_MAX_ENTRIES} entries.`,
	);
