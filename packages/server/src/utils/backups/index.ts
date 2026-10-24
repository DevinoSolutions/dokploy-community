import { member } from "@dokploy/server/db/schema";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import { findDestinationById } from "@dokploy/server/services/destination";
import { getAllServers } from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { db } from "../../db/index";
import { startLogCleanup } from "../access-log/handler";
import {
	scheduleDockerCleanup,
	WEB_SERVER_CLEANUP_JOB,
} from "../docker/cleanup-job";
import { sendDockerCleanupNotifications } from "../notifications/docker-cleanup";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { redactRcloneCredentials } from "./redact";
import {
	getRclonePathAndFlags,
	normalizeS3Path,
	scheduleBackup,
} from "./utils";

export const initCronJobs = async () => {
	console.log("Setting up cron jobs....");

	const webServerSettings = await getWebServerSettings();

	if (webServerSettings?.enableDockerCleanup) {
		try {
			scheduleDockerCleanup({
				jobName: WEB_SERVER_CLEANUP_JOB,
				hostLabel: "the Dokploy server",
				cron: webServerSettings.dockerCleanupCron,
				afterCleanup: async () => {
					const owner = await db.query.member.findFirst({
						where: eq(member.role, "owner"),
					});
					if (owner) {
						await sendDockerCleanupNotifications(owner.organizationId);
					}
				},
			});
		} catch (error) {
			console.error("[Backup] Docker Cleanup Error", error);
		}
	}

	const servers = await getAllServers();

	for (const server of servers) {
		const { serverId, enableDockerCleanup, name, organizationId } = server;
		if (enableDockerCleanup) {
			try {
				scheduleDockerCleanup({
					jobName: serverId,
					serverId,
					hostLabel: `server ${name} (${serverId})`,
					cron: server.dockerCleanupCron,
					afterCleanup: () =>
						sendDockerCleanupNotifications(
							organizationId,
							`Docker cleanup for Server ${name} (${serverId})`,
						),
				});
			} catch (error) {
				console.error(`[Backup] ${error}`);
			}
		}
	}

	const backups = await db.query.backups.findMany({
		with: {
			destination: true,
			postgres: true,
			mariadb: true,
			mysql: true,
			mongo: true,
			libsql: true,
			user: true,
			compose: true,
		},
	});

	for (const backup of backups) {
		try {
			if (backup.enabled) {
				scheduleBackup(backup);
				console.log(
					`[Backup] ${backup.databaseType} Enabled with cron: [${backup.schedule}]`,
				);
			}
		} catch (error) {
			console.error(`[Backup] ${backup.databaseType} Error`, error);
		}
	}

	if (webServerSettings?.logCleanupCron) {
		try {
			console.log(
				"Starting log requests cleanup",
				webServerSettings.logCleanupCron,
			);
			await startLogCleanup(webServerSettings.logCleanupCron);
		} catch (error) {
			console.error("[Backup] Log Cleanup Error", error);
		}
	}
};

export const keepLatestNBackups = async (
	backup: BackupSchedule,
	serverId?: string | null,
) => {
	// 0 also immediately returns which is good as the empty "keep latest" field in the UI
	// is saved as 0 in the database
	if (!backup.keepLatestCount) return;

	try {
		const destination = await findDestinationById(backup.destinationId);
		const {
			flags: rcloneFlags,
			path: backupFilesPath,
			envVars,
		} = await getRclonePathAndFlags(
			destination,
			normalizeS3Path(backup.prefix),
		);

		// --include "*.bson.gz" or "*.sql.gz" or "*.zip" ensures nothing else other than the dokploy backup files are touched by rclone
		const rcloneList = `rclone lsf ${rcloneFlags.join(" ")} --include "*${backup.databaseType === "web-server" ? ".zip" : ".{sql.gz,bson.gz}"}" ${quote([backupFilesPath])}`;
		// when we pipe the above command with this one, we only get the list of files we want to delete
		const sortAndPickUnwantedBackups = `sort -r | tail -n +$((${backup.keepLatestCount}+1)) | xargs -I{}`;
		// this command deletes the files
		// to test the deletion before actually deleting we can add --dry-run before ${backupFilesPath}{}
		const rcloneDelete = `rclone delete ${rcloneFlags.join(" ")} ${quote([`${backupFilesPath}{}`])}`;

		// When encryption is enabled we export the crypt passwords so every rclone
		// invocation in the pipeline inherits them — including the `rclone delete`
		// that xargs spawns without a shell, where an inline env prefix would not apply.
		const envPrefix = envVars ? `export ${envVars}; ` : "";
		const rcloneCommand = `${envPrefix}${rcloneList} | ${sortAndPickUnwantedBackups} ${rcloneDelete}`;

		if (serverId) {
			await execAsyncRemote(serverId, rcloneCommand);
		} else {
			await execAsync(rcloneCommand);
		}
	} catch (error) {
		console.error(redactRcloneCredentials(String(error)));
	}
};
