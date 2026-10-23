import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { parse } from "yaml";
import { db } from "../db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	mongo,
	mounts,
	mysql,
	postgres,
	redis,
	type ServiceType,
	volumeBackups,
} from "../db/schema";
import type { VolumeBindingFacts } from "../utils/volume-backups/binding";

const environmentOrganization = {
	columns: {},
	with: {
		project: { columns: { organizationId: true } },
	},
} as const;

const serviceWithOrganization = {
	columns: { appName: true },
	with: { environment: environmentOrganization },
} as const;

const everyServiceWithOrganization = {
	application: serviceWithOrganization,
	compose: serviceWithOrganization,
	libsql: serviceWithOrganization,
	mariadb: serviceWithOrganization,
	mongo: serviceWithOrganization,
	mysql: serviceWithOrganization,
	postgres: serviceWithOrganization,
	redis: serviceWithOrganization,
} as const;

type ServiceWithOrganization = {
	environment?: { project?: { organizationId?: string | null } | null } | null;
} | null;

const organizationOf = (service: ServiceWithOrganization | undefined) =>
	service?.environment?.project?.organizationId ?? null;

const SERVICE_ID_KEYS = {
	application: "applicationId",
	compose: "composeId",
	libsql: "libsqlId",
	mariadb: "mariadbId",
	mongo: "mongoId",
	mysql: "mysqlId",
	postgres: "postgresId",
	redis: "redisId",
} as const satisfies Record<ServiceType, string>;

const SERVICE_TYPES = Object.keys(SERVICE_ID_KEYS) as ServiceType[];

const serviceNotFound = () =>
	new TRPCError({ code: "NOT_FOUND", message: "Service not found" });

const loadService = async (serviceType: ServiceType, serviceId: string) => {
	const columns = { appName: true } as const;
	const with_ = { environment: environmentOrganization } as const;
	switch (serviceType) {
		case "application":
			return db.query.applications.findFirst({
				where: eq(applications.applicationId, serviceId),
				columns,
				with: with_,
			});
		case "compose":
			return db.query.compose.findFirst({
				where: eq(compose.composeId, serviceId),
				columns: { appName: true, composeFile: true },
				with: with_,
			});
		case "libsql":
			return db.query.libsql.findFirst({
				where: eq(libsql.libsqlId, serviceId),
				columns,
				with: with_,
			});
		case "mariadb":
			return db.query.mariadb.findFirst({
				where: eq(mariadb.mariadbId, serviceId),
				columns,
				with: with_,
			});
		case "mongo":
			return db.query.mongo.findFirst({
				where: eq(mongo.mongoId, serviceId),
				columns,
				with: with_,
			});
		case "mysql":
			return db.query.mysql.findFirst({
				where: eq(mysql.mysqlId, serviceId),
				columns,
				with: with_,
			});
		case "postgres":
			return db.query.postgres.findFirst({
				where: eq(postgres.postgresId, serviceId),
				columns,
				with: with_,
			});
		case "redis":
			return db.query.redis.findFirst({
				where: eq(redis.redisId, serviceId),
				columns,
				with: with_,
			});
		default:
			return undefined;
	}
};

type ComposeVolumeDefinition = {
	name?: unknown;
	external?: unknown;
};

// The volume names a compose file takes out of the default `<appName>_<key>`
// namespace: `external: true` (the key), `external: { name }` and `name:`.
export const collectComposeDeclaredVolumeNames = (
	composeFile: string | null | undefined,
) => {
	const declared = new Set<string>();
	if (!composeFile) {
		return declared;
	}
	try {
		const spec = parse(composeFile, { maxAliasCount: 10000, merge: true }) as {
			volumes?: Record<string, ComposeVolumeDefinition | null>;
		} | null;
		for (const [key, definition] of Object.entries(spec?.volumes ?? {})) {
			if (!definition || typeof definition !== "object") {
				continue;
			}
			const { name, external } = definition;
			if (typeof name === "string" && name) {
				declared.add(name);
			} else if (
				external &&
				typeof external === "object" &&
				typeof (external as { name?: unknown }).name === "string"
			) {
				declared.add((external as { name: string }).name);
			} else if (external) {
				declared.add(key);
			}
		}
	} catch {
		// An unreadable compose file declares nothing.
	}
	return declared;
};

// `starts_with` and `=` keep appName's `_` and `.` literal, which LIKE would not.
const namespaceClaim = (appNameColumn: AnyPgColumn, name: string) =>
	sql`(${appNameColumn} = ${name}::text
		OR starts_with(${name}::text, ${appNameColumn} || '-')
		OR starts_with(${name}::text, ${appNameColumn} || '_'))`;

const findOrganizationsClaimingNamespace = async (volumeName: string) => {
	const environment = { environment: environmentOrganization } as const;
	const columns = { appName: true } as const;
	const results = await Promise.all([
		db.query.applications.findMany({
			where: namespaceClaim(applications.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.compose.findMany({
			where: namespaceClaim(compose.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.libsql.findMany({
			where: namespaceClaim(libsql.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.mariadb.findMany({
			where: namespaceClaim(mariadb.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.mongo.findMany({
			where: namespaceClaim(mongo.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.mysql.findMany({
			where: namespaceClaim(mysql.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.postgres.findMany({
			where: namespaceClaim(postgres.appName, volumeName),
			columns,
			with: environment,
		}),
		db.query.redis.findMany({
			where: namespaceClaim(redis.appName, volumeName),
			columns,
			with: environment,
		}),
	]);
	return results.flat().map((service) => organizationOf(service));
};

type RowWithServices = Partial<
	Record<ServiceType, ServiceWithOrganization | undefined>
>;

const rowOrganization = (row: RowWithServices) => {
	for (const serviceType of SERVICE_TYPES) {
		const service = row[serviceType];
		if (service) {
			return organizationOf(service);
		}
	}
	return null;
};

// Everything the binding decision needs, read in one place so that it can be
// decided by pure code. A service whose organization cannot be resolved
// counts as another organization (fail closed).
export const loadVolumeBindingFacts = async ({
	serviceType,
	serviceId,
	volumeName,
}: {
	serviceType: ServiceType;
	serviceId: string;
	volumeName: string;
}): Promise<VolumeBindingFacts> => {
	const service = await loadService(serviceType, serviceId);
	if (!service) {
		throw serviceNotFound();
	}
	const organizationId = organizationOf(service);
	if (!organizationId) {
		throw serviceNotFound();
	}

	const [mountRows, volumeBackupRows, namespaceOrganizations] =
		await Promise.all([
			db.query.mounts.findMany({
				where: and(
					eq(mounts.type, "volume"),
					eq(mounts.volumeName, volumeName),
				),
				with: everyServiceWithOrganization,
			}),
			db.query.volumeBackups.findMany({
				where: eq(volumeBackups.volumeName, volumeName),
				with: everyServiceWithOrganization,
			}),
			findOrganizationsClaimingNamespace(volumeName),
		]);

	const idKey = SERVICE_ID_KEYS[serviceType];
	let recordedOnOwnMount = false;
	let recordedOnOtherSameOrgMount = false;
	for (const row of mountRows) {
		if (row[idKey] === serviceId) {
			recordedOnOwnMount = true;
		} else if (rowOrganization(row) === organizationId) {
			recordedOnOtherSameOrgMount = true;
		}
	}

	const claimedByOtherOrganization = [
		...namespaceOrganizations,
		...mountRows.map(rowOrganization),
		...volumeBackupRows.map(rowOrganization),
	].some((owner) => owner !== organizationId);

	return {
		volumeName,
		serviceType,
		serviceId,
		appName: service.appName,
		recordedOnOwnMount,
		recordedOnOtherSameOrgMount,
		declaredByComposeFile:
			serviceType === "compose" &&
			collectComposeDeclaredVolumeNames(
				(service as { composeFile?: string | null }).composeFile,
			).has(volumeName),
		claimedByOtherOrganization,
	};
};
