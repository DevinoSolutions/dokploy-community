import { quote } from "shell-quote";
import { IS_CLOUD } from "../constants";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import {
	findPreviewDeploymentById,
	findPreviewDeploymentLogOwner,
} from "./preview-deployment";
import { findServerById } from "./server";

type LogHostRow = {
	serverId: string | null;
	buildServerId: string | null;
	previewDeploymentId: string | null;
};

type PreviewOwner = {
	application?: { serverId: string | null; buildServerId: string | null } | null;
	compose?: { serverId: string | null } | null;
};

// The host a preview is built on, derived the way createDeploymentPreview
// does: build server, else the application's server, else the compose server.
const previewOwnerLogHost = (owner: PreviewOwner) =>
	owner.application?.buildServerId ||
	owner.application?.serverId ||
	owner.compose?.serverId ||
	null;

/**
 * The host a deployment's log file lives on. Rows record `buildServerId` when
 * the deployment was built on a build server. Preview rows written before that
 * was recorded have none, so those are derived from the preview's owner.
 * Null means a local file; undefined means the host cannot be told.
 */
export const resolveDeploymentLogHost = async (
	row: LogHostRow,
): Promise<string | null | undefined> => {
	if (row.buildServerId) return row.buildServerId;
	if (!row.previewDeploymentId) return row.serverId ?? null;
	try {
		return previewOwnerLogHost(
			await findPreviewDeploymentById(row.previewDeploymentId),
		);
	} catch {
		return undefined;
	}
};

const logExistsOn = async (host: string | null, logPath: string) => {
	const command = `test -f ${quote([logPath])}`;
	try {
		if (host) await execAsyncRemote(host, command);
		else await execAsync(command);
		return true;
	} catch {
		return false;
	}
};

/**
 * Where to read a deployment's log. Every row but a legacy preview row (one
 * with no recorded `buildServerId`) reads from its recorded build server, else
 * from `fallbackHost`, with no probing.
 *
 * A legacy preview row's log is on whichever host built it, and the owner may
 * have gained or lost a build server since: so the candidates (the owner's
 * current host, the row's server, the fallback, then this host) are probed for
 * the file and the first that has it wins. A candidate outside the
 * organization is never contacted. When none has the file the answer is
 * `fallbackHost`, as before.
 */
export const locateDeploymentLogHost = async (
	row: LogHostRow & { logPath: string },
	fallbackHost: string | null,
	organizationId: string,
): Promise<string | null> => {
	if (row.buildServerId) return row.buildServerId;
	if (!row.previewDeploymentId) return fallbackHost;

	let ownerHost: string | null | undefined;
	try {
		ownerHost = previewOwnerLogHost(
			await findPreviewDeploymentLogOwner(row.previewDeploymentId),
		);
	} catch {
		ownerHost = undefined;
	}

	const candidates = new Set<string | null>();
	if (ownerHost !== undefined) candidates.add(ownerHost);
	candidates.add(row.serverId);
	candidates.add(fallbackHost);
	if (!IS_CLOUD) candidates.add(null);

	for (const host of candidates) {
		if (host) {
			const server = await findServerById(host).catch(() => null);
			if (server?.organizationId !== organizationId) continue;
		}
		if (await logExistsOn(host, row.logPath)) return host;
	}
	return fallbackHost;
};
