import { GENERIC_RCLONE_PROVIDER } from "@dokploy/server/db/validations/destination";
import { logger } from "@dokploy/server/lib/logger";

export { GENERIC_RCLONE_PROVIDER };

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Destination } from "@dokploy/server/services/destination";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { quote } from "shell-quote";

const execFileP = promisify(execFile);

import { keepLatestNBackups } from ".";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { runComposeBackup } from "./compose";
import { withBackupSlot } from "./concurrency";
import { runLibsqlBackup } from "./libsql";
import { runMariadbBackup } from "./mariadb";
import { runMongoBackup } from "./mongo";
import { runMySqlBackup } from "./mysql";
import { runPostgresBackup } from "./postgres";
import { redactRcloneCredentials } from "./redact";
import { runWebServerBackup } from "./web-server";

export const scheduleBackup = (backup: BackupSchedule) => {
	const {
		schedule,
		backupId,
		databaseType,
		postgres,
		mysql,
		mongo,
		mariadb,
		libsql,
		compose,
	} = backup;
	// Scheduled runs share a global per-server concurrency limit so a burst of
	// policy-materialized backups on the same cron can't fire all at once.
	const serverKey =
		backup.backupType === "compose"
			? compose?.serverId
			: (postgres?.serverId ??
				mysql?.serverId ??
				mongo?.serverId ??
				mariadb?.serverId ??
				libsql?.serverId);
	scheduleJob(backupId, schedule, async () => {
		await withBackupSlot(serverKey, backupId, async () => {
			// A stopped database is not a backup failure: skip quietly instead of
			// erroring on every tick (see shouldSkipStoppedBackup).
			if (await skipScheduledBackupIfStopped(backup)) {
				return;
			}
			if (backup.backupType === "database") {
				if (databaseType === "postgres" && postgres) {
					await runPostgresBackup(postgres, backup);
					await keepLatestNBackups(backup, postgres.serverId);
				} else if (databaseType === "mysql" && mysql) {
					await runMySqlBackup(mysql, backup);
					await keepLatestNBackups(backup, mysql.serverId);
				} else if (databaseType === "mongo" && mongo) {
					await runMongoBackup(mongo, backup);
					await keepLatestNBackups(backup, mongo.serverId);
				} else if (databaseType === "mariadb" && mariadb) {
					await runMariadbBackup(mariadb, backup);
					await keepLatestNBackups(backup, mariadb.serverId);
				} else if (databaseType === "libsql" && libsql) {
					await runLibsqlBackup(libsql, backup);
					await keepLatestNBackups(backup, libsql.serverId);
				} else if (databaseType === "web-server") {
					await runWebServerBackup(backup);
					await keepLatestNBackups(backup);
				}
			} else if (backup.backupType === "compose" && compose) {
				await runComposeBackup(compose, backup);
				await keepLatestNBackups(backup, compose.serverId);
			}
		});
	});
};

export const removeScheduleBackup = (backupId: string) => {
	const currentJob = scheduledJobs[backupId];
	currentJob?.cancel();
};

export const getBackupTimestamp = () =>
	new Date().toISOString().replace(/[:.]/g, "-");

export const normalizeS3Path = (prefix: string) => {
	// Trim whitespace and remove leading/trailing slashes
	const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
	// Return empty string if prefix is empty, otherwise append trailing slash
	return normalizedPrefix ? `${normalizedPrefix}/` : "";
};

// The rclone helpers only read S3 config fields, so they accept either a full
// Destination row or the create-input (which lacks DB-generated metadata).
type RcloneDestination = Pick<
	Destination,
	| "provider"
	| "bucket"
	| "accessKey"
	| "secretAccessKey"
	| "region"
	| "endpoint"
	| "additionalFlags"
>;

export const isGenericRcloneDestination = (destination: RcloneDestination) =>
	destination.provider === GENERIC_RCLONE_PROVIDER;

export const getRcloneDestination = (destination: RcloneDestination) =>
	isGenericRcloneDestination(destination)
		? destination.bucket
		: `:s3:${destination.bucket}`;

export const getRcloneCredentials = (destination: RcloneDestination) => {
	const { accessKey, secretAccessKey, region, endpoint, provider } =
		destination;

	if (isGenericRcloneDestination(destination)) {
		return destination.additionalFlags?.length
			? [...destination.additionalFlags]
			: [];
	}

	const rcloneFlags = [
		`--s3-access-key-id=${quote([accessKey])}`,
		`--s3-secret-access-key=${quote([secretAccessKey])}`,
		`--s3-region=${quote([region])}`,
		`--s3-endpoint=${quote([endpoint])}`,
		"--s3-no-check-bucket",
		"--s3-force-path-style",
	];

	if (provider) {
		rcloneFlags.unshift(`--s3-provider=${quote([provider])}`);
	}

	if (destination.additionalFlags?.length) {
		rcloneFlags.push(...destination.additionalFlags);
	}

	return rcloneFlags;
};

export const getRcloneTestFlags = (destination: RcloneDestination) => [
	...getRcloneCredentials(destination),
	"--retries 1",
	"--low-level-retries 1",
	"--timeout 10s",
	"--contimeout 5s",
];

export const getS3Credentials = getRcloneCredentials;

// Rclone crypt (destination-side encryption at rest) helpers.
// When a destination has encryption enabled, backups are wrapped in rclone's
// native crypt backend (NaCl SecretBox: XSalsa20 + Poly1305) and filenames are
// optionally encrypted too.
//
// The crypt backend is configured entirely through backend-specific ENVIRONMENT
// VARIABLES (RCLONE_CRYPT_*) rather than an on-the-fly connection string. That
// matters: a connection string has to quote the wrapped remote (e.g.
// remote=":s3:bucket") because it contains colons, but that inner quoting does
// NOT survive the extra shell parse that execAsync/execAsyncRemote performs — the
// shell strips the quotes and rclone then mis-parses the remote. Passing the
// wrapped remote via RCLONE_CRYPT_REMOTE keeps the rclone path a plain `:crypt:`
// remote with no quoting to lose, and the passwords never appear in argv.
//
// Passwords are obscured with `rclone obscure` (like the SFTP/FTP branch) because
// the crypt backend expects obscured passwords. Crypt wraps the S3 and generic
// rclone remotes only (SFTP/FTP is out of scope).
// @see https://rclone.org/crypt/  @see https://rclone.org/docs/#backend-specific-environment-variables
const FILENAME_ENCRYPTION_VALUES = ["off", "standard", "obfuscate"] as const;

export const isDestinationEncrypted = (
	destination: Pick<Destination, "encryptionEnabled" | "encryptionKey">,
) => Boolean(destination.encryptionEnabled && destination.encryptionKey);

// Build the RCLONE_CRYPT_* environment variable prefix for a crypt-wrapped
// remote. `remoteRoot` is the underlying remote (e.g. `:s3:bucket` or a generic
// remote spec) that crypt should encrypt into.
const getCryptEnvVars = async (
	destination: Destination,
	remoteRoot: string,
): Promise<string> => {
	const filenameEncryption = FILENAME_ENCRYPTION_VALUES.includes(
		destination.filenameEncryption as (typeof FILENAME_ENCRYPTION_VALUES)[number],
	)
		? destination.filenameEncryption
		: "off";
	const directoryNameEncryption = destination.directoryNameEncryption ?? false;

	// Single-quote each value for the shell and escape embedded single quotes
	// (' -> '\''). Callers must prepend these via buildRcloneCommand.
	const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

	const obscuredKey = await obscurePassword(destination.encryptionKey || "");
	let envVars =
		`RCLONE_CRYPT_REMOTE=${shellQuote(remoteRoot)}` +
		` RCLONE_CRYPT_FILENAME_ENCRYPTION=${filenameEncryption}` +
		` RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION=${directoryNameEncryption}` +
		` RCLONE_CRYPT_PASSWORD=${shellQuote(obscuredKey)}`;
	if (destination.encryptionPassword2) {
		const obscuredPassword2 = await obscurePassword(
			destination.encryptionPassword2,
		);
		envVars += ` RCLONE_CRYPT_PASSWORD2=${shellQuote(obscuredPassword2)}`;
	}
	return envVars;
};

/**
 * Prepend rclone crypt password environment variables to a command when the
 * destination has encryption enabled. `envVars` comes from getRclonePathAndFlags
 * (empty string when the destination is not encrypted).
 */
export const buildRcloneCommand = (
	command: string,
	envVars?: string,
): string => (envVars ? `${envVars} ${command}` : command);

// User-controlled values (database name, user, password) are passed to the
// container as environment variables via `docker exec -e VAR=<escaped>` and
// referenced as "$VAR" inside the inner shell, so they never appear in the
// inner command text. The -e value is escaped for the outer shell with
// shell-quote; the inner script is single-quoted and reads the env vars.
export const getPostgresBackupCommand = (
	database: string,
	databaseUser: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -i $CONTAINER_ID bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U "$DB_USER" --no-password "$DB_NAME" | gzip'`;
};

// MariaDB 11+ images renamed the client binaries (`mysqldump` → `mariadb-dump`)
// and ship `mysqldump` only as a deprecated alias — or not at all. Older MariaDB
// and every MySQL image ship `mysqldump` and have no `mariadb-dump`. On top of
// that, users routinely register a MariaDB container as a "mysql" service (a
// real production case: Uptime Kuma's MariaDB), so either binary can be the only
// one present regardless of the service type. Pick whichever actually exists
// inside the container at run time instead of hardcoding one; both accept the
// exact same flags used below (mariadb-dump keeps --no-tablespaces and
// --default-character-set for drop-in mysqldump compatibility).
export const getDumpBinarySelection = (
	preferred: "mariadb-dump" | "mysqldump",
) => {
	const fallback = preferred === "mariadb-dump" ? "mysqldump" : "mariadb-dump";
	return `if command -v ${preferred} >/dev/null 2>&1; then DUMP_BIN=${preferred}; else DUMP_BIN=${fallback}; fi;`;
};

export const getMariadbBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; ${getDumpBinarySelection("mariadb-dump")} "$DUMP_BIN" --user="$DB_USER" --password="$DB_PASS" --single-transaction --quick --databases "$DB_NAME" | gzip'`;
};

export const getMysqlBackupCommand = (
	database: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; ${getDumpBinarySelection("mysqldump")} "$DUMP_BIN" --default-character-set=utf8mb4 -u root --password="$DB_PASS" --single-transaction --no-tablespaces --quick "$DB_NAME" | gzip'`;
};

export const getMongoBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	const dbFlag = database ? '-d "$DB_NAME" ' : "";
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mongodump ${dbFlag}-u "$DB_USER" -p "$DB_PASS" --archive --authenticationDatabase admin --gzip'`;
};

export const getLibsqlBackupCommand = (database: string) => {
	return `docker exec -e DB_NAME=${quote([database])} -i $CONTAINER_ID sh -c 'tar cf - -C /var/lib/sqld "$DB_NAME" | gzip'`;
};

export const getServiceContainerCommand = (appName: string) => {
	return `docker ps -q --filter "status=running" --filter "label=com.docker.swarm.service.name=${appName}" | head -n 1`;
};

export const getComposeContainerCommand = (
	appName: string,
	serviceName: string,
	composeType: "stack" | "docker-compose" | undefined,
) => {
	if (composeType === "stack") {
		return `docker ps -q --filter "status=running" --filter "label=com.docker.stack.namespace=${appName}" --filter "label=com.docker.swarm.service.name=${appName}_${serviceName}" | head -n 1`;
	}
	return `docker ps -q --filter "status=running" --filter "label=com.docker.compose.project=${appName}" --filter "label=com.docker.compose.service=${serviceName}" | head -n 1`;
};

const getContainerSearchCommand = (backup: BackupSchedule) => {
	const {
		backupType,
		postgres,
		mysql,
		mariadb,
		mongo,
		libsql,
		compose,
		serviceName,
	} = backup;

	if (backupType === "database") {
		const appName =
			postgres?.appName ||
			mysql?.appName ||
			mariadb?.appName ||
			mongo?.appName ||
			libsql?.appName;
		return getServiceContainerCommand(appName || "");
	}
	if (backupType === "compose") {
		const { appName, composeType } = compose || {};
		return getComposeContainerCommand(
			appName || "",
			serviceName || "",
			composeType,
		);
	}
};

export type BackupRunTrigger = "schedule" | "manual";
export type BackupTargetState = "running" | "stopped" | "unknown";

// Which server the backup's target service lives on (null = the Dokploy host).
export const getBackupServerId = (backup: BackupSchedule): string | null => {
	const { backupType, postgres, mysql, mariadb, mongo, libsql, compose } =
		backup;
	if (backupType === "compose") {
		return compose?.serverId ?? null;
	}
	return (
		postgres?.serverId ??
		mysql?.serverId ??
		mariadb?.serverId ??
		mongo?.serverId ??
		libsql?.serverId ??
		null
	);
};

// The same `docker ps --filter status=running` lookup the dump pipeline itself
// performs, so the pre-flight answer always matches what the dump would find.
// Returns null when the target can't be resolved (web-server backups, missing
// appName/serviceName) — the caller then treats the state as unknown and runs
// the backup as before.
const getBackupTargetSearchCommand = (backup: BackupSchedule): string | null => {
	const {
		backupType,
		databaseType,
		postgres,
		mysql,
		mariadb,
		mongo,
		libsql,
		compose,
		serviceName,
	} = backup;

	if (databaseType === "web-server") {
		return null;
	}

	if (backupType === "database") {
		const appName =
			postgres?.appName ||
			mysql?.appName ||
			mariadb?.appName ||
			mongo?.appName ||
			libsql?.appName;
		return appName ? getServiceContainerCommand(appName) : null;
	}

	if (backupType === "compose") {
		const { appName, composeType } = compose || {};
		if (!appName || !serviceName) {
			return null;
		}
		return getComposeContainerCommand(appName, serviceName, composeType);
	}

	return null;
};

/**
 * Skip policy for a backup whose target database is not running.
 *
 * A "backup everything" policy materializes a schedule for every database,
 * including the ones that are intentionally stopped. Those runs used to fail
 * with "Container not found" on every tick, producing an endless stream of
 * failure notifications and Sentry ExecErrors. Scheduled runs now skip such a
 * target instead; a user-triggered ("manual") run must still surface a real
 * error, because there the user explicitly asked for a backup now.
 *
 * Kept pure so the policy is unit-testable without docker.
 */
export const shouldSkipStoppedBackup = ({
	trigger,
	backupType,
	databaseType,
	targetState,
}: {
	trigger: BackupRunTrigger;
	backupType: BackupSchedule["backupType"];
	databaseType: BackupSchedule["databaseType"];
	targetState: BackupTargetState;
}): boolean => {
	// Manual runs always attempt and report the real failure.
	if (trigger !== "schedule") {
		return false;
	}
	// Web-server backups don't dump a database container.
	if (databaseType === "web-server") {
		return false;
	}
	if (backupType !== "database" && backupType !== "compose") {
		return false;
	}
	// "unknown" (docker/SSH unreachable) must never skip: that would hide a real
	// outage. Only a confirmed "no running container" skips.
	return targetState === "stopped";
};

export const getBackupTargetState = async (
	backup: BackupSchedule,
): Promise<BackupTargetState> => {
	const searchCommand = getBackupTargetSearchCommand(backup);
	if (!searchCommand) {
		return "unknown";
	}

	try {
		const serverId = getBackupServerId(backup);
		const { stdout } = serverId
			? await execAsyncRemote(serverId, searchCommand)
			: await execAsync(searchCommand);
		return stdout.trim() ? "running" : "stopped";
	} catch (error) {
		// Can't tell (docker down, SSH failure) — fall through to the normal run
		// so the real error is still reported.
		logger.warn(
			{ backupId: backup.backupId, error },
			"Could not determine whether the backup target is running",
		);
		return "unknown";
	}
};

/**
 * Pre-flight check for SCHEDULED backup runs. Returns true when the run was
 * skipped (target database is stopped), in which case the caller must return
 * without dumping, notifying or throwing.
 */
export const skipScheduledBackupIfStopped = async (
	backup: BackupSchedule,
): Promise<boolean> => {
	const targetState = await getBackupTargetState(backup);
	const skip = shouldSkipStoppedBackup({
		trigger: "schedule",
		backupType: backup.backupType,
		databaseType: backup.databaseType,
		targetState,
	});

	if (skip) {
		logger.info(
			{
				backupId: backup.backupId,
				backupType: backup.backupType,
				databaseType: backup.databaseType,
			},
			"[Backup] Skipping scheduled backup: target database is not running",
		);
	}

	return skip;
};

export const generateBackupCommand = (backup: BackupSchedule) => {
	const { backupType, databaseType } = backup;
	switch (databaseType) {
		case "postgres": {
			const postgres = backup.postgres;
			if (backupType === "database" && postgres) {
				return getPostgresBackupCommand(backup.database, postgres.databaseUser);
			}
			if (backupType === "compose" && backup.metadata?.postgres) {
				return getPostgresBackupCommand(
					backup.database,
					backup.metadata.postgres.databaseUser,
				);
			}
			break;
		}
		case "mysql": {
			const mysql = backup.mysql;
			if (backupType === "database" && mysql) {
				return getMysqlBackupCommand(
					backup.database,
					mysql.databaseRootPassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mysql) {
				return getMysqlBackupCommand(
					backup.database,
					backup.metadata?.mysql?.databaseRootPassword || "",
				);
			}
			break;
		}
		case "mariadb": {
			const mariadb = backup.mariadb;
			if (backupType === "database" && mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					mariadb.databaseUser,
					mariadb.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					backup.metadata.mariadb.databaseUser,
					backup.metadata.mariadb.databasePassword,
				);
			}
			break;
		}
		case "mongo": {
			const mongo = backup.mongo;
			if (backupType === "database" && mongo) {
				return getMongoBackupCommand(
					backup.database,
					mongo.databaseUser,
					mongo.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mongo) {
				return getMongoBackupCommand(
					backup.database,
					backup.metadata.mongo.databaseUser,
					backup.metadata.mongo.databasePassword,
				);
			}
			break;
		}
		case "libsql": {
			if (backupType === "database") {
				return getLibsqlBackupCommand(backup.database);
			}
			break;
		}
		default:
			throw new Error(`Database type not supported: ${databaseType}`);
	}

	return null;
};

export const getBackupCommand = (
	backup: BackupSchedule,
	rcloneCommand: string,
	logPath: string,
) => {
	const containerSearch = getContainerSearchCommand(backup);
	const backupCommand = generateBackupCommand(backup);
	const destinationType = ["sftp", "ftp"].includes(
		backup.destination?.provider || "",
	)
		? backup.destination?.provider?.toUpperCase() || "remote"
		: "S3";

	// A failed streamed upload can leave a TRUNCATED object at the destination.
	// That partial object then counts toward keepLatestNBackups retention and can
	// evict a good backup, so remove it best-effort on any failure. The delete
	// reuses the SAME remote path, flags and env as the rcat upload (rcloneCommand
	// is built by buildRcloneCommand, so a crypt env prefix is preserved) — we only
	// swap the `rcat` verb for `deletefile`. rcloneCommand may start with that env
	// prefix rather than `rclone`, so match the verb anywhere in the string.
	const rcloneCleanupCommand = rcloneCommand.includes("rclone rcat ")
		? `${rcloneCommand.replace(
				"rclone rcat ",
				"rclone deletefile ",
			)} >/dev/null 2>&1 || true;`
		: "";
	const cleanupPartialUpload = rcloneCleanupCommand
		? `echo "[$(date)] Cleaning up partial upload from ${destinationType}..." >> ${logPath};
		${rcloneCleanupCommand}`
		: "";

	logger.info(
		{
			containerSearch,
			backupCommand,
			rcloneCommand: redactRcloneCredentials(rcloneCommand),
			logPath,
		},
		`Executing backup command: ${backup.databaseType} ${backup.backupType}`,
	);

	return `
	set -eo pipefail;
	echo "[$(date)] Starting backup process..." >> ${logPath};
	echo "[$(date)] Executing backup command..." >> ${logPath};
	CONTAINER_ID=$(${containerSearch})

	if [ -z "$CONTAINER_ID" ]; then
		echo "[$(date)] ❌ Error: Container not found" >> ${logPath};
		exit 1;
	fi

	echo "[$(date)] Container Up: $CONTAINER_ID" >> ${logPath};
	echo "[$(date)] Streaming backup to ${destinationType}..." >> ${logPath};

	# Stream the dump straight to the destination. The dump runs ONCE; "set -o
	# pipefail" makes the pipeline fail if the dump (not just rclone) fails, so a
	# broken backup never reports success. Running the dump a second time to
	# "validate" it would double the load on the database and risk an inconsistent
	# copy. The dump's exit code and stderr are captured through temp files so a
	# dump failure ("Backup failed") stays distinguishable from an upload failure
	# ("Upload to ... failed"). Because the pipeline is on the left of "||", set -e
	# is ignored inside it, so "echo $? > status" always records the dump's code.
	DUMP_STATUS_FILE=$(mktemp);
	DUMP_ERROR_FILE=$(mktemp);
	trap 'rm -f "$DUMP_STATUS_FILE" "$DUMP_ERROR_FILE"' EXIT;

	UPLOAD_FAILED=0;
	UPLOAD_OUTPUT=$({ ${backupCommand} 2> "$DUMP_ERROR_FILE"; echo $? > "$DUMP_STATUS_FILE"; } | ${rcloneCommand} 2>&1 >/dev/null) || UPLOAD_FAILED=1;
	DUMP_STATUS=$(cat "$DUMP_STATUS_FILE");

	if [ "$DUMP_STATUS" != "0" ]; then
		# Dump failure takes precedence: a failed dump also fails the upload stage.
		echo "[$(date)] ❌ Error: Backup failed" >> ${logPath};
		echo "Error: $(cat "$DUMP_ERROR_FILE")" >> ${logPath};
		${cleanupPartialUpload}
		exit 1;
	fi

	if [ "$UPLOAD_FAILED" != "0" ]; then
		echo "[$(date)] ❌ Error: Upload to ${destinationType} failed" >> ${logPath};
		echo "Error: $UPLOAD_OUTPUT" >> ${logPath};
		${cleanupPartialUpload}
		exit 1;
	fi

	echo "[$(date)] ✅ Upload to ${destinationType} completed successfully" >> ${logPath};
	echo "Backup done ✅" >> ${logPath};
	`;
};

export const obscurePassword = async (password: string) => {
	try {
		const { stdout } = await execFileP("rclone", ["obscure", password]);
		return stdout.trim();
	} catch (error) {
		logger.error("Error obscuring password with rclone", error);
		return password;
	}
};

export const getRclonePathAndFlags = async (
	destination: Destination,
	subPath: string,
) => {
	// Generic rclone remote: the user supplies a full remote spec (in `bucket`)
	// plus their own rclone flags (additionalFlags, already validated against
	// ADDITIONAL_FLAG_REGEX at the schema layer). We don't build an S3/SFTP
	// connection string for it, but the remote spec and subPath are still
	// interpolated into a shell command, so validate them the same way the
	// SFTP/FTP branch validates its path segments to prevent shell injection.
	if (isGenericRcloneDestination(destination)) {
		// Charset safe to embed inside the quoted shell command; rclone remote
		// specs legitimately contain ":" and "/", so allow those but forbid
		// shell metacharacters, quotes and whitespace.
		const genericPathSafe = /^[^"'$\\`;|&<>()\s]*$/;
		if (!genericPathSafe.test(destination.bucket)) {
			throw new Error("Invalid rclone remote: contains forbidden characters");
		}
		if (!genericPathSafe.test(subPath)) {
			throw new Error(
				"Invalid rclone backup path: contains forbidden characters",
			);
		}
		const flags = destination.additionalFlags?.length
			? [...destination.additionalFlags]
			: [];
		if (isDestinationEncrypted(destination)) {
			return {
				flags,
				path: `:crypt:${subPath}`,
				envVars: await getCryptEnvVars(destination, destination.bucket),
			};
		}
		const path = `${destination.bucket}/${subPath}`;
		return { flags, path, envVars: "" };
	}

	const isS3 = !["sftp", "ftp"].includes(destination.provider || "");
	if (isS3) {
		const flags = getS3Credentials(destination);
		if (isDestinationEncrypted(destination)) {
			return {
				flags,
				path: `:crypt:${subPath}`,
				envVars: await getCryptEnvVars(
					destination,
					`:s3:${destination.bucket}`,
				),
			};
		}
		const path = `:s3:${destination.bucket}/${subPath}`;
		return { flags, path, envVars: "" };
	}
	const provider = destination.provider;
	// The SFTP/FTP connection string below is interpolated into a shell command.
	// These fields are user-supplied (destination form), so validate them strictly
	// to prevent shell/connection-string injection before building the string.
	// Charset that is safe to embed inside the quoted shell command (no shell
	// metacharacters, quotes, or whitespace).
	const shellSafe = /^[^"'$\\`;|&<>()\s]+$/;
	// Path segments may additionally contain "/".
	const pathSafe = /^[^"'$\\`;|&<>()\s]*$/;

	if (!/^[a-zA-Z0-9.-]+$/.test(destination.endpoint)) {
		throw new Error(
			`Invalid ${provider?.toUpperCase() || "SFTP/FTP"} host: only letters, digits, dots and hyphens are allowed`,
		);
	}
	if (destination.region && !/^\d{1,5}$/.test(destination.region)) {
		throw new Error(
			`Invalid ${provider?.toUpperCase() || "SFTP/FTP"} port: must be a number`,
		);
	}
	if (!shellSafe.test(destination.accessKey)) {
		throw new Error(
			`Invalid ${provider?.toUpperCase() || "SFTP/FTP"} user: contains forbidden characters`,
		);
	}
	if (!pathSafe.test(destination.bucket)) {
		throw new Error(
			`Invalid ${provider?.toUpperCase() || "SFTP/FTP"} path: contains forbidden characters`,
		);
	}
	if (!pathSafe.test(subPath)) {
		throw new Error(
			`Invalid ${provider?.toUpperCase() || "SFTP/FTP"} backup path: contains forbidden characters`,
		);
	}

	const obscuredPass = await obscurePassword(destination.secretAccessKey);
	const path = `:${provider},host="${destination.endpoint}",port="${destination.region}",user="${destination.accessKey}",pass="${obscuredPass}":${destination.bucket}/${subPath}`;
	// SFTP/FTP crypt is not supported (see wrapWithCrypt note); encryption fields
	// are ignored for these providers.
	return { flags: [], path, envVars: "" };
};
