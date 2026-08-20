import {
	MAX_EXEC_OUTPUT_TAIL,
	truncateOutputTail,
} from "../process/ExecError";
import { execAsync, ExecError, execAsyncRemote } from "../process/execAsync";
import { redactSecrets } from "../process/redactSecrets";

// Backup pipelines redirect ALL of their output (stdout AND stderr) into the
// per-run deployment log file: `(<command>) >> <logPath> 2>&1`. That is great
// for the log viewer but it means the ExecError thrown when the command fails
// carries an EMPTY stderr — volume-backup tar failures reached notifications
// and Sentry as an error with no message at all, which made them impossible to
// diagnose without SSH access to the box.
//
// These helpers read back the tail of that log file (local or over SSH, the
// same way the backup itself ran) and fold it into the error message, so the
// notification / Sentry event finally says WHY the backup failed.

/** Max characters of captured output kept in an error message. */
export const MAX_BACKUP_LOG_TAIL = MAX_EXEC_OUTPUT_TAIL;

/**
 * Read the tail of a backup's log file, from the same host the backup ran on.
 * Best-effort: any failure to read it (file missing, server unreachable)
 * returns an empty string so the original error is still reported.
 */
export const readBackupLogTail = async (
	logPath: string,
	serverId?: string | null,
	limit = MAX_BACKUP_LOG_TAIL,
): Promise<string> => {
	if (!logPath) {
		return "";
	}
	const command = `tail -c ${limit} "${logPath}"`;
	try {
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		return stdout.trim();
	} catch {
		return "";
	}
};

/**
 * Build an error message that actually explains the failure: the thrown error's
 * message, plus whatever output we could recover (the ExecError's own stderr
 * when it has one, otherwise the tail of the run's log file).
 *
 * Output is redacted the same way ExecError redacts its own fields — the
 * unredacted text stays in the log file on the server.
 */
export const buildBackupErrorMessage = (
	error: unknown,
	logTail = "",
	limit = MAX_BACKUP_LOG_TAIL,
): string => {
	const baseMessage =
		error instanceof Error ? error.message.trim() : String(error).trim();

	const execStderr =
		error instanceof ExecError ? (error.stderr || "").trim() : "";
	const details = execStderr || logTail.trim();

	if (!details) {
		return baseMessage || "Backup failed without an error message";
	}

	const redactedDetails = truncateOutputTail(redactSecrets(details), limit);

	// Don't repeat output that the error message already carries (Node's local
	// exec error message embeds the command's stderr).
	if (baseMessage.includes(redactedDetails)) {
		return baseMessage;
	}

	return baseMessage
		? `${baseMessage}\nOutput: ${redactedDetails}`
		: `Backup failed. Output: ${redactedDetails}`;
};
