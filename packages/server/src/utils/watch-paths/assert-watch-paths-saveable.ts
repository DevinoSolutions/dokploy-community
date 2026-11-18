import { TRPCError } from "@trpc/server";
import {
	WATCH_PATHS_MAX_ENTRIES,
	watchPathMessage,
	watchPathProblem,
} from "./validate-watch-paths";

type Paths = readonly string[] | null | undefined;

const sameList = (a: Paths, b: Paths) =>
	Array.isArray(a) &&
	Array.isArray(b) &&
	a.length === b.length &&
	a.every((value, index) => value === b[index]);

/**
 * Save-time rule for `watchPaths` (picomatch GHSA-fc5q-39xc-vjpf), the same
 * shape as `assertGitUrlSaveable` (T-8420): a pattern the validator refuses is
 * accepted only when it is already stored on this unit. So a form that sends
 * the whole object back, with a list saved before the rule existed, still
 * saves; removing entries or adding valid ones next to a stored bad pattern
 * works too; but no save can introduce a new bad pattern. `shouldDeploy`
 * ignores such a stored list and deploys, and the form shows why.
 *
 * Returns the messages, or `[]` when the save is allowed. `loadCurrent` is
 * called only when the new list has a problem, so a valid save costs no read.
 */
export const watchPathsSaveProblems = async (
	next: Paths,
	loadCurrent: () => Promise<Paths>,
): Promise<string[]> => {
	if (!Array.isArray(next) || next.length === 0) return [];
	const refused = next.filter((pattern) => watchPathProblem(pattern) !== null);
	const tooMany = next.length > WATCH_PATHS_MAX_ENTRIES;
	if (refused.length === 0 && !tooMany) return [];

	const current = await loadCurrent();
	if (sameList(next, current)) return [];
	const stored = new Set(Array.isArray(current) ? current : []);
	const problems = refused
		.filter((pattern) => !stored.has(pattern))
		.map((pattern) =>
			watchPathMessage(pattern, watchPathProblem(pattern) ?? "not allowed"),
		);
	if (tooMany) {
		problems.push(`At most ${WATCH_PATHS_MAX_ENTRIES} watch paths are allowed`);
	}
	return problems;
};

/** `watchPathsSaveProblems`, thrown as a BAD_REQUEST for the routers. */
export const assertWatchPathsSaveable = async (
	next: Paths,
	loadCurrent: () => Promise<Paths>,
): Promise<void> => {
	const problems = await watchPathsSaveProblems(next, loadCurrent);
	if (problems.length > 0) {
		throw new TRPCError({ code: "BAD_REQUEST", message: problems.join(" ") });
	}
};

/**
 * `assertWatchPathsSaveable` for one kind of unit: bind it to the finder that
 * loads the stored row (`findApplicationById`, `findComposeById`) and call the
 * result with the unit's id and the list being saved. Every `save*Provider`
 * route and `update` of a unit calls it, so the rule has one definition.
 */
export const watchPathsSaveGuard =
	(findCurrent: (id: string) => Promise<{ watchPaths: Paths }>) =>
	(id: string, next: Paths): Promise<void> =>
		assertWatchPathsSaveable(
			next,
			async () => (await findCurrent(id)).watchPaths,
		);
