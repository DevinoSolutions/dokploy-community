import { db } from "@dokploy/server/db";
import { watchPathProblem } from "./validate-watch-paths";

/** How many units are named before the line says "and N more". */
const MAX_UNITS_LISTED = 50;

type Unit = {
	kind: "application" | "compose";
	id: string;
	name: string;
	appName: string;
	watchPaths: string[] | null;
};

const withRefusedPatterns = (units: Unit[]): Unit[] =>
	units.filter(
		(unit) =>
			Array.isArray(unit.watchPaths) &&
			unit.watchPaths.some((path) => watchPathProblem(path) !== null),
	);

/**
 * Units whose stored watch paths hold a pattern the validator refuses
 * (`validate-watch-paths.ts`). `shouldDeploy` ignores such a list and deploys
 * on every push, so these are the units whose push filter is silently off.
 */
export const findUnitsWithRefusedWatchPaths = async (): Promise<Unit[]> => {
	const [applications, composes] = await Promise.all([
		db.query.applications.findMany({
			columns: {
				applicationId: true,
				name: true,
				appName: true,
				watchPaths: true,
			},
		}),
		db.query.compose.findMany({
			columns: {
				composeId: true,
				name: true,
				appName: true,
				watchPaths: true,
			},
		}),
	]);
	return withRefusedPatterns([
		...applications.map((row) => ({
			kind: "application" as const,
			id: row.applicationId,
			name: row.name,
			appName: row.appName,
			watchPaths: row.watchPaths,
		})),
		...composes.map((row) => ({
			kind: "compose" as const,
			id: row.composeId,
			name: row.name,
			appName: row.appName,
			watchPaths: row.watchPaths,
		})),
	]);
};

/**
 * Once at server start: names every unit whose stored watch paths are
 * ignored, so a push filter that quietly stopped working can be found and
 * fixed (the form of each unit shows the same notice). Logs nothing when
 * there is none. Values are names and ids only.
 */
export const logUnitsWithRefusedWatchPaths = async (): Promise<void> => {
	const units = await findUnitsWithRefusedWatchPaths();
	if (units.length === 0) return;
	console.warn(
		`[watch-paths] ${units.length} unit(s) store watch paths that are not allowed and deploy on every push until they are edited:`,
	);
	for (const unit of units.slice(0, MAX_UNITS_LISTED)) {
		console.warn(
			`[watch-paths]   ${unit.kind} ${JSON.stringify(unit.name)} (${unit.appName}, id ${unit.id})`,
		);
	}
	if (units.length > MAX_UNITS_LISTED) {
		console.warn(`[watch-paths]   and ${units.length - MAX_UNITS_LISTED} more`);
	}
};
