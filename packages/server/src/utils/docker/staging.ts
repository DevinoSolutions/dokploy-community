import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { quote } from "shell-quote";
import { ExecError, truncateOutputTail } from "../process/ExecError";
import { execAsyncRemote, writeFileRemote } from "../process/execAsync";

/**
 * Staging: how a deploy script gets content that may be large (or secret) onto
 * the host that runs it.
 *
 * Deploy scripts travel as ONE shell argument (ssh2 `exec` runs `$SHELL -c
 * "<script>"`, `child_process.exec` does the same locally), and Linux caps a
 * single argument at 128 KB (MAX_ARG_STRLEN). Content embedded in the script
 * as `echo "<base64>" | base64 -d > file` therefore fails with "Argument list
 * too long" once the script grows past ~96 KB of raw content. A staged file
 * goes through SFTP (remote) or `fs` (local) instead, and the script only
 * references its path: `cat staged > destination`.
 *
 * Staged files are created 0600 before they hold content, live next to (never
 * inside) the directories a clone wipes, and are removed by the script that
 * consumes them, on the failure path too.
 */

export const STAGED_FILE_PREFIX = ".dokploy-stage-";
// Staged composes predate the generic prefix; they keep their name.
export const STAGED_COMPOSE_PREFIX = ".dokploy-compose-";
export const STAGED_COMPOSE_SUFFIX = ".yml";
// A staged file is consumed seconds after it is written. Anything older is the
// leftover of a deploy that died between staging and running its script.
export const STAGED_MAX_AGE_MINUTES = 60;

export interface StageOptions {
	/** Names the staged files, so they are unique per deployment. */
	deploymentId?: string;
	/**
	 * Called with the staged paths as soon as they exist, so a caller that can
	 * fail before the script runs (a cancel, a failed earlier step) can remove
	 * them with `removeStagedFiles`.
	 */
	onStaged?: (paths: string[]) => void;
}

export const sanitizeStageId = (id?: string) =>
	(id ?? "").replace(/[^A-Za-z0-9_-]/g, "") || randomUUID();

/** `<directory>/.dokploy-stage-<kind>-<id>[-<index>]`; `kind` is a code constant. */
export const getStagedFilePath = ({
	directory,
	kind,
	deploymentId,
	index,
}: {
	directory: string;
	kind: string;
	deploymentId?: string;
	index?: number;
}) =>
	join(
		directory,
		`${STAGED_FILE_PREFIX}${kind}-${sanitizeStageId(deploymentId)}${index === undefined ? "" : `-${index}`}`,
	);

const isStagedFileName = (name: string) =>
	name.startsWith(STAGED_FILE_PREFIX) ||
	(name.startsWith(STAGED_COMPOSE_PREFIX) &&
		name.endsWith(STAGED_COMPOSE_SUFFIX));

const removeStaleStagedFiles = async (directory: string) => {
	const cutoff = Date.now() - STAGED_MAX_AGE_MINUTES * 60_000;
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		// Housekeeping only: it must never fail the deploy.
		return;
	}
	for (const name of names) {
		if (!isStagedFileName(name)) continue;
		// Per file: a concurrent deploy consuming one between readdir and stat
		// must not stop the sweep of the others.
		try {
			const file = join(directory, name);
			const { mtimeMs } = await stat(file);
			if (mtimeMs < cutoff) await unlink(file);
		} catch {
			// Housekeeping only: the next deploy sweeps what is left.
		}
	}
};

/** Why a remote command failed, from its output only (never the command). */
const describeExecFailure = (error: unknown) => {
	if (error instanceof ExecError) {
		const output = truncateOutputTail(
			error.stderr || error.stdout || error.message,
			500,
		);
		return output || "the command failed";
	}
	return error instanceof Error ? error.message : String(error ?? "");
};

export interface FileToStage {
	/** Path of the staged file. */
	path: string;
	content: string;
}

/**
 * Writes `files` (all inside `directory`) on the host that will run the deploy
 * script: `serverId`, or this machine when unset. The directory is created,
 * stale leftovers are swept, and every file exists 0600 before SFTP / `fs`
 * fills it. A failed write removes what was staged and rethrows.
 */
export const stageFiles = async ({
	serverId,
	directory,
	files,
}: {
	serverId?: string | null;
	directory: string;
	files: FileToStage[];
}) => {
	if (files.length === 0) return;

	if (serverId) {
		const qDirectory = quote([directory]);
		const created = files
			.map((file) => `: > ${quote([file.path])}`)
			.join(" && ");
		try {
			await execAsyncRemote(
				serverId,
				`mkdir -p ${qDirectory} && { find ${qDirectory} -maxdepth 1 \\( -name '${STAGED_FILE_PREFIX}*' -o -name '${STAGED_COMPOSE_PREFIX}*${STAGED_COMPOSE_SUFFIX}' \\) -mmin +${STAGED_MAX_AGE_MINUTES} -exec rm -f {} + 2>/dev/null || true; } && (umask 077 && ${created})`,
			);
		} catch (error) {
			// An ExecError is not written to the deployment log; a plain Error is.
			// The prepare command holds paths only, so its output is safe to show.
			// The cause stays attached: remote-unreachable detection walks it.
			throw new Error(
				`Could not prepare ${directory} on the server to stage files: ${describeExecFailure(error)}`,
				{ cause: error },
			);
		}
		try {
			for (const file of files) {
				await writeFileRemote(serverId, file.path, file.content);
			}
		} catch (error) {
			await removeStagedFiles(
				serverId,
				files.map((file) => file.path),
			);
			throw error;
		}
		return;
	}

	await mkdir(directory, { recursive: true });
	await removeStaleStagedFiles(directory);
	try {
		for (const file of files) {
			await writeFile(file.path, file.content, { mode: 0o600 });
		}
	} catch (error) {
		await removeStagedFiles(
			serverId,
			files.map((file) => file.path),
		);
		throw error;
	}
};

/** Best-effort removal. It must never mask the error that made it necessary. */
export const removeStagedFiles = async (
	serverId: string | null | undefined,
	paths: string[],
) => {
	if (paths.length === 0) return;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, `rm -f ${quote(paths)}`);
		} else {
			await Promise.all(paths.map((path) => unlink(path).catch(() => {})));
		}
	} catch {
		// Left for the stale sweep.
	}
};

/**
 * Shell snippet that copies a staged file over its destination (`cat >`, so an
 * existing destination keeps its mode and ownership) and removes the staged
 * file. The failure path removes it too, plus any `alsoRemove` (the other
 * files staged for the same script), then stops the script. `failureMessage`
 * is a fixed string: it must never carry content.
 *
 * `prepare` is a command (already quoted) that has to succeed before the copy,
 * e.g. `mkdir -p <dir>`. It runs inside the guarded group: under `set -e` a
 * failing `mkdir` outside of it would end the script with the staged file
 * still on disk.
 */
export const getInstallStagedFileCommand = ({
	staged,
	destination,
	failureMessage,
	alsoRemove = [],
	prepare,
}: {
	staged: string;
	destination: string;
	failureMessage: string;
	alsoRemove?: string[];
	prepare?: string;
}) => {
	const qStaged = quote([staged]);
	const qDestination = quote([destination]);
	const extra = alsoRemove.map((path) => ` ${quote([path])}`).join("");
	const before = prepare ? `${prepare} && ` : "";
	return `{ ${before}cat ${qStaged} > ${qDestination} && rm -f ${qStaged}; } || { rm -f ${qStaged}${extra}; echo "${failureMessage}"; exit 1; };`;
};
