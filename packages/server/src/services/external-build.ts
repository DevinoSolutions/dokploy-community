import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { format } from "date-fns";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { findApplicationById } from "./application";
import {
	canonicalBuildRunUrl,
	composeFileHasBuildSection,
	inferBuildOriginFromSource,
	parseBuildRunUrl,
} from "./build-origin-shared";
import { findComposeById } from "./compose";
import { removeLastTenDeployments } from "./deployment";
import { appendLogLine } from "./deployment-cancel";
import {
	type ExternalBuildConclusion,
	externalBuildOutcome,
	GITHUB_LOG_PREFIX,
} from "./github-run-progress";

/**
 * Live GitHub Actions rows (T-12686). A deployment row used to appear only when the workflow called deploy AFTER the
 * build, so while GitHub built there was nothing to see in Dokploy. The workflow now registers a row first
 * (`registerExternalBuild`), a poller follows the run (github-run-poller.ts), and the later deploy call continues the
 * same row (`claimLiveGithubBuild`). A build that fails before any deploy call ends the row (`finishExternalBuild`).
 */

export type RegisterExternalBuildInput = {
	applicationId?: string | null;
	composeId?: string | null;
	buildOrigin: "github-actions";
	buildRunUrl: string;
	buildRunId: string;
	buildRepository: string;
	buildCommitSha: string;
	title: string;
	description?: string | null;
};

/** The service a row is registered for, as far as the registration needs it. */
export type ExternalBuildTarget = {
	kind: "application" | "compose";
	serviceId: string;
	appName: string;
	/** The host that serves the service (null: the Dokploy host). */
	serverId: string | null;
	/** An application's build server; the log lives there when set. */
	buildServerId: string | null;
	/** Whether Dokploy builds this service itself (a git source, a compose with `build:`). */
	dokployBuilds: boolean;
};

const REPOSITORY_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

const badRequest = (message: string) =>
	new TRPCError({ code: "BAD_REQUEST", message });

export type ValidatedRegistration = {
	buildRunUrl: string;
	buildRunId: string;
	buildRepository: string;
	buildCommitSha: string;
	title: string;
	description: string;
};

/**
 * The registration checked against itself: the link must be a GitHub Actions run link, and the repository and the run
 * id must be the ones in it (the link is what the person clicks, so it may not point somewhere else).
 */
export const validateRegistration = (
	input: RegisterExternalBuildInput,
): ValidatedRegistration => {
	const buildRunUrl = canonicalBuildRunUrl(input.buildRunUrl);
	const parts = parseBuildRunUrl(input.buildRunUrl);
	if (!buildRunUrl || !parts) {
		throw badRequest(
			"buildRunUrl must look like https://github.com/<owner>/<repo>/actions/runs/<id>.",
		);
	}
	const buildRepository = input.buildRepository.trim();
	if (!REPOSITORY_PATTERN.test(buildRepository)) {
		throw badRequest("buildRepository must look like <owner>/<repo>.");
	}
	if (buildRepository.toLowerCase() !== parts.repository.toLowerCase()) {
		throw badRequest(
			"buildRepository does not match the repository in buildRunUrl.",
		);
	}
	const buildRunId = input.buildRunId.trim();
	if (buildRunId !== parts.runId) {
		throw badRequest("buildRunId does not match the run in buildRunUrl.");
	}
	const buildCommitSha = input.buildCommitSha.trim();
	if (!COMMIT_PATTERN.test(buildCommitSha)) {
		throw badRequest(
			"buildCommitSha must be a git commit sha (7 to 40 hex characters).",
		);
	}
	const title = input.title.trim();
	if (!title) throw badRequest("title is required.");
	return {
		buildRunUrl,
		buildRunId,
		buildRepository: parts.repository,
		buildCommitSha: buildCommitSha.toLowerCase(),
		title: title.slice(0, 300),
		description: (input.description ?? "").trim().slice(0, 1000),
	};
};

/** The header of the log of a live row: what runs where, and where to look. */
export const externalBuildLogHeader = (row: ValidatedRegistration): string =>
	[
		"Initializing deployment",
		`${GITHUB_LOG_PREFIX} The build of this deployment runs on GitHub Actions (run #${row.buildRunId} of ${row.buildRepository}, commit ${row.buildCommitSha.slice(0, 8)}).`,
		`${GITHUB_LOG_PREFIX} Open the run: ${row.buildRunUrl}`,
		`${GITHUB_LOG_PREFIX} The steps of the run appear below while it builds. When the build is done, the workflow's deploy call continues this log with Dokploy's pull and start.`,
		"",
	].join("\n");

export interface RegisterDeps {
	loadTarget: (input: {
		applicationId?: string | null;
		composeId?: string | null;
	}) => Promise<ExternalBuildTarget>;
	findExisting: (
		target: ExternalBuildTarget,
		buildRunUrl: string,
	) => Promise<{ deploymentId: string } | undefined>;
	createLog: (target: ExternalBuildTarget, header: string) => Promise<string>;
	insertRow: (
		target: ExternalBuildTarget,
		row: ValidatedRegistration & { logPath: string; startedAt: string },
	) => Promise<{ deploymentId: string }>;
	prune: (target: ExternalBuildTarget) => Promise<void>;
	now: () => Date;
}

/** Postgres unique_violation (23505), however the driver wraps it. */
export const isUniqueViolation = (error: unknown): boolean => {
	const code = (error as { code?: unknown } | null)?.code;
	const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause
		?.code;
	return code === "23505" || causeCode === "23505";
};

// One registration at a time per service and run: two calls of the same workflow
// (a retried step) must find each other's row instead of inserting two.
const registrationLocks = new Map<string, Promise<unknown>>();
const serialized = async <T>(
	key: string,
	work: () => Promise<T>,
): Promise<T> => {
	const previous = registrationLocks.get(key) ?? Promise.resolve();
	const run = previous.catch(() => {}).then(work);
	registrationLocks.set(key, run);
	try {
		return await run;
	} finally {
		if (registrationLocks.get(key) === run) registrationLocks.delete(key);
	}
};

const loadTarget: RegisterDeps["loadTarget"] = async (input) => {
	if (input.applicationId && !input.composeId) {
		const application = await findApplicationById(input.applicationId);
		return {
			kind: "application",
			serviceId: application.applicationId,
			appName: application.appName,
			serverId: application.serverId ?? null,
			buildServerId: application.buildServerId ?? null,
			dokployBuilds:
				inferBuildOriginFromSource({
					kind: "application",
					sourceType: application.sourceType,
				}) === "dokploy",
		};
	}
	if (input.composeId && !input.applicationId) {
		const compose = await findComposeById(input.composeId);
		return {
			kind: "compose",
			serviceId: compose.composeId,
			appName: compose.appName,
			serverId: compose.serverId ?? null,
			buildServerId: null,
			dokployBuilds:
				inferBuildOriginFromSource({
					kind: "compose",
					sourceType: compose.sourceType,
					hasBuildSection: composeFileHasBuildSection(compose.composeFile),
				}) === "dokploy",
		};
	}
	throw badRequest("Send either applicationId or composeId.");
};

/** The host a live row's log is created on: the same one createDeployment picks. */
export const externalBuildLogHost = (target: ExternalBuildTarget) =>
	target.buildServerId || target.serverId || null;

const createLog: RegisterDeps["createLog"] = async (target, header) => {
	const serverId = externalBuildLogHost(target);
	const { LOGS_PATH } = paths(!!serverId);
	const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
	const logFilePath = path.join(
		LOGS_PATH,
		target.appName,
		`${target.appName}-${formattedDateTime}.log`,
	);
	if (serverId) {
		const encoded = Buffer.from(header, "utf8").toString("base64");
		await execAsyncRemote(
			serverId,
			`mkdir -p '${path.join(LOGS_PATH, target.appName)}'; echo "${encoded}" | base64 -d >> '${logFilePath.replace(/'/g, `'\\''`)}'`,
		);
	} else {
		await mkdir(path.join(LOGS_PATH, target.appName), { recursive: true });
		await writeFile(logFilePath, header);
	}
	return logFilePath;
};

const serviceColumn = (kind: ExternalBuildTarget["kind"]) =>
	kind === "application" ? deployments.applicationId : deployments.composeId;

const defaultRegisterDeps: RegisterDeps = {
	loadTarget,
	findExisting: async (target, buildRunUrl) => {
		// A registered row is found whatever became of it (the unique index says one run of one service is one
		// registered row); a row a deploy wrote for the same link only while it runs or is done.
		const rows = await db
			.select({ deploymentId: deployments.deploymentId })
			.from(deployments)
			.where(
				and(
					eq(serviceColumn(target.kind), target.serviceId),
					eq(deployments.buildOrigin, "github-actions"),
					eq(deployments.buildRunUrl, buildRunUrl),
					or(
						eq(deployments.externalBuildOnly, true),
						inArray(deployments.status, ["running", "done"]),
					),
				),
			)
			.orderBy(desc(deployments.createdAt))
			.limit(1);
		return rows[0];
	},
	createLog,
	insertRow: async (target, row) => {
		const inserted = await db
			.insert(deployments)
			.values({
				...(target.kind === "application"
					? { applicationId: target.serviceId }
					: { composeId: target.serviceId }),
				serverId: target.serverId,
				...(target.buildServerId
					? { buildServerId: target.buildServerId }
					: {}),
				title: row.title,
				description: row.description,
				status: "running",
				logPath: row.logPath,
				startedAt: row.startedAt,
				buildOrigin: "github-actions",
				buildRunUrl: row.buildRunUrl,
				buildRunId: row.buildRunId,
				buildRepository: row.buildRepository,
				buildCommitSha: row.buildCommitSha,
				buildRunStatus: "queued",
				externalBuildOnly: true,
			})
			.returning({ deploymentId: deployments.deploymentId });
		const created = inserted[0];
		if (!created) throw badRequest("Error creating the deployment");
		return created;
	},
	prune: (target) => removeLastTenDeployments(target.serviceId, target.kind),
	now: () => new Date(),
};

/**
 * Creates the deployment row of a GitHub Actions build that is still running, or returns the one the same run
 * already registered (same service and run link; the attempt is part of the link). Status `running`, the build
 * fields set, and a log that says where the build runs.
 */
export const registerExternalBuild = async (
	input: RegisterExternalBuildInput,
	deps: RegisterDeps = defaultRegisterDeps,
): Promise<{ deploymentId: string; created: boolean }> => {
	const registration = validateRegistration(input);
	const target = await deps.loadTarget(input);
	if (target.dokployBuilds) {
		throw badRequest(
			"Dokploy builds this service itself (git source or a compose with build sections), so it has no GitHub Actions build to follow.",
		);
	}
	return serialized(
		`${target.kind}:${target.serviceId}:${registration.buildRunUrl}`,
		async () => {
			const existing = await deps.findExisting(
				target,
				registration.buildRunUrl,
			);
			if (existing)
				return { deploymentId: existing.deploymentId, created: false };
			await deps.prune(target);
			const logPath = await deps.createLog(
				target,
				externalBuildLogHeader(registration),
			);
			try {
				const created = await deps.insertRow(target, {
					...registration,
					logPath,
					startedAt: deps.now().toISOString(),
				});
				return { deploymentId: created.deploymentId, created: true };
			} catch (error) {
				// Another process registered the same run first (the partial unique index): that row is the answer.
				if (!isUniqueViolation(error)) throw error;
				const winner = await deps.findExisting(
					target,
					registration.buildRunUrl,
				);
				if (!winner) throw error;
				return { deploymentId: winner.deploymentId, created: false };
			}
		},
	);
};

type FinishableDeployment = {
	deploymentId: string;
	logPath: string;
	serverId: string | null;
	buildServerId: string | null;
	buildOrigin: string | null;
	buildRunUrl: string | null;
	buildRunId: string | null;
};

/**
 * Ends a live row whose build did not reach a deploy: the status, the finish time, the reason in the row and in
 * the log (with the run link). Only a row that still waits for GitHub is changed; a row a deploy took over, or one
 * that already ended, is left as it is and `updated` is false.
 */
export const finishExternalBuild = async (
	deployment: FinishableDeployment,
	input: { conclusion: ExternalBuildConclusion; message?: string | null },
): Promise<{
	updated: boolean;
	status: "error" | "cancelled" | null;
}> => {
	if (deployment.buildOrigin !== "github-actions") {
		throw badRequest("This deployment was not built by GitHub Actions.");
	}
	const outcome = externalBuildOutcome(
		input.conclusion,
		{ runId: deployment.buildRunId },
		input.message,
	);
	const changed = await db
		.update(deployments)
		.set({
			status: outcome.status,
			finishedAt: new Date().toISOString(),
			errorMessage: outcome.errorMessage,
			buildRunStatus: "completed",
			buildRunStep: null,
		})
		.where(
			and(
				eq(deployments.deploymentId, deployment.deploymentId),
				eq(deployments.status, "running"),
				eq(deployments.buildOrigin, "github-actions"),
				// Only a row no deploy took over; a row it closes keeps externalBuildOnly.
				eq(deployments.externalBuildOnly, true),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	if (changed.length === 0) return { updated: false, status: null };
	await appendGithubLines(deployment, [
		`${GITHUB_LOG_PREFIX} ${outcome.errorMessage.replace(" The run has the details.", "")}`,
		...(deployment.buildRunUrl
			? [`${GITHUB_LOG_PREFIX} Open the run: ${deployment.buildRunUrl}`]
			: []),
	]);
	return { updated: true, status: outcome.status };
};

/** Appends lines to the log of a row, on the host that holds it. Never throws (appendLogLine logs a failure). */
export const appendGithubLines = async (
	row: Pick<FinishableDeployment, "logPath" | "serverId" | "buildServerId">,
	lines: readonly string[],
) => {
	const host = row.buildServerId || row.serverId || null;
	for (const line of lines) {
		await appendLogLine(
			host,
			row.logPath,
			line,
			"Could not write the GitHub Actions progress to the deployment log",
		);
	}
};
