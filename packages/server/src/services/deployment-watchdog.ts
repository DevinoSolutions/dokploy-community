import { stat } from "node:fs/promises";
import { db } from "@dokploy/server/db";
import { deployments, previewDeployments } from "@dokploy/server/db/schema";
import { getDokployUrl } from "@dokploy/server/services/admin";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import { restoreServiceStatusIfUnchanged } from "@dokploy/server/services/deployment-cancel";
import { resolveDeploymentLogHost } from "@dokploy/server/services/deployment-log-host";
import { findPreviewDeploymentById } from "@dokploy/server/services/preview-deployment";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { quote } from "shell-quote";
import { getDeploymentErrorMessage } from "./deployment";

/**
 * Database and host access of the stuck-deployment watchdog. The decisions
 * live in `utils/deployments/watchdog-config.ts` and the orchestration (which
 * needs the deployment queue) in `apps/dokploy/server/queues/deployment-watchdog.ts`.
 */

/** A `deployment` row the watchdog may act on. */
export interface WatchdogDeployment {
	deploymentId: string;
	title: string;
	logPath: string;
	pid: string | null;
	serverId: string | null;
	buildServerId: string | null;
	applicationId: string | null;
	composeId: string | null;
	previewDeploymentId: string | null;
	startedAt: string | null;
	createdAt: string;
}

const WATCHDOG_COLUMNS = {
	deploymentId: true,
	title: true,
	logPath: true,
	pid: true,
	serverId: true,
	buildServerId: true,
	applicationId: true,
	composeId: true,
	previewDeploymentId: true,
	startedAt: true,
	createdAt: true,
} as const;

/**
 * Only the deploys of a service (a preview row names its preview, not the
 * service): a schedule run, a backup or a volume backup has its own life cycle
 * and is not in the deployment queue. `rollbackId` is NOT a filter: a deploy
 * carries the id of its own rollback snapshot when rollbacks are enabled.
 */
const deployRowsOnly = and(
	or(
		isNotNull(deployments.applicationId),
		isNotNull(deployments.composeId),
		isNotNull(deployments.previewDeploymentId),
	),
	isNull(deployments.scheduleId),
	isNull(deployments.backupId),
	isNull(deployments.volumeBackupId),
);

/** The deploys that are still `running`, oldest first. */
export const listRunningDeployDeployments = (): Promise<WatchdogDeployment[]> =>
	db.query.deployments.findMany({
		where: and(eq(deployments.status, "running"), deployRowsOnly),
		columns: WATCHDOG_COLUMNS,
		orderBy: deployments.createdAt,
	});

/** The newest deploy rows of a service or preview, newest first. */
export const listLatestDeploysOf = async (service: {
	applicationId?: string;
	composeId?: string;
	previewDeploymentId?: string;
}) => {
	const owner = service.previewDeploymentId
		? eq(deployments.previewDeploymentId, service.previewDeploymentId)
		: service.composeId
			? eq(deployments.composeId, service.composeId)
			: service.applicationId
				? eq(deployments.applicationId, service.applicationId)
				: null;
	if (!owner) return [];
	return db.query.deployments.findMany({
		where: and(owner, deployRowsOnly),
		columns: {
			deploymentId: true,
			status: true,
			createdAt: true,
			startedAt: true,
			finishedAt: true,
		},
		orderBy: desc(deployments.createdAt),
		limit: 3,
	});
};

/**
 * How many OTHER deploys are running on the host (null: the Dokploy host). The
 * generic stop of a build with no launcher matches by command line and would
 * hit all of them, applications and composes alike (a compose build runs
 * through buildx too).
 */
export const countOtherRunningDeploys = async (
	row: Pick<WatchdogDeployment, "deploymentId" | "serverId">,
): Promise<number> => {
	const others = await db.query.deployments.findMany({
		where: and(
			eq(deployments.status, "running"),
			ne(deployments.deploymentId, row.deploymentId),
			deployRowsOnly,
			row.serverId
				? eq(deployments.serverId, row.serverId)
				: isNull(deployments.serverId),
		),
		columns: { deploymentId: true },
	});
	return others.length;
};

const REMOTE_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long the deployment's log has had no new output, from the file's
 * modification time on the host that holds it (the Dokploy host, the serving
 * server, or the build server). A remote file is compared with the remote
 * clock, so a skewed clock does not matter. Null when it cannot be told: the
 * host is unknown or unreachable, or the log is gone. Never throws.
 */
export const readLogIdleMs = async (
	row: Pick<
		WatchdogDeployment,
		"logPath" | "serverId" | "buildServerId" | "previewDeploymentId"
	>,
	now: () => number = Date.now,
): Promise<number | null> => {
	if (!row.logPath || row.logPath === ".") return null;
	try {
		const host = await resolveDeploymentLogHost(row);
		if (host === undefined) return null;
		if (host) {
			const { stdout } = await execAsyncRemote(
				host,
				`stat -c %Y -- ${quote([row.logPath])} && date +%s`,
				undefined,
				{ signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) },
			);
			// A login banner can come before the answer: the last two lines are it.
			const numbers = String(stdout ?? "")
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => /^\d+$/.test(line))
				.slice(-2)
				.map(Number);
			const [modifiedAt, remoteNow] = numbers;
			if (
				numbers.length !== 2 ||
				modifiedAt === undefined ||
				remoteNow === undefined
			) {
				return null;
			}
			return Math.max(0, (remoteNow - modifiedAt) * 1000);
		}
		const { mtimeMs } = await stat(row.logPath);
		return Math.max(0, now() - mtimeMs);
	} catch {
		return null;
	}
};

/** Where a deployment's log lives (null: the Dokploy host), or undefined. */
export const resolveWatchdogLogHost = (
	row: Pick<
		WatchdogDeployment,
		"serverId" | "buildServerId" | "previewDeploymentId"
	>,
) => resolveDeploymentLogHost(row);

/**
 * Ends the deployment as `error`, with the watchdog's message, unless it ended
 * on its own: only a row that is still `running` (or `cancelled`, by the stop
 * that the watchdog itself issued) is changed. True when this call did it.
 */
export const markDeploymentFailedByWatchdog = async (
	deploymentId: string,
	message: string,
): Promise<boolean> => {
	const changed = await db
		.update(deployments)
		.set({
			status: "error",
			finishedAt: new Date().toISOString(),
			errorMessage: message,
		})
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				inArray(deployments.status, ["running", "cancelled"]),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	if (changed.length > 0) return true;
	// The deploy flow got there first and already recorded the failure: only add
	// the reason when it left none.
	await db
		.update(deployments)
		.set({ errorMessage: message })
		.where(
			and(
				eq(deployments.deploymentId, deploymentId),
				eq(deployments.status, "error"),
				isNull(deployments.errorMessage),
			),
		);
	return false;
};

/** The service, or preview, a deployment belongs to. */
export interface WatchdogServiceRef {
	applicationId?: string | null;
	composeId?: string | null;
	previewDeploymentId?: string | null;
}

/**
 * Puts the service (or preview) of a deployment whose job never ended on its
 * own to `error`, but only if it is still `running`: a deploy flow that did
 * finish its failure or cancel handling (a compose restoring its previous
 * release leaves `done`) has already put it where it belongs.
 */
export const markServiceFailedIfStillRunning = async (
	service: WatchdogServiceRef,
): Promise<void> => {
	if (service.previewDeploymentId) {
		await db
			.update(previewDeployments)
			.set({ previewStatus: "error" })
			.where(
				and(
					eq(
						previewDeployments.previewDeploymentId,
						service.previewDeploymentId,
					),
					eq(previewDeployments.previewStatus, "running"),
				),
			);
		return;
	}
	if (service.composeId) {
		await restoreServiceStatusIfUnchanged(
			{ composeId: service.composeId },
			"running",
			"error",
		);
	} else if (service.applicationId) {
		await restoreServiceStatusIfUnchanged(
			{ applicationId: service.applicationId },
			"running",
			"error",
		);
	}
};

export interface WatchdogServiceContext {
	organizationId: string;
	serviceName: string;
	/** The application or compose appName, as the cancel trail names it. */
	appName: string;
	projectName: string;
	serviceType: "application" | "compose";
	serviceId: string;
	buildLink: string;
}

/**
 * The service a deployment belongs to. A preview row names only its preview, so
 * the service is read from it. Null when the preview is gone.
 */
export const resolveWatchdogService = async (
	row: WatchdogServiceRef,
): Promise<{
	applicationId: string | null;
	composeId: string | null;
} | null> => {
	if (row.applicationId || row.composeId) {
		return {
			applicationId: row.applicationId ?? null,
			composeId: row.composeId ?? null,
		};
	}
	if (!row.previewDeploymentId) return null;
	try {
		const preview = await findPreviewDeploymentById(row.previewDeploymentId);
		return {
			applicationId: preview.application?.applicationId ?? null,
			composeId: preview.compose?.composeId ?? null,
		};
	} catch {
		return null;
	}
};

/** Names and links of the service a deployment belongs to, or null if it is gone. */
export const loadWatchdogServiceContext = async (
	row: WatchdogServiceRef,
): Promise<WatchdogServiceContext | null> => {
	try {
		const owner = await resolveWatchdogService(row);
		if (!owner) return null;
		if (owner.composeId) {
			const service = await findComposeById(owner.composeId);
			return {
				organizationId: service.environment.project.organizationId,
				serviceName: service.name,
				appName: service.appName,
				projectName: service.environment.project.name,
				serviceType: "compose",
				serviceId: service.composeId,
				buildLink: `${await getDokployUrl()}/dashboard/project/${service.environment.projectId}/environment/${service.environmentId}/services/compose/${service.composeId}?tab=deployments`,
			};
		}
		if (owner.applicationId) {
			const service = await findApplicationById(owner.applicationId);
			return {
				organizationId: service.environment.project.organizationId,
				serviceName: service.name,
				appName: service.appName,
				projectName: service.environment.project.name,
				serviceType: "application",
				serviceId: service.applicationId,
				buildLink: `${await getDokployUrl()}/dashboard/project/${service.environment.projectId}/environment/${service.environmentId}/services/application/${service.applicationId}?tab=deployments`,
			};
		}
	} catch (error) {
		console.error(
			"Deployment watchdog: could not load the service of a deployment",
			error instanceof Error ? error.message : error,
		);
	}
	return null;
};

/**
 * The existing deployment-failed notification, with the end of the log as its
 * message (which now ends in the watchdog's lines). Never throws.
 */
export const sendWatchdogFailureNotification = async (
	row: Pick<WatchdogDeployment, "logPath">,
	logHost: string | null,
	context: WatchdogServiceContext,
	fallbackMessage: string,
) => {
	try {
		const errorMessage = await getDeploymentErrorMessage({
			logPath: row.logPath,
			serverId: logHost,
			fallback: fallbackMessage,
		});
		await sendBuildErrorNotifications({
			projectName: context.projectName,
			applicationName: context.serviceName,
			applicationType: context.serviceType,
			serviceId: context.serviceId,
			errorMessage,
			buildLink: context.buildLink,
			organizationId: context.organizationId,
		});
	} catch (error) {
		console.error(
			"Deployment watchdog: could not send the failure notification",
			error instanceof Error ? error.message : error,
		);
	}
};
