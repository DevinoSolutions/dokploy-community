import micromatch from "micromatch";
import { watchPathProblem } from "./validate-watch-paths";

/**
 * Turns off the two picomatch features behind GHSA-fc5q-39xc-vjpf (extglobs)
 * and GHSA-vfj7-8cjw-p6xm (braces). Option names checked against
 * picomatch 2.3.2 `lib/parse.js` (`opts.noextglob`, `opts.nobrace`), which is
 * what micromatch 4.0.8 passes them to.
 */
export const WATCH_PATH_MATCH_OPTIONS = Object.freeze({
	noextglob: true,
	nobrace: true,
});

/**
 * Longer than Linux PATH_MAX: no checkout can contain such a file, so it
 * cannot affect a build, and it is not worth matching (every wildcard is a
 * lazy `[^/]*?`, so match time grows with path length).
 */
export const MAX_CHANGED_FILE_LENGTH = 4096;

/**
 * Whether a push that changed `modifiedFiles` should deploy a unit watching
 * `watchPaths`.
 *
 * No watch paths means "deploy on every push". A stored list that holds a
 * pattern the validator refuses (`validate-watch-paths.ts`) is treated the same
 * way: the whole list is ignored, a warning is logged, and the push deploys.
 * Such a row predates the API check (or came from the derived default of a
 * build path with unusual characters). Dropping only the bad pattern was
 * rejected because it can silently stop deploys: `["+(apps/api)/**"]` used to
 * match `apps/api/x`, and with the pattern dropped a remaining negation such
 * as `!docs/**` would still match, while a remaining positive pattern for
 * another folder would skip every api push. Deploying is the direction this
 * code already prefers over a silent skip (see `build-policy/watch-paths.ts`).
 */
export const shouldDeploy = (
	watchPaths: string[] | null,
	modifiedFiles: (string | null | undefined)[] | null | undefined,
): boolean => {
	if (!watchPaths || watchPaths?.length === 0) return true;
	const refused = watchPaths.filter((path) => watchPathProblem(path) !== null);
	if (refused.length > 0) {
		console.warn(
			`[watch-paths] ignoring the stored watch paths and deploying: ${refused.length} pattern(s) are not allowed (${refused
				.slice(0, 3)
				.map((path) => JSON.stringify(String(path).slice(0, 64)))
				.join(", ")}: ${watchPathProblem(refused[0])})`,
		);
		return true;
	}
	const files = (modifiedFiles ?? []).filter(
		(file): file is string =>
			typeof file === "string" && file.length <= MAX_CHANGED_FILE_LENGTH,
	);
	return (
		micromatch(files, watchPaths, WATCH_PATH_MATCH_OPTIONS).length > 0
	);
};
