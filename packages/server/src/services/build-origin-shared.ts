// No db/schema imports here: client components import this file directly (see overview-shared.ts), and the
// db schema imports the constants below for its zod inputs.

/**
 * Where the image a deployment shipped was built (T-12149).
 *
 * - `dokploy`: Dokploy built it from source (a git-type source, or a compose with `build:` sections).
 * - `github-actions`: built in GitHub Actions and handed to Dokploy by digest (the dokploy-deploy composite action).
 * - `external`: anything else: a prebuilt image Dokploy only pulls (a docker-source application, a raw compose
 *   without `build:`) that was not deployed by the action.
 */
export const BUILD_ORIGINS = ["dokploy", "github-actions", "external"] as const;
export type BuildOrigin = (typeof BUILD_ORIGINS)[number];

export const isBuildOrigin = (value: unknown): value is BuildOrigin =>
	typeof value === "string" &&
	(BUILD_ORIGINS as readonly string[]).includes(value);

/** What the field means, for the API/MCP descriptions of every procedure that takes or returns it. */
export const BUILD_ORIGIN_DESCRIPTION =
	"Where the image was built: 'dokploy' (Dokploy built it from source), 'github-actions' (built in GitHub Actions and deployed by digest) or 'external' (a prebuilt image Dokploy only pulls).";

export const BUILD_RUN_URL_DESCRIPTION =
	"Link to the GitHub Actions run that built the image, only for buildOrigin 'github-actions' when known. Must look like https://github.com/<owner>/<repo>/actions/runs/<id>; anything else is dropped.";

const RUN_URL_MAX_LENGTH = 300;

/**
 * Accepts only https://github.com/<owner>/<repo>/actions/runs/<id>[/attempts/<n>|/job/<id>][?query][#hash]
 * and returns it normalised (no query, no fragment, lower-cased host, no userinfo/port), or null for
 * anything else. Dropping instead of throwing keeps a deploy from failing over a link.
 */
export const normalizeBuildRunUrl = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	if (raw.length === 0 || raw.length > RUN_URL_MAX_LENGTH) return null;
	for (const ch of raw) {
		const code = ch.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f || ch === "\\") return null;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
	if (url.username || url.password || url.port) return null;
	const match =
		/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d{1,20})(?:\/attempts\/\d{1,6}|\/job\/\d{1,20})?\/?$/.exec(
			url.pathname,
		);
	if (!match) return null;
	return `https://github.com${url.pathname.replace(/\/$/, "")}`;
};

/**
 * The deployment title the dokploy-deploy action sends starts with "GHA " ("GHA <env> <sha8>: <subject> [run N.A]",
 * and "GHA rollback <env> to <prev>" for its rollback deploy). Used only when the caller sent no buildOrigin.
 */
export const GITHUB_ACTIONS_TITLE_MARKER = /^GHA\s/;

export const hasGithubActionsTitleMarker = (title: string | null | undefined) =>
	typeof title === "string" && GITHUB_ACTIONS_TITLE_MARKER.test(title);

/**
 * The action's rollback deploy ("GHA rollback <env> to <prev>") re-deploys an image an earlier run built. It
 * says nothing new about how the running image was built, so the service-level value skips it and the run
 * link stays the one of the run that built the image.
 */
export const isGithubActionsRollbackTitle = (
	title: string | null | undefined,
) => typeof title === "string" && /^GHA\s+rollback\b/.test(title);

/**
 * A line-based test for a `build:` key under a compose service. A regex rather than a YAML parse so the same
 * test can run in SQL (`COMPOSE_BUILD_SECTION_SQL_PATTERN`) over a list of composes without reading their files.
 */
export const COMPOSE_BUILD_SECTION_PATTERN = /^[ \t]+build[ \t]*:/m;
/** The same test as a POSIX regex for Postgres (`~`). */
export const COMPOSE_BUILD_SECTION_SQL_PATTERN = "(^|\n)[ \t]+build[ \t]*:";

export const composeFileHasBuildSection = (
	composeFile: string | null | undefined,
) =>
	typeof composeFile === "string" &&
	COMPOSE_BUILD_SECTION_PATTERN.test(composeFile);

/**
 * The optional fields of a deploy request that carry the caller's claim, as they go into the queued job:
 * only a valid origin and only a valid run link are kept.
 */
export const buildOriginJobFields = (input: {
	buildOrigin?: string | null;
	buildRunUrl?: string | null;
}): { buildOrigin?: BuildOrigin; buildRunUrl?: string } => {
	const buildRunUrl = normalizeBuildRunUrl(input.buildRunUrl);
	return {
		...(isBuildOrigin(input.buildOrigin)
			? { buildOrigin: input.buildOrigin }
			: {}),
		...(buildRunUrl ? { buildRunUrl } : {}),
	};
};

export type BuildOriginSource =
	| { kind: "application"; sourceType: string | null | undefined }
	| {
			kind: "compose";
			sourceType: string | null | undefined;
			/** Whether a raw compose text has a `build:` section. Ignored for git-type sources. */
			hasBuildSection: boolean;
	  };

/**
 * What Dokploy itself does with a service: builds it from source ('dokploy') or only pulls an image ('external').
 * Docker-source applications and raw composes without `build:` never build; everything else does.
 */
export const inferBuildOriginFromSource = (
	source: BuildOriginSource,
): "dokploy" | "external" => {
	if (source.kind === "application") {
		return source.sourceType === "docker" ? "external" : "dokploy";
	}
	if (source.sourceType === "raw") {
		return source.hasBuildSection ? "dokploy" : "external";
	}
	return "dokploy";
};

export type ResolvedBuildOrigin = {
	buildOrigin: BuildOrigin;
	buildRunUrl: string | null;
};

/**
 * The origin recorded on a deployment.
 *
 * 1. A build Dokploy itself runs (a git-type source, a compose with `build:`) is always 'dokploy': a caller
 *    cannot claim another origin for it, and a "GHA " title does not count there.
 * 2. Otherwise ('external' by inference: a docker-source application, a raw compose without `build:`) the
 *    buildOrigin the caller sent wins.
 * 3. Otherwise the "GHA " title marker, or a valid GitHub Actions run link, makes it 'github-actions'.
 *
 * The run link is kept only for 'github-actions', and only when it is a valid run URL.
 */
export const resolveDeploymentBuildOrigin = (input: {
	requestedOrigin?: string | null;
	requestedRunUrl?: string | null;
	title?: string | null;
	inferred: "dokploy" | "external";
}): ResolvedBuildOrigin => {
	const runUrl = normalizeBuildRunUrl(input.requestedRunUrl);
	let buildOrigin: BuildOrigin;
	if (input.inferred === "dokploy") {
		buildOrigin = "dokploy";
	} else if (isBuildOrigin(input.requestedOrigin)) {
		buildOrigin = input.requestedOrigin;
	} else if (hasGithubActionsTitleMarker(input.title) || runUrl) {
		buildOrigin = "github-actions";
	} else {
		buildOrigin = "external";
	}
	return {
		buildOrigin,
		buildRunUrl: buildOrigin === "github-actions" ? runUrl : null,
	};
};

/** The columns of a deployment row the service-level value is computed from. */
export type BuildOriginDeploymentRow = {
	title: string;
	status: string | null;
	createdAt: string;
	buildOrigin: string | null;
	buildRunUrl: string | null;
	scheduleId?: string | null;
	backupId?: string | null;
	volumeBackupId?: string | null;
	previewDeploymentId?: string | null;
};

const createdAtMs = (row: { createdAt: string }) => {
	const ms = new Date(row.createdAt).getTime();
	return Number.isNaN(ms) ? 0 : ms;
};

/** A row that is a deployment of the service itself (not a schedule/backup/preview run). */
const isServiceDeployment = (row: BuildOriginDeploymentRow) =>
	!row.scheduleId &&
	!row.backupId &&
	!row.volumeBackupId &&
	!row.previewDeploymentId;

/**
 * The service-level value: the buildOrigin of the latest deployment with status done, else of the latest of any
 * status. A service Dokploy builds itself is always 'dokploy', whatever its old rows say (its source may have
 * changed since). The action's rollback deploys are skipped (see `isGithubActionsRollbackTitle`) unless they are
 * all there is. A row written before the column existed has no buildOrigin, so it gets the same inference a new deploy
 * would (source type, then the "GHA " title marker); a service that was never deployed gets the source inference.
 */
export const pickServiceBuildOrigin = (
	deployments: readonly BuildOriginDeploymentRow[],
	source: BuildOriginSource,
): ResolvedBuildOrigin => {
	const inferred = inferBuildOriginFromSource(source);
	if (inferred === "dokploy")
		return { buildOrigin: "dokploy", buildRunUrl: null };
	const ofService = deployments.filter(isServiceDeployment);
	const notRollback = ofService.filter(
		(row) => !isGithubActionsRollbackTitle(row.title),
	);
	const rows = (notRollback.length > 0 ? notRollback : ofService).sort(
		(a, b) => createdAtMs(b) - createdAtMs(a),
	);
	const chosen = rows.find((row) => row.status === "done") ?? rows[0];
	if (!chosen) return { buildOrigin: inferred, buildRunUrl: null };
	if (isBuildOrigin(chosen.buildOrigin)) {
		return {
			buildOrigin: chosen.buildOrigin,
			buildRunUrl:
				chosen.buildOrigin === "github-actions"
					? normalizeBuildRunUrl(chosen.buildRunUrl)
					: null,
		};
	}
	return resolveDeploymentBuildOrigin({
		title: chosen.title,
		requestedRunUrl: chosen.buildRunUrl,
		inferred,
	});
};

export const BUILD_ORIGIN_LABELS: Record<
	BuildOrigin,
	{ label: string; description: string }
> = {
	dokploy: {
		label: "Built on Dokploy",
		description: "Dokploy builds this service from source.",
	},
	"github-actions": {
		label: "GitHub Actions",
		description:
			"Built and deployed by GitHub Actions; Dokploy does not build this service.",
	},
	external: {
		label: "Prebuilt image",
		description: "Dokploy only pulls a prebuilt image for this service.",
	},
};
