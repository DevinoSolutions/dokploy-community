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
