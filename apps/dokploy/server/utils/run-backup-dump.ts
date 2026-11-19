import {
	type findBackupById,
	findComposeByBackupId,
	findLibsqlByBackupId,
	findMariadbByBackupId,
	findMongoByBackupId,
	findMySqlByBackupId,
	findPostgresByBackupId,
	keepLatestNBackups,
	runLibsqlBackup,
	runMariadbBackup,
	runMongoBackup,
	runMySqlBackup,
	runPostgresBackup,
} from "@dokploy/server";
import { runComposeBackup } from "@dokploy/server/utils/backups/compose";

export type BackupDumpTarget =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "libsql"
	| "compose";

/**
 * Runs one database dump for a backup row, then applies its retention. The
 * per-service manual endpoints (`backup.manualBackup*`) and the backup policy
 * "run now" loop dispatch through here, so a new service kind is wired in one
 * place. `target` is the kind of service the caller already authorized the row
 * against; anything outside the supported kinds (the instance backup, for
 * one) is refused.
 */
export const runBackupDump = async (
	target: BackupDumpTarget | "web-server",
	backup: Awaited<ReturnType<typeof findBackupById>>,
) => {
	switch (target) {
		case "postgres": {
			const service = await findPostgresByBackupId(backup.backupId);
			await runPostgresBackup(service, backup);
			await keepLatestNBackups(backup, service?.serverId);
			break;
		}
		case "mysql": {
			const service = await findMySqlByBackupId(backup.backupId);
			await runMySqlBackup(service, backup);
			await keepLatestNBackups(backup, service?.serverId);
			break;
		}
		case "mariadb": {
			const service = await findMariadbByBackupId(backup.backupId);
			await runMariadbBackup(service, backup);
			await keepLatestNBackups(backup, service?.serverId);
			break;
		}
		case "mongo": {
			const service = await findMongoByBackupId(backup.backupId);
			await runMongoBackup(service, backup);
			await keepLatestNBackups(backup, service?.serverId);
			break;
		}
		case "libsql": {
			const service = await findLibsqlByBackupId(backup.backupId);
			await runLibsqlBackup(service, backup);
			await keepLatestNBackups(backup, service?.serverId);
			break;
		}
		case "compose": {
			const service = await findComposeByBackupId(backup.backupId);
			await runComposeBackup(service, backup);
			await keepLatestNBackups(backup, service?.serverId);
			break;
		}
		default:
			throw new Error(`Unsupported database type "${target}"`);
	}
};
