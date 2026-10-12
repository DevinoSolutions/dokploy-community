import { findPreviewDeploymentById } from "./preview-deployment";

/**
 * The host a deployment's log file lives on. Rows record `buildServerId` when
 * the deployment was built on a build server. Preview rows written before that
 * was recorded have none, so those are derived the way createDeploymentPreview
 * does: build server, else the application's server, else the compose server.
 * Null means a local file; undefined means the host cannot be told.
 */
export const resolveDeploymentLogHost = async (row: {
	serverId: string | null;
	buildServerId: string | null;
	previewDeploymentId: string | null;
}): Promise<string | null | undefined> => {
	if (row.buildServerId) return row.buildServerId;
	if (!row.previewDeploymentId) return row.serverId ?? null;
	try {
		const preview = await findPreviewDeploymentById(row.previewDeploymentId);
		return (
			preview.application?.buildServerId ||
			preview.application?.serverId ||
			preview.compose?.serverId ||
			null
		);
	} catch {
		return undefined;
	}
};

type LogHostRow = {
	serverId: string | null;
	buildServerId: string | null;
	previewDeploymentId: string | null;
};

/**
 * The host to read a deployment's log from. Only a preview row without a
 * recorded build server needs the owner lookup; every other row reads from
 * `fallbackHost` (the host that runs it), as it always did. A preview owner
 * that cannot be found falls back too, rather than failing the read.
 */
export const resolveDeploymentLogReadHost = async (
	row: LogHostRow,
	fallbackHost: string | null,
): Promise<string | null> => {
	if (row.buildServerId) return row.buildServerId;
	if (!row.previewDeploymentId) return fallbackHost;
	const host = await resolveDeploymentLogHost(row);
	return host === undefined ? fallbackHost : host;
};

/**
 * Adds `logServerId` to list rows: the build server that holds the log when it
 * is known, else null (read from the host that serves the service). The owner
 * lookup runs once per preview deployment, and only for preview rows written
 * before `buildServerId` was recorded.
 */
export const withDeploymentLogServerId = async <
	T extends Omit<LogHostRow, "serverId"> & { serverId?: string | null },
>(
	rows: T[],
): Promise<Array<T & { logServerId: string | null }>> => {
	const legacyPreviewIds = [
		...new Set(
			rows
				.filter((row) => !row.buildServerId && row.previewDeploymentId)
				.map((row) => row.previewDeploymentId as string),
		),
	];
	const owners = new Map<string, string | null>();
	await Promise.all(
		legacyPreviewIds.map(async (previewDeploymentId) => {
			const host = await resolveDeploymentLogHost({
				serverId: null,
				buildServerId: null,
				previewDeploymentId,
			});
			owners.set(previewDeploymentId, host ?? null);
		}),
	);
	return rows.map((row) => ({
		...row,
		logServerId:
			row.buildServerId ||
			(row.previewDeploymentId
				? (owners.get(row.previewDeploymentId) ?? null)
				: null),
	}));
};
