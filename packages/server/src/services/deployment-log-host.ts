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
	application?: {
		serverId: string | null;
		buildServerId: string | null;
	} | null;
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

// A dead or hung server must not stall a read: a probe that takes longer than
// this counts as "not there".
const PROBE_TIMEOUT_MS = 5000;

const withTimeout = <T>(work: Promise<T>, fallback: T): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

// Does `host` (null = this host) belong to the organization and hold the log?
const logExistsOn = (
	host: string | null,
	logPath: string,
	organizationId: string,
): Promise<boolean> =>
	withTimeout(
		(async () => {
			const command = `test -f ${quote([logPath])}`;
			try {
				if (host) {
					const server = await findServerById(host);
					if (server.organizationId !== organizationId) return false;
					await execAsyncRemote(host, command);
				} else {
					await execAsync(command);
				}
				return true;
			} catch {
				return false;
			}
		})(),
		false,
	);

/**
 * Where to read a deployment's log. Every row but a legacy preview row (one
 * with no recorded `buildServerId`) reads from its recorded build server, else
 * from `fallbackHost`, with no probing.
 *
 * A legacy preview row's log is on whichever host built it, and the owner may
 * have gained or lost a build server since: so the candidates (the owner's
 * current host, the row's server, the fallback, then this host) are probed
 * together, each with a short timeout, and the first in that order that has the
 * file wins. A candidate outside the organization is never contacted. A build
 * server the owner no longer has is not a candidate. When none has the file the answer is
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

	// Candidates in preference order. Without a local filesystem (cloud) a
	// local candidate, from any source, cannot hold the file.
	const candidates = new Set<string | null>();
	if (ownerHost !== undefined) candidates.add(ownerHost);
	candidates.add(row.serverId);
	candidates.add(fallbackHost);
	candidates.add(null);
	const hosts = [...candidates].filter((host) => host || !IS_CLOUD);

	// Probed together, so a slow host costs one timeout, not one per candidate;
	// the first hit in candidate order wins.
	const found = await Promise.all(
		hosts.map((host) => logExistsOn(host, row.logPath, organizationId)),
	);
	const hit = found.indexOf(true);
	return hit === -1 ? fallbackHost : (hosts[hit] ?? null);
};
