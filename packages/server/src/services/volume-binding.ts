import { TRPCError } from "@trpc/server";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { parse } from "yaml";
import { db } from "../db";
import {
	applications,
	compose,
	deployments,
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
import { logger } from "../lib/logger";
import {
	evaluateVolumeBinding,
	isInServiceVolumeNamespace,
	type VolumeBindingFacts,
} from "../utils/volume-backups/binding";

const environmentOrganization = {
	columns: {},
	with: {
		project: { columns: { organizationId: true } },
	},
} as const;

const serviceWithOrganization = {
	columns: { appName: true, serverId: true },
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
	serverId?: string | null;
	environment?: { project?: { organizationId?: string | null } | null } | null;
} | null;

// null is the local Dokploy host.
const serverOf = (service: ServiceWithOrganization | undefined) =>
	service?.serverId ?? null;

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
	const columns = { appName: true, serverId: true } as const;
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
				columns: { appName: true, serverId: true, composeFile: true },
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
	const columns = { appName: true, serverId: true } as const;
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
	return results.flat().map((service) => {
		const organizationId = organizationOf(service);
		return {
			source: "namespace" as const,
			id: service.appName,
			organizationId,
			serverId: serverOf(service),
			anyServer: !organizationId,
		};
	});
};

type RowWithServices = Partial<
	Record<ServiceType, ServiceWithOrganization | undefined>
>;

const rowService = (row: RowWithServices) => {
	for (const serviceType of SERVICE_TYPES) {
		const service = row[serviceType];
		if (service) {
			return service;
		}
	}
	return null;
};

const rowOrganization = (row: RowWithServices) =>
	organizationOf(rowService(row));

// A row whose service or organization cannot be resolved cannot be placed on
// a host, so it counts as a claim on every server.
const rowClaim = (
	row: RowWithServices,
	source: "mount" | "volumeBackup",
	id: string,
) => {
	const service = rowService(row);
	const organizationId = organizationOf(service);
	return {
		source,
		id,
		organizationId,
		serverId: serverOf(service),
		anyServer: !service || !organizationId,
	};
};

// Everything the binding decision needs, read in one place so that it can be
// decided by pure code. A service whose organization cannot be resolved
// counts as another organization (fail closed).
export const loadVolumeBindingFacts = async ({
	serviceType,
	serviceId,
	volumeName,
	onServerId,
	includeComposeDeclarations = true,
}: {
	serviceType: ServiceType;
	serviceId: string;
	volumeName: string;
	// Count the volume names OTHER composes on the same server declare in
	// their stored compose file (`name:`, `external`) as claims: another
	// organization's as an other-organization claim, one of the organization's
	// own as a claim of another service. Only a compose that has ever deployed
	// claims (it has a deployment row or is no longer idle).
	includeComposeDeclarations?: boolean;
	// Read the claims for another host than the service's own (null is the
	// local host). A transfer writes the volume on its target server too.
	onServerId?: string | null;
}): Promise<VolumeBindingFacts> => {
	const service = await loadService(serviceType, serviceId);
	if (!service) {
		throw serviceNotFound();
	}
	const organizationId = organizationOf(service);
	if (!organizationId) {
		throw serviceNotFound();
	}

	const serverId = onServerId === undefined ? serverOf(service) : onServerId;
	const [
		mountRows,
		volumeBackupRows,
		namespaceOrganizations,
		composeDeclarationRows,
	] = await Promise.all([
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
			includeComposeDeclarations
				? db.query.compose.findMany({
						where: and(
							serverId === null
								? isNull(compose.serverId)
								: eq(compose.serverId, serverId),
							serviceType === "compose"
								? ne(compose.composeId, serviceId)
								: undefined,
							sql`strpos(${compose.composeFile}, ${volumeName}::text) > 0`,
						),
						columns: {
							composeId: true,
							appName: true,
							serverId: true,
							composeFile: true,
							composeStatus: true,
						},
						with: { environment: environmentOrganization },
					})
				: Promise.resolve([]),
		]);

	const idKey = SERVICE_ID_KEYS[serviceType];
	let recordedOnOwnMount = false;
	let recordedOnOtherSameOrgMount = false;
	let recordedOnOwnVolumeBackup = false;
	let recordedOnOtherSameOrgVolumeBackup = false;
	for (const row of mountRows) {
		if (row[idKey] === serviceId) {
			recordedOnOwnMount = true;
		} else if (
			rowOrganization(row) === organizationId &&
			serverOf(rowService(row)) === serverId
		) {
			recordedOnOtherSameOrgMount = true;
		}
	}

	for (const row of volumeBackupRows) {
		if (row[idKey] === serviceId) {
			recordedOnOwnVolumeBackup = true;
		} else if (
			rowOrganization(row) === organizationId &&
			serverOf(rowService(row)) === serverId
		) {
			recordedOnOtherSameOrgVolumeBackup = true;
		}
	}
	const inOtherSameOrgNamespace = namespaceOrganizations.some(
		(claim) =>
			claim.organizationId === organizationId &&
			claim.serverId === serverId &&
			claim.id !== service.appName,
	);

	// A name in the service's own namespace cannot belong to another compose's
	// file in good faith, so it is not counted (nobody can squat it).
	const inOwnNamespace = isInServiceVolumeNamespace(
		volumeName,
		service.appName,
	);
	const declaringRows = inOwnNamespace
		? []
		: composeDeclarationRows.filter((row) =>
				collectComposeDeclaredVolumeNames(row.composeFile).has(volumeName),
			);
	// A compose that never deployed owns no data, so a file that was only saved
	// cannot lock anybody out. Any status counts once it has deployed (a stopped
	// or failed compose still owns its volumes): it is no longer idle, or it has
	// a deployment row.
	const deployedRows: typeof declaringRows = [];
	for (const row of declaringRows) {
		if (
			row.composeStatus !== "idle" ||
			(await db.query.deployments.findFirst({
				where: eq(deployments.composeId, row.composeId),
				columns: { deploymentId: true },
			}))
		) {
			deployedRows.push(row);
		}
	}
	const composeDeclarations = deployedRows.map((row) => {
		const declaringOrganization = organizationOf(row);
		return {
			source: "composeFile" as const,
			id: row.appName,
			organizationId: declaringOrganization,
			serverId: serverOf(row),
			anyServer: !declaringOrganization,
		};
	});
	const declaredBySameOrgCompose = composeDeclarations.some(
		(claim) => claim.organizationId === organizationId,
	);

	// A volume name only collides on one host, so a claim counts only when the
	// claiming service runs on the same server (local host = null).
	const otherOrganizationClaims = [
		...namespaceOrganizations,
		...mountRows.map((row) => rowClaim(row, "mount", row.mountId)),
		...volumeBackupRows.map((row) =>
			rowClaim(row, "volumeBackup", row.volumeBackupId),
		),
		...composeDeclarations,
	]
		.filter(
			(claim) =>
				(claim.anyServer || claim.serverId === serverId) &&
				claim.organizationId !== organizationId,
		)
		.map(({ source, id }) => ({ source, id }));

	return {
		volumeName,
		serviceType,
		serviceId,
		appName: service.appName,
		serverId,
		recordedOnOwnMount,
		recordedOnOtherSameOrgMount,
		recordedOnOwnVolumeBackup,
		claimedByOtherSameOrgService:
			declaredBySameOrgCompose ||
			recordedOnOtherSameOrgMount ||
			recordedOnOtherSameOrgVolumeBackup ||
			inOtherSameOrgNamespace,
		declaredByComposeFile:
			serviceType === "compose" &&
			collectComposeDeclaredVolumeNames(
				(service as { composeFile?: string | null }).composeFile,
			).has(volumeName),
		claimedByOtherOrganization: otherOrganizationClaims.length > 0,
		otherOrganizationClaims,
	};
};

export type RefusedVolumeMount = { volumeName: string; message: string };

// Sinks that act on the volume names already stored on a service's mounts
// (deploy, database rebuild, transfer) have no user to ask, and a stored mount
// can predate the binding rules (T-6822). The stored mount is the record of the
// name, so it counts as the service's own mount, and the same fail-closed
// claims as the run-time check of #459 decide:
// - a name that fails the volume-name format, a Dokploy-reserved name
//   (`dokploy`, `dokploy-*`, `dokploy_*`) or a name another organization's
//   service on the same server claims is ALWAYS refused, with one exception:
//   a name in the service's OWN namespace (`<appName>`, `<appName>-*`,
//   `<appName>_*`) that is claimed only by another organization's volume
//   backup rows is allowed. appName is unique on the host, so such a row is a
//   stale or hand-written record and must not lock a service out of its own
//   volumes. Another organization's mount or appName namespace still refuses;
// - anything else an owner/admin could have created is accepted, so an
//   organization's own outside-named mounts keep working.
// `serverIds` lists the hosts to read the claims for (default: the service's
// own host; null is the local host).
export const findRefusedVolumeMounts = async (
	mounts: ReadonlyArray<{ type: string; volumeName?: string | null }>,
	service: { serviceType: ServiceType; serviceId: string },
	{ serverIds }: { serverIds?: Array<string | null> } = {},
): Promise<RefusedVolumeMount[]> => {
	const volumeNames = new Set<string>();
	for (const mount of mounts) {
		if (mount.type === "volume" && mount.volumeName) {
			volumeNames.add(mount.volumeName);
		}
	}
	const refused: RefusedVolumeMount[] = [];
	for (const volumeName of volumeNames) {
		for (const onServerId of serverIds ?? [undefined]) {
			let verdict: ReturnType<typeof evaluateVolumeBinding>;
			try {
				const facts = await loadVolumeBindingFacts({
					...service,
					volumeName,
					onServerId,
				});
				const claims = facts.otherOrganizationClaims ?? [];
				const onlyVolumeBackupClaims =
					claims.length > 0 &&
					claims.every((claim) => claim.source === "volumeBackup");
				verdict = evaluateVolumeBinding(
					{
						...facts,
						recordedOnOwnMount: true,
						claimedByOtherOrganization:
							facts.claimedByOtherOrganization &&
							!(
								onlyVolumeBackupClaims &&
								isInServiceVolumeNamespace(volumeName, facts.appName)
							),
					},
					{ privileged: true },
				);
				if (!verdict.ok) {
					// Server side only: the user-facing text stays the one refusal
					// message, so it cannot tell another organization's rows apart.
					logger.warn(
						{
							...service,
							volumeName,
							serverId: facts.serverId,
							conflictingRows: claims,
						},
						"[VolumeBinding] A stored volume mount was refused",
					);
				}
			} catch (error) {
				if (!(error instanceof TRPCError) || error.code !== "NOT_FOUND") {
					throw error;
				}
				// The service or its organization cannot be resolved: fail closed.
				logger.warn(
					{ ...service, volumeName },
					"[VolumeBinding] A stored volume mount was refused: the service could not be resolved",
				);
				verdict = {
					ok: false,
					message: `Volume "${volumeName}" is refused: the service it belongs to could not be resolved.`,
				};
			}
			if (!verdict.ok) {
				refused.push({ volumeName, message: verdict.message });
				break;
			}
		}
	}
	return refused;
};

// Refuses (throws) when any volume mount of the service fails the check above.
export const assertVolumeMountsBound = async (
	mounts: ReadonlyArray<{ type: string; volumeName?: string | null }>,
	service: { serviceType: ServiceType; serviceId: string },
) => {
	const [refused] = await findRefusedVolumeMounts(mounts, service);
	if (refused) {
		throw new Error(refused.message);
	}
};

const composeVolumeRefusal = (volumeName: string, appName: string) =>
	`Compose volume "${volumeName}" is refused: it is not one of this compose's volumes. Use the default volume name ("${appName}_<name>", which is what a plain volume gets) or a volume nothing else uses. A volume that another service or organization uses, or one Dokploy reserves, cannot be mounted from a compose file.`;

// The same decision `evaluateVolumeBinding` makes for a stored mount, for a
// volume a compose FILE mounts (T-6822). The file is the user's own text, so
// it counts as nobody's record: a name outside the compose's own namespace is
// accepted only when nothing else claims it. The compose's own mounts and
// volume backup rows are its own records and count for it.
// - a malformed name, a Dokploy-reserved name or one another organization's
//   service on the same server claims is ALWAYS refused. Exception: a name in
//   the compose's OWN namespace claimed only by volume backup rows (the stale
//   or hand-written rows of the #460 MED-4 relaxation);
// - the compose's own namespace (`<appName>_*`, `<appName>-*`, `<appName>`) and
//   the compose's own default names are allowed;
// - any other name is refused when another service of the SAME organization
//   claims it (a mount, a volume backup or its appName namespace), unless the
//   compose has its own mount or volume backup row for it. The volume names
//   that OTHER composes of the server declare in their stored compose file
//   (`name:`, `external`) count as such claims (another organization's as
//   an other-organization claim, for every volume check), once that compose
//   has deployed; only a stored (raw) compose file is visible, a fetched one
//   is not. A volume nothing records stays allowed, so volumes made by hand keep
//   working;
// - a compose's own default names (`<appName>_<key>`) are not looked up.
export const findRefusedComposeVolumes = async (
	compose: { composeId: string; appName: string },
	uses: ReadonlyArray<{ volumeName: string; derived?: boolean }>,
	{ serverIds }: { serverIds?: Array<string | null> } = {},
): Promise<RefusedVolumeMount[]> => {
	const service = {
		serviceType: "compose" as const,
		serviceId: compose.composeId,
	};
	const derivedNames = new Set<string>();
	const volumeNames = new Set<string>();
	for (const use of uses) {
		volumeNames.add(use.volumeName);
		if (use.derived) {
			derivedNames.add(use.volumeName);
		}
	}
	const refused: RefusedVolumeMount[] = [];
	for (const volumeName of volumeNames) {
		if (derivedNames.has(volumeName)) {
			continue;
		}
		const message = composeVolumeRefusal(volumeName, compose.appName);
		for (const onServerId of serverIds ?? [undefined]) {
			let isRefused = false;
			try {
				const facts = await loadVolumeBindingFacts({
					...service,
					volumeName,
					onServerId,
					includeComposeDeclarations: true,
				});
				const claims = facts.otherOrganizationClaims ?? [];
				const own =
					derivedNames.has(volumeName) ||
					isInServiceVolumeNamespace(volumeName, compose.appName) ||
					isInServiceVolumeNamespace(volumeName, facts.appName);
				const onlyVolumeBackupClaims =
					claims.length > 0 &&
					claims.every((claim) => claim.source === "volumeBackup");
				const verdict = evaluateVolumeBinding(
					{
						...facts,
						recordedOnOwnMount: true,
						claimedByOtherOrganization:
							facts.claimedByOtherOrganization &&
							!(own && onlyVolumeBackupClaims),
					},
					{ privileged: true },
				);
				const claimedByOtherService =
					!own &&
					!facts.recordedOnOwnMount &&
					!facts.recordedOnOwnVolumeBackup &&
					facts.claimedByOtherSameOrgService === true;
				if (!verdict.ok || claimedByOtherService) {
					// Server side only: the user-facing text stays the one refusal
					// message, so it cannot tell another service's rows apart.
					logger.warn(
						{
							...service,
							volumeName,
							serverId: facts.serverId,
							conflictingRows: claims,
							claimedByOtherSameOrgService:
								facts.claimedByOtherSameOrgService ?? false,
						},
						"[VolumeBinding] A compose file volume was refused",
					);
					isRefused = true;
				}
			} catch (error) {
				if (!(error instanceof TRPCError) || error.code !== "NOT_FOUND") {
					throw error;
				}
				// The compose or its organization cannot be resolved: fail closed.
				logger.warn(
					{ ...service, volumeName },
					"[VolumeBinding] A compose file volume was refused: the compose could not be resolved",
				);
				isRefused = true;
			}
			if (isRefused) {
				refused.push({ volumeName, message });
				break;
			}
		}
	}
	return refused;
};
