import { appendFile } from "node:fs/promises";
import { quote } from "shell-quote";
import { execAsyncRemote } from "../process/execAsync";

// Best effort: the log is where the run's output went (the server it ran on, or
// this host), and a log that cannot be written must not fail the run's end.
export const appendRunLog = async (
	logServerId: string | null,
	logPath: string,
	line: string,
) => {
	try {
		if (logServerId) {
			await execAsyncRemote(
				logServerId,
				`echo ${quote([line])} >> ${quote([logPath])}`,
			);
		} else {
			await appendFile(logPath, `${line}\n`);
		}
	} catch (error) {
		console.error(`Failed to write to the log ${logPath}:`, error);
	}
};
