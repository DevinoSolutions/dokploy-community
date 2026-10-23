import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	previewDeployments,
	redis,
} from "@dokploy/server/db/schema";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { and, eq, ne, sql } from "drizzle-orm";
import { quote } from "shell-quote";

export const OWNERSHIP_LABELS = [
	"com.docker.swarm.service.name",
	"com.docker.compose.project",
	"com.docker.stack.namespace",
];

export const SERVICE_TABLES = [
	{ table: applications, id: applications.applicationId },
	{ table: compose, id: compose.composeId },
	{ table: postgres, id: postgres.postgresId },
	{ table: mysql, id: mysql.mysqlId },
	{ table: mariadb, id: mariadb.mariadbId },
	{ table: mongo, id: mongo.mongoId },
	{ table: redis, id: redis.redisId },
	{ table: libsql, id: libsql.libsqlId },
];

export const findServiceAppName = async (serviceId: string) => {
	for (const { table, id } of SERVICE_TABLES) {
		const [row] = await db
			.select({ appName: table.appName })
			.from(table)
			.where(eq(id, serviceId))
			.limit(1);
		if (row) return row.appName;
	}
};

// Stats are recorded under the container name the client sends, and a compose
// owner can name a container anything. A name that equals or extends another
// service's appName would write into that service's stats history. Previews
// of other services have their own appNames, so they count too.
//
// `ownAppName` is passed for a name of the caller's own compose project form
// ("<own>-svc-1"): a service whose appName is a prefix of the caller's own
// appName only matches because of that shared prefix, so it is ignored. A
// service with a longer appName that is still a prefix of the name is not.
export const isOtherServiceAppName = async (
	name: string,
	serviceId: string,
	ownAppName?: string,
): Promise<boolean> => {
	const targets = [
		...SERVICE_TABLES.map(({ table, id }) => ({
			table,
			others: ne(id, serviceId),
		})),
		{
			table: previewDeployments,
			others: and(
				ne(previewDeployments.previewDeploymentId, serviceId),
				sql`${previewDeployments.applicationId} is distinct from ${serviceId}`,
				sql`${previewDeployments.composeId} is distinct from ${serviceId}`,
			),
		},
	];
	for (const { table, others } of targets) {
		const [row] = await db
			.select({ appName: table.appName })
			.from(table)
			.where(
				and(
					others,
					sql`starts_with(${name}, ${table.appName})`,
					ownAppName
						? sql`not starts_with(${ownAppName}, ${table.appName})`
						: undefined,
				),
			)
			.limit(1);
		if (row) return true;
	}
	return false;
};

// Service access alone must not allow `docker exec` into other tenants' containers.
export const containerBelongsToService = async (
	serviceId: string,
	containerId: string,
	serverId?: string | null,
): Promise<boolean> => {
	try {
		const appName = await findServiceAppName(serviceId);
		if (!appName) return false;
		const command = quote([
			"docker",
			"inspect",
			"--type",
			"container",
			"--format",
			"{{json .Config.Labels}}",
			containerId,
		]);
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		const labels = JSON.parse(stdout.trim()) ?? {};
		return OWNERSHIP_LABELS.some((label) => labels[label] === appName);
	} catch {
		return false;
	}
};
