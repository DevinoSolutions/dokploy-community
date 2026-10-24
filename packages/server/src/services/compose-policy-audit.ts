import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { paths } from "@dokploy/server/constants";
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
	type ComposePolicyExclusion,
	type ComposePolicySettings,
	isComposePolicyExcluded,
	resolveComposePolicySettings,
} from "@dokploy/server/utils/compose-policy/config";
import {
	type ComposePolicyContext,
	type ComposePolicyFinding,
	evaluateComposePolicy,
	parseComposeText,
} from "@dokploy/server/utils/compose-policy/evaluate";
import {
	addDomainToCompose,
	getComposePath,
} from "@dokploy/server/utils/docker/domain";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { quote } from "shell-quote";
import { logger } from "../lib/logger";
import { appendLogLine } from "./deployment-cancel";

/**
 * The "restricted compose" audit (T-7455), mode 1: READ-ONLY. When the
 * organization turned it on, every compose deploy evaluates the compose and
 * records what a sandbox WOULD refuse. It never blocks, fails or changes a
 * deploy: `runComposePolicyAudit` never throws, and it gives up after
 * `AUDIT_TIMEOUT_MS`. With the setting off (the default) it reads one row and
 * does nothing else: no evaluation, no write.
 *
 * Where the findings go:
 * - one `[restricted-compose audit] ...` line per finding in the deployment's
 *   own log;
 * - one `compose_policy_finding` row per (deployment, service, rule).
 * Neither holds a secret (see utils/compose-policy/evaluate.ts).
 */

export const AUDIT_LOG_PREFIX = "[restricted-compose audit]";
export const AUDIT_TIMEOUT_MS = 20_000;
/** How long the file of a compose on a remote server may take to read. */
const READ_TIMEOUT_MS = 10_000;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		timer.unref?.();
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

type AuditEntity = ComposeNested;

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
) => {
	await db
		.update(organization)
		.set({ restrictedComposeAudit: auditEnabled })
		.where(eq(organization.id, organizationId));
	return { auditEnabled };
};

/**
 * The SQL that rewrites the exclusion list in ONE statement, like the
 * watchdog's (see web-server-settings.ts): two people flipping switches at
 * once cannot lose an entry, because concurrent updates queue on the row lock
 * and each one is applied to the list the previous one left.
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
	return { excluded };
};

/** The compose file as the deploy uses it. `null` when there is none to read. */
const readComposeText = async (entity: AuditEntity) => {
	if (entity.sourceType === "raw") return entity.composeFile ?? "";
	const path = getComposePath(entity);
	try {
		if (entity.serverId) {
			const { stdout } = await withTimeout(
				execAsyncRemote(entity.serverId, `cat ${quote([path])}`),
				READ_TIMEOUT_MS,
			);
			return stdout;
		}
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
};

export const getComposePolicyContext = (
	entity: Pick<
		AuditEntity,
		"appName" | "serverId" | "sourceType" | "composePath"
	>,
): ComposePolicyContext => {
	const { COMPOSE_PATH } = paths(!!entity.serverId);
	// Hosts are Linux; a drive letter only appears on a Windows dev machine.
	const root = COMPOSE_PATH.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
	const projectDirectory = posix.join(root, entity.appName);
	const codeDirectory = posix.join(projectDirectory, "code");
	const file =
		entity.sourceType === "raw"
			? "docker-compose.yml"
			: entity.composePath || "docker-compose.yml";
	return {
		appName: entity.appName,
		projectDirectory,
		codeDirectory,
		composeDirectory: posix.dirname(posix.resolve(codeDirectory, file)),
	};
};

const formatLogLines = (findings: readonly ComposePolicyFinding[]) => {
	if (findings.length === 0) {
		return `${AUDIT_LOG_PREFIX} evaluated: no findings`;
	}
	return [
		`${AUDIT_LOG_PREFIX} evaluated: ${findings.length} finding(s); audit only, nothing was blocked`,
		...findings.map(
			(finding) =>
				`${AUDIT_LOG_PREFIX} would refuse: service=${finding.serviceName} rule=${finding.ruleId} detail=${finding.detail}`,
		),
	].join("\n");
};

const runAudit = async (
	entity: AuditEntity,
	deployment: { deploymentId?: string; logPath: string },
) => {
	const organizationId = entity.environment?.project?.organizationId;
	if (!organizationId) return;
	const settings = await getComposePolicySettings(organizationId);
	if (!settings.auditEnabled) return;
	if (isComposePolicyExcluded(settings.exclusions, entity.composeId)) return;

	const text = await readComposeText(entity);
	// The spec the deploy really runs (domain labels, randomize, patches), when
	// the text parses. A failure here leaves the text itself to be evaluated.
	let spec: unknown;
	if (text !== null && parseComposeText(text).ok) {
		try {
			spec = (await addDomainToCompose(entity, entity.domains)) ?? undefined;
		} catch {
			spec = undefined;
		}
	}
	const findings = evaluateComposePolicy({
		text,
		spec,
		command: entity.command,
		context: getComposePolicyContext(entity),
	});

	await appendLogLine(
		entity.serverId,
		deployment.logPath,
		formatLogLines(findings),
	);
	if (findings.length === 0) return;
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
};

/**
 * The hook the compose deploy paths call. Never throws and never waits longer
 * than `AUDIT_TIMEOUT_MS`: any error is one warning line in the server log,
 * and the deploy goes on exactly as before.
 */
export const runComposePolicyAudit = async (
	entity: AuditEntity,
	deployment: { deploymentId?: string; logPath: string },
) => {
	try {
		await withTimeout(runAudit(entity, deployment), AUDIT_TIMEOUT_MS);
	} catch (error) {
		try {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				{ composeId: entity?.composeId },
				`[ComposePolicyAudit] The audit was skipped for this deploy: ${message.slice(0, 200)}`,
			);
		} catch {
			// Not even the warning may fail a deploy.
		}
	}
};

/** The findings of an organization, newest first, with the name of the compose they belong to. */
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
