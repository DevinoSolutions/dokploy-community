import {
	findBackupById,
	findPreviewDeploymentById,
	findScheduleById,
	findVolumeBackupById,
} from "@dokploy/server";
import type { apiFindAllByType } from "@dokploy/server/db/schema";
import type { z } from "zod";

/**
 * `deployment.allByType` accepts several `type`s whose `id` isn't itself a
 * service id: `previewDeployment`, `backup`, `volumeBackup`, `schedule` and
 * `server` are ids of things attached to a service (or a server). Passing them
 * straight to `checkServicePermissionAndAccess` fails closed with a 401,
 * because the service-existence lookup only unions the service tables. Resolve
 * each type to the target the auth check has to run against before calling it.
 *
 * A `dokploy-server` schedule is the one case with neither: it runs on the
 * Dokploy host itself, so it has no service and no server, and the only thing
 * left to authorize against is its `organizationId`.
 */
export type DeploymentAllByTypeAuthTarget =
	| { kind: "service"; serviceId: string }
	| { kind: "server"; serverId: string }
	| { kind: "organization"; organizationId: string | null }
	| { kind: "none" };

export const resolveDeploymentAllByTypeAuthTarget = async (
	input: z.infer<typeof apiFindAllByType>,
): Promise<DeploymentAllByTypeAuthTarget> => {
	switch (input.type) {
		case "application":
		case "compose":
			return { kind: "service", serviceId: input.id };
		case "server":
			return { kind: "server", serverId: input.id };
		case "schedule": {
			const schedule = await findScheduleById(input.id);
			const serviceId = schedule.applicationId || schedule.composeId;
			if (serviceId) return { kind: "service", serviceId };
			if (schedule.serverId)
				return { kind: "server", serverId: schedule.serverId };
			if (schedule.scheduleType === "dokploy-server")
				return {
					kind: "organization",
					organizationId: schedule.organizationId,
				};
			return { kind: "none" };
		}
		case "previewDeployment": {
			const preview = await findPreviewDeploymentById(input.id);
			const serviceId = preview.applicationId || preview.composeId;
			if (serviceId) return { kind: "service", serviceId };
			return { kind: "none" };
		}
		case "backup": {
			const backup = await findBackupById(input.id);
			const serviceId =
				backup.composeId ||
				backup.postgresId ||
				backup.mysqlId ||
				backup.mariadbId ||
				backup.mongoId ||
				backup.libsqlId;
			if (serviceId) return { kind: "service", serviceId };
			return { kind: "none" };
		}
		case "volumeBackup": {
			const volumeBackup = await findVolumeBackupById(input.id);
			const serviceId =
				volumeBackup.applicationId ||
				volumeBackup.composeId ||
				volumeBackup.postgresId ||
				volumeBackup.mysqlId ||
				volumeBackup.mariadbId ||
				volumeBackup.mongoId ||
				volumeBackup.redisId ||
				volumeBackup.libsqlId;
			if (serviceId) return { kind: "service", serviceId };
			return { kind: "none" };
		}
	}
};
