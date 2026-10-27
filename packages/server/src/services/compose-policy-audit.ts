import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	compose,
	composePolicyFinding,
	environments,
	organization,
	projects,
} from "@dokploy/server/db/schema";
import type { ComposeNested } from "@dokploy/server/utils/builders/compose";
import {
	getComposeCodeDirectory,
	getComposeFileLinkError,
	getComposeFilesDirectory,
	getGuardedReadCommand,
	isComposeFileLinkMarker,
} from "@dokploy/server/utils/compose-file-guard";
import {
	COMPOSE_POLICY_MAX_BYTES,
	COMPOSE_POLICY_RETENTION_DAYS,
	type ComposePolicyExclusion,
	type ComposePolicySettings,
	isComposePolicyExcluded,
	resolveComposePolicySettings,
} from "@dokploy/server/utils/compose-policy/config";
import {
	type ComposePolicyContext,
	type ComposePolicyFinding,
	evaluateComposePolicy,
} from "@dokploy/server/utils/compose-policy/evaluate";
import { getComposePath } from "@dokploy/server/utils/docker/domain";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { quote } from "shell-quote";
import { logger } from "../lib/logger";
import { getReadableCommandOverrideFiles } from "./compose-volume-binding";
import { appendLogLine } from "./deployment-cancel";

/**
 * The "restricted compose" audit (T-7455), mode 1: READ-ONLY. When the
 * organization turned it on, every compose deploy evaluates the compose and
 * records what a sandbox WOULD refuse. It never blocks, fails or changes a
 * deploy.
 *
 * The deploy awaits NOTHING from the audit. `runComposePolicyAudit` is started
 * and left running in the background: the settings read, the file reads, the
 * evaluation, the insert and the log append all happen there, caught, under an
 * overall cap of `AUDIT_TIMEOUT_MS`. A timeout or an error is one warning line
 * in the server log. With the setting off (the default) the background task
 * reads one row and does nothing else: no evaluation, no write. It does not run
 * at all on Dokploy Cloud (the settings card is hidden there too).
 *
 * Where the findings go:
 * - `[restricted-compose audit] ...` lines in the deployment's own log, each
 *   with the deployment id (the lines are written in the background, so they
 *   can land a little after the deploy's own lines);
 * - one `compose_policy_finding` row per (deployment, service, rule); the
 *   rows of the organization older than COMPOSE_POLICY_RETENTION_DAYS are
 *   deleted whenever a batch is recorded.
 * Neither holds a secret (see utils/compose-policy/evaluate.ts).
 *
 * WHAT IS READ. A raw compose is evaluated from the text in memory (the one
 * the deploy writes). Any other compose is read from the code directory, where
 * the fetch and the patches have already put the file the deploy uses. That
 * file is read in the background, so the deploy can replace it meanwhile: the
 * deploy's own rewrite (domain labels, networks) adds nothing the rules look
 * at, and the read is a single bounded read, never a partial parse. A deploy
 * that is replaced by a newer one can make the audit see the newer file.
 * Randomize / isolated deployments only rename keys, which the findings do not
 * show.
 */

export const AUDIT_LOG_PREFIX = "[restricted-compose audit]";
export const AUDIT_TIMEOUT_MS = 5_000;
/** At most this many `-f` override files of a custom command are evaluated. */
const MAX_OVERRIDE_FILES = 5;

type AuditState = { aborted: boolean };

/** Runs `work` under an overall cap. After the cap `state.aborted` is set: no more writes. */
const withCap = async (
	work: (state: AuditState) => Promise<void>,
	ms: number,
) => {
	const state: AuditState = { aborted: false };
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			state.aborted = true;
			reject(new Error(`timed out after ${ms}ms`));
		}, ms);
		timer.unref?.();
	});
	try {
		await Promise.race([work(state), timeout]);
	} finally {
		clearTimeout(timer);
	}
};

type AuditEntity = ComposeNested;

/** Who changed a setting, for the server log (no audit-log licence needed). */
export interface ComposePolicyActor {
	userId: string;
}

/** The settings of an organization (the audit switch and the excluded composes). */
export const getComposePolicySettings = async (
	organizationId: string,
): Promise<ComposePolicySettings> => {
	const row = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: {
			restrictedComposeAudit: true,
			restrictedComposeAuditExclusions: true,
		},
	});
	return resolveComposePolicySettings(row);
};

export const setComposePolicyAudit = async (
	organizationId: string,
	auditEnabled: boolean,
	actor: ComposePolicyActor,
) => {
	await db
		.update(organization)
		.set({ restrictedComposeAudit: auditEnabled })
		.where(eq(organization.id, organizationId));
	logger.info(
		{ organizationId, userId: actor.userId, auditEnabled },
		`[ComposePolicyAudit] The restricted-compose audit was turned ${auditEnabled ? "on" : "off"}`,
	);
	return { auditEnabled };
};

/**
 * The SQL that rewrites the exclusion list in ONE statement, like the
 * watchdog's (see web-server-settings.ts): two people flipping switches at
 * once cannot lose an entry, because concurrent updates queue on the row lock
 * and each one is applied to the list the previous one left. Like the
 * watchdog's, it fails if the column was hand-edited to something that is not
 * a JSON array (the setter then reports the error; nothing is half-written).
 */
const column = sql`${organization.restrictedComposeAuditExclusions}`;

export const buildComposePolicyExclusionUpdate = (
	change:
		| { op: "add"; entry: ComposePolicyExclusion }
		| { op: "remove"; id: string },
) => {
	if (change.op === "remove") {
		return sql`(
			SELECT COALESCE(jsonb_agg(t.e ORDER BY t.ord), '[]'::jsonb)
			FROM jsonb_array_elements(${column}) WITH ORDINALITY AS t(e, ord)
			WHERE t.e->>'id' <> ${change.id}
		)`;
	}
	const appended = JSON.stringify([change.entry]);
	return sql`CASE WHEN EXISTS (
		SELECT 1 FROM jsonb_array_elements(${column}) AS e
		WHERE e->>'id' = ${change.entry.id}
	) THEN ${column} ELSE ${column} || ${appended}::jsonb END`;
};

export const setComposePolicyExclusion = async (
	organizationId: string,
	composeId: string,
	excluded: boolean,
	actor: ComposePolicyActor,
) => {
	await db
		.update(organization)
		.set({
			restrictedComposeAuditExclusions: buildComposePolicyExclusionUpdate(
				excluded
					? { op: "add", entry: { id: composeId } }
					: { op: "remove", id: composeId },
			),
		})
		.where(eq(organization.id, organizationId));
	logger.info(
		{ organizationId, userId: actor.userId, composeId, excluded },
		`[ComposePolicyAudit] A compose was ${excluded ? "excluded from" : "put back in"} the restricted-compose audit`,
	);
	return { excluded };
};

/**
 * Reads at most COMPOSE_POLICY_MAX_BYTES + 1 bytes of a file on the host the
 * compose lives on, so a larger file is seen as too large without being read
 * whole. `null` when there is nothing to read.
 */
const readCapped = async (
	serverId: string | null,
	path: string,
	// Set for the compose file and the override files: a file is not read when
	// it leads out of the checkout (T-7857, T-8413). The override files may also
	// come from the files directory of the compose (extraDirectory).
	codeDirectory?: string,
	extraDirectory?: string,
) => {
	const limit = COMPOSE_POLICY_MAX_BYTES + 1;
	try {
		if (serverId) {
			// Only a regular file is read: a FIFO or a device would block or stream.
			const read = `[ -f ${quote([path])} ] && head -c ${limit} ${quote([path])}`;
			const { stdout } = await execAsyncRemote(
				serverId,
				codeDirectory
					? getGuardedReadCommand({
							codeDirectory,
							extraDirectory,
							file: path,
							read,
						})
					: read,
			);
			return isComposeFileLinkMarker(stdout) ? null : stdout;
		}
		if (
			codeDirectory &&
			getComposeFileLinkError(codeDirectory, path, extraDirectory)
		) {
			return null;
		}
		const handle = await open(
			path,
			constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
		);
		try {
			if (!(await handle.stat()).isFile()) return null;
			const buffer = Buffer.alloc(limit);
			const { bytesRead } = await handle.read(buffer, 0, limit, 0);
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
};

/** The compose file as the deploy uses it. `null` when there is none to read. */
const readComposeText = (entity: AuditEntity) =>
	entity.sourceType === "raw"
		? Promise.resolve(entity.composeFile ?? "")
		: readCapped(
				entity.serverId,
				getComposePath(entity),
				getComposeCodeDirectory(entity),
			);

/**
 * The `-f` override files of a custom command, read with the same cap. The
 * command is parsed by the existing volume guard (which refuses the deploy of
 * a command it cannot understand); a refusal, or a file that cannot be read,
 * just means nothing to evaluate here. A file that is, or goes through, a link
 * out of the checkout is not read either (T-8413): its text could reach the
 * findings and the deployment log. Nor is a file outside the compose's own
 * directory, with its links resolved on the host like the deploy's own check
 * does (T-7845); those are counted so the log can say they were skipped.
 */
const readOverrideTexts = async (entity: AuditEntity) => {
	if (!entity.command) return { texts: [], skipped: 0 };
	let files: string[];
	let skipped: number;
	try {
		({ files, skipped } = await getReadableCommandOverrideFiles(
			entity,
			MAX_OVERRIDE_FILES,
		));
	} catch {
		return { texts: [], skipped: 0 };
	}
	const texts: string[] = [];
	const codeDirectory = getComposeCodeDirectory(entity);
	const filesDirectory = getComposeFilesDirectory(entity);
	for (const file of files) {
		const text = await readCapped(
			entity.serverId,
			file,
			codeDirectory,
			filesDirectory,
		);
		if (text !== null) texts.push(text);
	}
	return { texts, skipped };
};

export const getComposePolicyContext = (
	entity: Pick<AuditEntity, "appName" | "serverId">,
): ComposePolicyContext => {
	const { COMPOSE_PATH } = paths(!!entity.serverId);
	// Hosts are Linux; a drive letter only appears on a Windows dev machine.
	const root = COMPOSE_PATH.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
	const projectDirectory = posix.join(root, entity.appName);
	const codeDirectory = posix.join(projectDirectory, "code");
	return {
		appName: entity.appName,
		projectDirectory,
		codeDirectory,
		// A deploy passes `--project-directory <code directory>`, also for a
		// compose file in a subdirectory.
		baseDirectory: codeDirectory,
	};
};

const formatLogLines = (
	findings: readonly ComposePolicyFinding[],
	deploymentId: string | undefined,
	skippedOverrides = 0,
) => {
	const tag = `deployment=${deploymentId ?? "-"}`;
	// An override file that was not read (T-7845): said in the log, no findings.
	const skipped =
		skippedOverrides > 0
			? [
					`${AUDIT_LOG_PREFIX} skipped: ${skippedOverrides} override file(s) of the custom command were not read (outside the compose's own directory, or not resolvable) ${tag}`,
				]
			: [];
	if (findings.length === 0) {
		return [
			`${AUDIT_LOG_PREFIX} evaluated: no findings ${tag}`,
			...skipped,
		].join("\n");
	}
	return [
		`${AUDIT_LOG_PREFIX} evaluated: ${findings.length} finding(s); audit only, nothing was blocked ${tag}`,
		...findings.map(
			(finding) =>
				`${AUDIT_LOG_PREFIX} would refuse: service=${finding.serviceName} rule=${finding.ruleId} ${tag} detail=${finding.detail}`,
		),
		...skipped,
	].join("\n");
};

const runAudit = async (
	entity: AuditEntity,
	deployment: { deploymentId?: string; logPath: string },
	state: AuditState,
) => {
	// Let the deploy go on first: nothing below runs before the next turn.
	await new Promise<void>((resolve) => setImmediate(resolve));
	const organizationId = entity.environment?.project?.organizationId;
	if (!organizationId) return;
	const settings = await getComposePolicySettings(organizationId);
	if (!settings.auditEnabled) return;
	if (isComposePolicyExcluded(settings.exclusions, entity.composeId)) return;

	const text = await readComposeText(entity);
	const { texts: overrides, skipped } = await readOverrideTexts(entity);
	if (state.aborted) return;
	const findings = evaluateComposePolicy({
		text,
		overrides,
		command: entity.command,
		context: getComposePolicyContext(entity),
	});

	if (state.aborted) return;
	await appendLogLine(
		entity.serverId,
		deployment.logPath,
		formatLogLines(findings, deployment.deploymentId, skipped),
		"Could not write the restricted-compose audit to the deployment log",
	);
	if (findings.length === 0 || state.aborted) return;
	await db.insert(composePolicyFinding).values(
		findings.map((finding) => ({
			organizationId,
			composeId: entity.composeId,
			deploymentId: deployment.deploymentId ?? null,
			serviceName: finding.serviceName,
			ruleId: finding.ruleId,
			detail: finding.detail,
		})),
	);
	// Retention: older findings of this organization go (served by the
	// organizationId + createdAt index).
	await db
		.delete(composePolicyFinding)
		.where(
			and(
				eq(composePolicyFinding.organizationId, organizationId),
				lt(
					composePolicyFinding.createdAt,
					new Date(
						Date.now() - COMPOSE_POLICY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
					),
				),
			),
		);
};

/**
 * The hook the compose deploy paths call, WITHOUT awaiting it. The returned
 * promise never rejects (a test can wait for it; a deploy does not): any error
 * or a run past `AUDIT_TIMEOUT_MS` is one warning line in the server log, and
 * the deploy has gone on exactly as before. Every step is bounded: files are
 * read up to COMPOSE_POLICY_MAX_BYTES and evaluated in linear time.
 */
export const runComposePolicyAudit = async (
	entity: AuditEntity,
	deployment: { deploymentId?: string; logPath: string },
): Promise<void> => {
	if (IS_CLOUD) return;
	try {
		await withCap(
			(state) => runAudit(entity, deployment, state),
			AUDIT_TIMEOUT_MS,
		);
	} catch (error) {
		try {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				{ composeId: entity?.composeId },
				`[ComposePolicyAudit] The audit was skipped for this deploy: ${message.slice(0, 200)}`,
			);
		} catch {
			// Not even the warning may fail anything.
		}
	}
};

/**
 * The findings of an organization, newest first, with the name of the compose
 * they belong to. The name comes from a join on the compose id: a compose that
 * was transferred to another organization shows its new name on the old
 * organization's findings (they stay with the organization that recorded them).
 */
export const listComposePolicyFindings = async (
	organizationId: string,
	filter: { composeId?: string; since?: Date; limit?: number } = {},
) =>
	db
		.select({
			id: composePolicyFinding.composePolicyFindingId,
			composeId: composePolicyFinding.composeId,
			composeName: compose.name,
			deploymentId: composePolicyFinding.deploymentId,
			serviceName: composePolicyFinding.serviceName,
			ruleId: composePolicyFinding.ruleId,
			detail: composePolicyFinding.detail,
			createdAt: composePolicyFinding.createdAt,
		})
		.from(composePolicyFinding)
		.leftJoin(compose, eq(compose.composeId, composePolicyFinding.composeId))
		.where(
			and(
				eq(composePolicyFinding.organizationId, organizationId),
				filter.composeId
					? eq(composePolicyFinding.composeId, filter.composeId)
					: undefined,
				filter.since
					? gte(composePolicyFinding.createdAt, filter.since)
					: undefined,
			),
		)
		.orderBy(desc(composePolicyFinding.createdAt))
		.limit(filter.limit ?? 200);

/** The names of the composes of this organization among the given ids (others are not named). */
export const listComposeNamesInOrganization = async (
	organizationId: string,
	ids: readonly string[],
) => {
	if (ids.length === 0) return [];
	return db
		.select({ composeId: compose.composeId, name: compose.name })
		.from(compose)
		.innerJoin(
			environments,
			eq(environments.environmentId, compose.environmentId),
		)
		.innerJoin(projects, eq(projects.projectId, environments.projectId))
		.where(
			and(
				eq(projects.organizationId, organizationId),
				inArray(compose.composeId, [...ids]),
			),
		);
};
