import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { findComposeById } from "@dokploy/server/services/compose";
import { findDestinationById } from "@dokploy/server/services/destination";
import type { findVolumeBackupById } from "@dokploy/server/services/volume-backups";
import { quote } from "shell-quote";
import {
	buildRcloneCommand,
	getBackupTimestamp,
	getRclonePathAndFlags,
	normalizeS3Path,
} from "../backups/utils";

interface RestartSafeBackupCommandOptions {
	stopCommand: string;
	backupCommand: string;
	startCommand: string;
	uploadCommand: string;
}

export const createRestartSafeBackupCommand = ({
	stopCommand,
	backupCommand,
	startCommand,
	uploadCommand,
}: RestartSafeBackupCommandOptions) => `
	${stopCommand}
	set +e
	(
		${backupCommand}
	)
	DOKPLOY_VOLUME_BACKUP_STATUS=$?
	(
		set -e
		${startCommand}
	)
	DOKPLOY_VOLUME_RESTART_STATUS=$?
	set -e
	if [ "$DOKPLOY_VOLUME_BACKUP_STATUS" -ne 0 ]; then
		if [ "$DOKPLOY_VOLUME_RESTART_STATUS" -ne 0 ]; then
			echo "Service restart also failed with exit code $DOKPLOY_VOLUME_RESTART_STATUS"
		fi
		exit "$DOKPLOY_VOLUME_BACKUP_STATUS"
	fi
	if [ "$DOKPLOY_VOLUME_RESTART_STATUS" -ne 0 ]; then
		exit "$DOKPLOY_VOLUME_RESTART_STATUS"
	fi
	${uploadCommand}
`;

export const getVolumeServiceAppName = (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
): string => {
	if (volumeBackup.compose?.appName) {
		return volumeBackup.serviceName
			? `${volumeBackup.compose.appName}_${volumeBackup.serviceName}`
			: volumeBackup.compose.appName;
	}
	const serviceAppName =
		volumeBackup.application?.appName ||
		volumeBackup.postgres?.appName ||
		volumeBackup.mysql?.appName ||
		volumeBackup.mariadb?.appName ||
		volumeBackup.mongo?.appName ||
		volumeBackup.redis?.appName ||
		volumeBackup.libsql?.appName;
	return serviceAppName || volumeBackup.appName;
};

export const backupVolume = async (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
) => {
	const { serviceType, volumeName, turnOff, prefix } = volumeBackup;
	const destination = await findDestinationById(volumeBackup.destinationId);
	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	const { VOLUME_BACKUPS_PATH, VOLUME_BACKUP_LOCK_PATH } = paths(!!serverId);
	const backupFileName = `${volumeName}-${getBackupTimestamp()}.tar`;
	const effectivePrefix = prefix
		? normalizeS3Path(prefix)
		: `${getVolumeServiceAppName(volumeBackup)}/`;
	const bucketDestination = `${effectivePrefix}${backupFileName}`;
	const {
		flags: rcloneFlags,
		path: rcloneDestination,
		envVars,
	} = await getRclonePathAndFlags(destination, bucketDestination);
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName);

	const rcloneCommand = buildRcloneCommand(
		`rclone copyto ${rcloneFlags.join(" ")} ${quote([`${volumeBackupPath}/${backupFileName}`])} ${quote([rcloneDestination])}`,
		envVars,
	);

	const backupCommand = `
	set -e
	echo ${quote([`Volume name: ${volumeName}`])}
	echo ${quote([`Backup file name: ${backupFileName}`])}
	echo "Turning off volume backup: ${turnOff ? "Yes" : "No"}"
	echo "Starting volume backup" 
	echo ${quote([`Dir: ${volumeBackupPath}`])}
    docker run --rm \
  -v ${quote([`${volumeName}:/volume_data`])} \
  -v ${quote([`${volumeBackupPath}:/backup`])} \
  -e BACKUP_FILE_NAME=${quote([backupFileName])} \
  ubuntu \
  bash -c 'cd /volume_data && tar cvf "/backup/$BACKUP_FILE_NAME" .'
  echo "Volume backup done ✅"
  `;

	const uploadCommand = `
  echo "Starting upload to destination..."
  ${rcloneCommand}
  echo "Upload to destination done ✅"
  echo "Cleaning up local backup file..."
  rm ${quote([`${volumeBackupPath}/${backupFileName}`])}
  echo "Local backup file cleaned up ✅"
  `;

	if (!turnOff) {
		return `
		${backupCommand}
		${uploadCommand}
		`;
	}

	const serviceLockId =
		serviceType === "application"
			? volumeBackup.application?.appName
			: `${volumeBackup.compose?.appName}_${volumeBackup.serviceName}`;

	const lockPath = `${VOLUME_BACKUP_LOCK_PATH}-${serviceLockId}`;

	const lockWrapper = (body: string) => `
		set -e

		LOCK_PATH=${quote([lockPath])}

		echo "Waiting for volume backup lock: $LOCK_PATH"

		if command -v flock >/dev/null 2>&1; then
			exec 9>"$LOCK_PATH"
			flock 9
		else
			LOCK_DIR="$LOCK_PATH.dir"
			while ! mkdir "$LOCK_DIR" 2>/dev/null; do
				echo "Waiting for volume backup lock: $LOCK_PATH"
				sleep 5
			done
			trap 'rm -rf "$LOCK_DIR"' EXIT
		fi

		echo "Volume backup lock acquired"

		${body}

		echo "Volume backup lock released"
	`;

	console.log(
		lockWrapper(`
		echo "Volume backup lock acquired"
		echo "Volume backup lock released"
	`),
	);

	if (serviceType === "application") {
		return lockWrapper(
			createRestartSafeBackupCommand({
				stopCommand: `
				echo "Stopping application to 0 replicas"
				ACTUAL_REPLICAS=$(docker service inspect ${volumeBackup.application?.appName} --format "{{.Spec.Mode.Replicated.Replicas}}")
				echo "Actual replicas: $ACTUAL_REPLICAS"
				docker service update --replicas=0 ${volumeBackup.application?.appName}`,
				backupCommand,
				startCommand: `
				echo "Starting application to $ACTUAL_REPLICAS replicas"
				docker service update --replicas=$ACTUAL_REPLICAS --with-registry-auth ${volumeBackup.application?.appName}`,
				uploadCommand,
			}),
		);
	}
	if (serviceType === "compose") {
		const compose = await findComposeById(
			volumeBackup.compose?.composeId || "",
		);
		let stopCommand = "";
		let startCommand = "";

		if (compose.composeType === "stack") {
			const stackServiceName = `${compose.appName}_${volumeBackup.serviceName}`;
			stopCommand = `
			echo "Stopping compose to 0 replicas"
			echo ${quote([`Service name: ${stackServiceName}`])}
            ACTUAL_REPLICAS=$(docker service inspect ${quote([stackServiceName])} --format "{{.Spec.Mode.Replicated.Replicas}}")
            echo "Actual replicas: $ACTUAL_REPLICAS"
            docker service update --replicas=0 ${quote([stackServiceName])}`;

			startCommand = `
			echo "Starting compose to $ACTUAL_REPLICAS replicas"
			docker service update --replicas=$ACTUAL_REPLICAS --with-registry-auth ${quote([stackServiceName])}`;
		} else {
			stopCommand = `
			echo "Stopping compose container"
            ID=$(docker ps -q --filter ${quote([`label=com.docker.compose.project=${compose.appName}`])} --filter ${quote([`label=com.docker.compose.service=${volumeBackup.serviceName}`])})
            docker stop $ID`;

			startCommand = `
            echo "Starting compose container"
            docker start $ID
			echo "Compose container started"
			`;
		}
		return lockWrapper(
			createRestartSafeBackupCommand({
				stopCommand,
				backupCommand,
				startCommand,
				uploadCommand,
			}),
		);
	}
};
