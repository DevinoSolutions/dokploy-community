import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { IS_CLOUD } from "../constants";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "../utils/process/execAsync";
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
// this is abandoned (and its SSH connection dropped) and counts as "unknown".
const PROBE_TIMEOUT_MS = 5000;

// "absent" is a definite no: the host answered that the file is not there, or
// the host no longer exists. "unknown" is anything else (unreachable, timed out,
// outside the organization and so never asked).
type Probe = "present" | "absent" | "unknown";

const withTimeout = <T>(
	work: (signal: AbortSignal) => Promise<T>,
	fallback: T,
): Promise<T> => {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(fallback);
		}, PROBE_TIMEOUT_MS);
	});
	return Promise.race([work(controller.signal), timeout]).finally(() =>
		clearTimeout(timer),
	);
};

const isNotFound = (error: unknown) =>
	error instanceof TRPCError && error.code === "NOT_FOUND";

// Only stat's own "No such file or directory" says the file is not there. Its
// exit status 1 alone does not: permission denied and other filesystem errors
// share it, and a shell's 127 / ssh's 255 mean the question was never asked.
const isFileMissing = (error: unknown) =>
	error instanceof ExecError &&
	error.exitCode === 1 &&
	/No such file or directory/.test(error.stderr || error.message);

// What stat -c %F prints for a file that exists but is not a regular file.
const NON_REGULAR_KINDS = new Set([
	"directory",
	"fifo",
	"symbolic link",
	"socket",
	"character special file",
	"block special file",
]);

// stat -c %F names the kind of file; the log must be a regular file. A login
// banner or profile output can come before it on a remote shell, so only the
// last non-empty line is the answer, and a line that is not a kind stat knows
// is no answer at all.
const fileKind = (stdout: string | undefined): Probe => {
	const lines = String(stdout ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const kind = lines.at(-1);
	if (kind === "regular file" || kind === "regular empty file") {
		return "present";
	}
	return kind && NON_REGULAR_KINDS.has(kind) ? "absent" : "unknown";
};

// Does `host` (null = this host) belong to the organization and hold the log?
const probeLog = (
	host: string | null,
	logPath: string,
	organizationId: string,
): Promise<Probe> =>
	withTimeout<Probe>(async (signal) => {
		const command = `LC_ALL=C stat -c %F -- ${quote([logPath])}`;
		try {
			if (host) {
				const server = await findServerById(host);
				// Never contacted, so nothing is known about the file there.
				if (server.organizationId !== organizationId) return "unknown";
				const { stdout } = await execAsyncRemote(host, command, undefined, {
					signal,
				});
				return fileKind(stdout);
			}
			const { stdout } = await execAsync(command);
			return fileKind(stdout);
		} catch (error) {
			return isNotFound(error) || isFileMissing(error) ? "absent" : "unknown";
		}
	}, "unknown");

export const LOG_UNAVAILABLE_MESSAGE =
	"This deployment's log is no longer available on any connected server.";

export type DeploymentLogLocation = {
	host: string | null;
	/**
	 * Every place the log could be answered "not here" (none unreachable), so the
	 * file is gone: for instance the build server that built it was deleted.
	 */
	missing: boolean;
};

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
 * server the owner no longer has is not a candidate. When none has the file the
 * host is `fallbackHost`, as before; `missing` says whether every candidate
 * definitely lacked it, so callers can report the log as gone instead of
 * showing an empty one. A candidate that timed out or could not be reached
 * leaves `missing` false.
 */
export const locateDeploymentLog = async (
	row: LogHostRow & { logPath: string },
	fallbackHost: string | null,
	organizationId: string,
): Promise<DeploymentLogLocation> => {
	if (row.buildServerId) return { host: row.buildServerId, missing: false };
	if (!row.previewDeploymentId) return { host: fallbackHost, missing: false };

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
		hosts.map((host) => probeLog(host, row.logPath, organizationId)),
	);
	const hit = found.indexOf("present");
	if (hit !== -1) return { host: hosts[hit] ?? null, missing: false };
	// The owner's host is unknown when its lookup failed, so the log may be on a
	// host that was never probed: only a full set of definite answers is "gone".
	const missing =
		ownerHost !== undefined &&
		hosts.length > 0 &&
		found.every((probe) => probe === "absent");
	return { host: fallbackHost, missing };
};
