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
	finishedAt?: string | null;
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
): ResolvedBuildOrigin => pickServiceBuild(deployments, source).resolved;

/** The service-level value together with the deployment row it was read from (null when none was). */
const pickServiceBuild = (
	deployments: readonly BuildOriginDeploymentRow[],
	source: BuildOriginSource,
): { resolved: ResolvedBuildOrigin; row: BuildOriginDeploymentRow | null } => {
	const inferred = inferBuildOriginFromSource(source);
	if (inferred === "dokploy") {
		return {
			resolved: { buildOrigin: "dokploy", buildRunUrl: null },
			row: null,
		};
	}
	const ofService = deployments.filter(isServiceDeployment);
	const notRollback = ofService.filter(
		(row) => !isGithubActionsRollbackTitle(row.title),
	);
	const rows = (notRollback.length > 0 ? notRollback : ofService).sort(
		(a, b) => createdAtMs(b) - createdAtMs(a),
	);
	const chosen = rows.find((row) => row.status === "done") ?? rows[0];
	if (!chosen) {
		return {
			resolved: { buildOrigin: inferred, buildRunUrl: null },
			row: null,
		};
	}
	if (isBuildOrigin(chosen.buildOrigin)) {
		return {
			resolved: {
				buildOrigin: chosen.buildOrigin,
				buildRunUrl:
					chosen.buildOrigin === "github-actions"
						? normalizeBuildRunUrl(chosen.buildRunUrl)
						: null,
			},
			row: chosen,
		};
	}
	return {
		resolved: resolveDeploymentBuildOrigin({
			title: chosen.title,
			requestedRunUrl: chosen.buildRunUrl,
			inferred,
		}),
		row: chosen,
	};
};

/**
 * What can be read about a GitHub Actions run from a deployment row (T-12424). Everything is null when it is not
 * known: older rows have only the title, and the run link is sent from .github #63 onward.
 */
export type GithubActionsRunDetails = {
	/** `owner/repo`, from the run link. */
	buildRepository: string | null;
	/** The commit the image was built from, as the title carries it (usually 8 characters, lower case). */
	buildCommitSha: string | null;
	/** The word after "GHA " in the title (the action's `environment` input, e.g. `production`). */
	buildEnvironment: string | null;
	/** The workflow run id, from the run link, else from `[run N]` in the title. */
	buildRunId: string | null;
};

export const NO_GITHUB_ACTIONS_RUN_DETAILS: GithubActionsRunDetails = {
	buildRepository: null,
	buildCommitSha: null,
	buildEnvironment: null,
	buildRunId: null,
};

export const GITHUB_ACTIONS_RUN_DETAILS_DESCRIPTION =
	"For GitHub Actions deployments: buildRepository (owner/repo), buildCommitSha, buildEnvironment (the environment the workflow deployed to) and buildRunId, each null when not known.";

const TITLE_TOKEN = "[A-Za-z0-9][A-Za-z0-9._/-]{0,99}";
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
// "GHA <env> <sha>[: subject] [run N.A]"; the environment is missing only in a title that is just a sha.
const TITLE_DEPLOY = new RegExp(
	`^GHA\\s+(${TITLE_TOKEN})(?:\\s+([0-9a-f]{7,40})(?![0-9A-Za-z]))?`,
	"i",
);
const TITLE_ROLLBACK = new RegExp(`^GHA\\s+rollback\\s+(${TITLE_TOKEN})`, "i");
const TITLE_RUN = /\[run\s+(\d{1,20})(?:\.\d{1,6})?\]/i;

/** The environment, commit and run id the dokploy-deploy action puts in the deployment title. */
export const parseGithubActionsTitle = (
	title: string | null | undefined,
): Pick<
	GithubActionsRunDetails,
	"buildCommitSha" | "buildEnvironment" | "buildRunId"
> => {
	const none = {
		buildCommitSha: null,
		buildEnvironment: null,
		buildRunId: null,
	};
	if (typeof title !== "string" || !hasGithubActionsTitleMarker(title)) {
		return none;
	}
	const buildRunId = TITLE_RUN.exec(title)?.[1] ?? null;
	const rollback = TITLE_ROLLBACK.exec(title);
	if (rollback) {
		// A rollback names the environment; the commit after "to" is the previous deploy, not what was built.
		return { ...none, buildEnvironment: rollback[1] ?? null, buildRunId };
	}
	const deploy = TITLE_DEPLOY.exec(title);
	if (!deploy) return { ...none, buildRunId };
	const first = deploy[1] ?? null;
	if (!deploy[2] && first && COMMIT_SHA.test(first)) {
		// "GHA <sha>" without an environment.
		return {
			buildCommitSha: first.toLowerCase(),
			buildEnvironment: null,
			buildRunId,
		};
	}
	return {
		buildCommitSha: deploy[2] ? deploy[2].toLowerCase() : null,
		buildEnvironment: first,
		buildRunId,
	};
};

const RUN_URL_PARTS =
	/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/;

/**
 * Repository, commit, environment and run id of a GitHub Actions deployment. The run link wins for the
 * repository and the run id; the title supplies the rest. All null for a title and link that say nothing.
 */
export const describeGithubActionsRun = (input: {
	title?: string | null;
	buildRunUrl?: string | null;
}): GithubActionsRunDetails => {
	const fromTitle = parseGithubActionsTitle(input.title);
	const runUrl = normalizeBuildRunUrl(input.buildRunUrl);
	const parts = runUrl ? RUN_URL_PARTS.exec(runUrl) : null;
	return {
		buildRepository: parts?.[1] ?? null,
		buildCommitSha: fromTitle.buildCommitSha,
		buildEnvironment: fromTitle.buildEnvironment,
		buildRunId: parts?.[2] ?? fromTitle.buildRunId,
	};
};

/**
 * Adds the run details to deployment rows for the deployment lists (and so the MCP). A row with a stored
 * origin other than GitHub Actions gets nulls; any other row is read from its link and its title, which is
 * empty for a title without the action's "GHA " marker.
 */
export const withGithubActionsRunDetails = <
	T extends {
		title?: string | null;
		buildOrigin?: string | null;
		buildRunUrl?: string | null;
	},
>(
	rows: readonly T[],
): (T & GithubActionsRunDetails)[] =>
	rows.map((row) => ({
		...row,
		...(isBuildOrigin(row.buildOrigin) && row.buildOrigin !== "github-actions"
			? NO_GITHUB_ACTIONS_RUN_DETAILS
			: describeGithubActionsRun(row)),
	}));

export type ServiceBuildDescription = ResolvedBuildOrigin &
	GithubActionsRunDetails & {
		/** When the deployment the value was read from finished (else was created); null for none. */
		buildDeployedAt: string | null;
	};

/**
 * `pickServiceBuildOrigin` plus the run details and the deploy time of the deployment it was read from, for
 * application.one / compose.one. The details are null unless the service is built in GitHub Actions.
 */
export const describeServiceBuild = (
	deployments: readonly BuildOriginDeploymentRow[],
	source: BuildOriginSource,
): ServiceBuildDescription => {
	const { resolved, row } = pickServiceBuild(deployments, source);
	if (resolved.buildOrigin !== "github-actions" || !row) {
		return {
			...resolved,
			...NO_GITHUB_ACTIONS_RUN_DETAILS,
			buildDeployedAt: null,
		};
	}
	return {
		...resolved,
		...describeGithubActionsRun({
			title: row.title,
			buildRunUrl: resolved.buildRunUrl,
		}),
		buildDeployedAt: row.finishedAt ?? row.createdAt ?? null,
	};
};

/** The commit page of a GitHub repository, or null when the repository or the sha is unknown. */
export const githubCommitUrl = (
	repository: string | null | undefined,
	sha: string | null | undefined,
) =>
	repository && sha && COMMIT_SHA.test(sha)
		? `https://github.com/${repository}/commit/${sha}`
		: null;

export const githubRepositoryUrl = (repository: string | null | undefined) =>
	repository ? `https://github.com/${repository}` : null;

export type ImageDisplay = {
	/** The image's own name, without the registry host or path (`caly-mcp`). */
	name: string;
	/** `sha256:` plus the first 12 hex characters, when the reference is pinned by digest. */
	shortDigest: string | null;
	/** The tag, when the reference has one and no digest. */
	tag: string | null;
	/** `caly-mcp @ sha256:e31c0a1b2c3d`, `caly-mcp:1.2` or just the name. */
	label: string;
	/** The reference exactly as stored, for the copy button. */
	reference: string;
};

/**
 * A readable form of an image reference: `localhost:5000/registry.devino.ca/caly-mcp@sha256:e31c...` becomes
 * `caly-mcp @ sha256:e31c0a1b2c3d`. Null for an empty reference.
 */
export const describeImageReference = (
	value: string | null | undefined,
): ImageDisplay | null => {
	const reference = typeof value === "string" ? value.trim() : "";
	if (!reference) return null;
	const at = reference.indexOf("@");
	const base = at === -1 ? reference : reference.slice(0, at);
	const digestPart = at === -1 ? "" : reference.slice(at + 1);
	const lastSegment = base.slice(base.lastIndexOf("/") + 1);
	const colon = lastSegment.indexOf(":");
	const name = colon === -1 ? lastSegment : lastSegment.slice(0, colon);
	const tag =
		colon === -1 || at !== -1 ? null : lastSegment.slice(colon + 1) || null;
	const digest = /^sha256:([0-9a-f]{12,64})$/i.exec(digestPart);
	const shortDigest = digest?.[1] ? `sha256:${digest[1].slice(0, 12)}` : null;
	const displayName = name || reference;
	return {
		name: displayName,
		shortDigest,
		tag,
		label: shortDigest
			? `${displayName} @ ${shortDigest}`
			: tag
				? `${displayName}:${tag}`
				: displayName,
		reference,
	};
};

/** The `image:` values of a compose file, in order, without duplicates. A line scan, not a YAML parse. */
export const extractComposeImages = (
	composeFile: string | null | undefined,
): string[] => {
	if (typeof composeFile !== "string") return [];
	const images: string[] = [];
	for (const match of composeFile.matchAll(
		/^[ \t]+image[ \t]*:[ \t]*["']?([^\s"'#]+)/gm,
	)) {
		const image = match[1];
		if (image && !images.includes(image)) images.push(image);
	}
	return images;
};

/**
 * Whether one deployment row was built in GitHub Actions, for the Deployments tab. A row with a stored origin
 * says so itself. A row from before the column existed counts only when its service is GitHub Actions built
 * (so a git-source service with an old "GHA " title is not) and its title carries the action's marker.
 */
export const isGithubActionsDeployment = (
	row: { buildOrigin?: string | null; title?: string | null },
	serviceBuildOrigin?: string | null,
) =>
	isBuildOrigin(row.buildOrigin)
		? row.buildOrigin === "github-actions"
		: serviceBuildOrigin === "github-actions" &&
			hasGithubActionsTitleMarker(row.title);

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
			"Built and deployed by GitHub Actions. Dokploy only pulls and starts the image.",
	},
	external: {
		label: "Prebuilt image",
		description: "Dokploy only pulls a prebuilt image for this service.",
	},
};
