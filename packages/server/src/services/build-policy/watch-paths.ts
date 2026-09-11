/**
 * Default `watchPaths` for a unit that has none (spec 5.2.6): derive them from
 * the unit's build path, the Dockerfile directory and the compose file
 * directory.
 *
 * Three deliberate choices:
 *
 * - The build path is selected **by source type**, exactly as
 *   `getBuildAppDirectory` (`utils/filesystem/directory.ts`) does: `buildPath`
 *   for github, `gitlabBuildPath` for gitlab, and so on. Reading `buildPath`
 *   unconditionally was round-3 review finding K, and the case it broke is a
 *   unit migrated from GitHub to GitLab — `saveGitlabProvider` writes
 *   `gitlabBuildPath` and never resets `buildPath`, so the stale GitHub value
 *   survived and silently became the watch path.
 * - `dockerfile` is resolved *under* that build path, matching
 *   `getBuildAppDirectory`, so a Dockerfile inside the build path adds nothing.
 * - An unset `dockerContextPath` is ignored even though upstream then builds
 *   with the repo root as context. Honouring it would collapse almost every
 *   dockerfile unit to `**`, which is the same as no filter and defeats the
 *   point. An explicitly configured context path is honoured.
 *
 * A unit whose build inputs really do sit at the repo root gets `**`. That is
 * the honest answer, not a bug, and it is the safe direction: it deploys rather
 * than silently skipping.
 */
export interface WatchPathsInput {
	unitType: "application" | "compose";
	/** Selects which build-path column below applies. */
	sourceType?: string | null;
	buildPath?: string | null;
	gitlabBuildPath?: string | null;
	bitbucketBuildPath?: string | null;
	giteaBuildPath?: string | null;
	dropBuildPath?: string | null;
	customGitBuildPath?: string | null;
	dockerfile?: string | null;
	dockerContextPath?: string | null;
	composePath?: string | null;
}

/**
 * The build path this unit actually builds from, mirroring the selection in
 * `getBuildAppDirectory`. Kept as a separate exported function so the two can
 * be compared side by side when upstream adds a source type.
 *
 * With no `sourceType` it falls back to `buildPath`, which keeps a caller that
 * knows only that column behaving exactly as before rather than silently
 * widening it to the repo root.
 */
export const buildPathForSource = (
	input: Pick<
		WatchPathsInput,
		| "sourceType"
		| "buildPath"
		| "gitlabBuildPath"
		| "bitbucketBuildPath"
		| "giteaBuildPath"
		| "dropBuildPath"
		| "customGitBuildPath"
	>,
): string | null => {
	switch (input.sourceType) {
		case "github":
			return input.buildPath ?? null;
		case "gitlab":
			return input.gitlabBuildPath ?? null;
		case "bitbucket":
			return input.bitbucketBuildPath ?? null;
		case "gitea":
			return input.giteaBuildPath ?? null;
		case "drop":
			return input.dropBuildPath ?? null;
		case "git":
			return input.customGitBuildPath ?? null;
		case undefined:
		case null:
			return input.buildPath ?? null;
		default:
			// A source type with no build path of its own, such as `docker`.
			// `getBuildAppDirectory` leaves it empty; so do we.
			return null;
	}
};

const ROOT = "**";

/** Strip `./`, leading and trailing slashes; return "" for the repo root. */
const normalizeDir = (value: string | null | undefined): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const cleaned = trimmed
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
	if (cleaned === "" || cleaned === ".") return "";
	return cleaned;
};

const dirnameOf = (filePath: string | null | undefined): string | null => {
	const normalized = normalizeDir(filePath);
	if (normalized === null) return null;
	if (normalized === "") return "";
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
};

const joinDirs = (base: string, child: string): string => {
	if (base === "") return child;
	if (child === "") return base;
	return `${base}/${child}`;
};

/** Drop any directory already covered by a shallower one. */
const dropContained = (dirs: string[]): string[] =>
	dirs.filter(
		(dir) =>
			!dirs.some((other) => other !== dir && dir.startsWith(`${other}/`)),
	);

export const deriveDefaultWatchPaths = (input: WatchPathsInput): string[] => {
	let candidates: (string | null)[];

	if (input.unitType === "compose") {
		candidates = [dirnameOf(input.composePath)];
	} else {
		const buildPath = normalizeDir(buildPathForSource(input)) ?? "";
		const dockerfileDir = dirnameOf(input.dockerfile);
		candidates = [
			buildPath,
			dockerfileDir === null ? null : joinDirs(buildPath, dockerfileDir),
			normalizeDir(input.dockerContextPath),
		];
	}

	const dirs = candidates.filter((c): c is string => c !== null);
	if (dirs.length === 0) return [ROOT];
	// Any input at the repo root means the whole repo is build input.
	if (dirs.some((d) => d === "")) return [ROOT];

	const unique = dropContained(Array.from(new Set(dirs))).sort();
	return unique.map((dir) => `${dir}/**`);
};

/**
 * The value a unit should watch: its own `watchPaths` when set, otherwise the
 * derived default.
 */
export const resolveWatchPaths = (
	current: string[] | null | undefined,
	input: WatchPathsInput,
): { paths: string[]; derived: boolean } => {
	if (Array.isArray(current) && current.length > 0) {
		return { paths: current, derived: false };
	}
	return { paths: deriveDefaultWatchPaths(input), derived: true };
};
