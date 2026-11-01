import { db } from "@dokploy/server/db";
import { applications, compose, deployments } from "@dokploy/server/db/schema";
import { and, inArray, isNull, or, sql } from "drizzle-orm";
import {
	type BuildOriginDeploymentRow,
	COMPOSE_BUILD_SECTION_SQL_PATTERN,
	pickServiceBuildOrigin,
	type ResolvedBuildOrigin,
} from "./build-origin-shared";

export * from "./build-origin-shared";

type ApplicationSourceRow = { id: string; sourceType: string | null };
type ComposeSourceRow = {
	id: string;
	sourceType: string | null;
	hasBuildSection: boolean;
};
type ServiceDeploymentRow = BuildOriginDeploymentRow & {
	applicationId: string | null;
	composeId: string | null;
};

/**
 * The service-level value of many services from rows already read. Pure: the I/O lives in
 * `getBuildOriginsByService`. The map is keyed by applicationId / composeId.
 */
export const computeServiceBuildOrigins = (input: {
	applications: readonly ApplicationSourceRow[];
	composes: readonly ComposeSourceRow[];
	deployments: readonly ServiceDeploymentRow[];
}): Map<string, ResolvedBuildOrigin> => {
	const byApplication = new Map<string, ServiceDeploymentRow[]>();
	const byCompose = new Map<string, ServiceDeploymentRow[]>();
	for (const row of input.deployments) {
		const [key, bucket] = row.applicationId
			? ([row.applicationId, byApplication] as const)
			: row.composeId
				? ([row.composeId, byCompose] as const)
				: [null, null];
		if (key === null) continue;
		const list = bucket.get(key);
		if (list) list.push(row);
		else bucket.set(key, [row]);
	}
	const result = new Map<string, ResolvedBuildOrigin>();
	for (const app of input.applications) {
		result.set(
			app.id,
			pickServiceBuildOrigin(byApplication.get(app.id) ?? [], {
				kind: "application",
				sourceType: app.sourceType,
			}),
		);
	}
	for (const item of input.composes) {
		result.set(
			item.id,
			pickServiceBuildOrigin(byCompose.get(item.id) ?? [], {
				kind: "compose",
				sourceType: item.sourceType,
				hasBuildSection: item.hasBuildSection,
			}),
		);
	}
	return result;
};

/**
 * Where each application and compose was built (T-12149), computed from their deployments. Only the
 * columns the answer needs are read: never a compose file, an env or a log path. Whether a raw compose
 * has a `build:` section is decided in SQL, so the file text does not leave the database. At most ten
 * deployments per service exist (`removeLastTenDeployments`), so the read is bounded.
 */
export const getBuildOriginsByService = async (input: {
	applicationIds: readonly string[];
	composeIds: readonly string[];
}): Promise<Map<string, ResolvedBuildOrigin>> => {
	const applicationIds = [...new Set(input.applicationIds)];
	const composeIds = [...new Set(input.composeIds)];
	if (applicationIds.length === 0 && composeIds.length === 0) {
		return new Map();
	}

	const [appRows, composeRows, deploymentRows] = await Promise.all([
		applicationIds.length > 0
			? db
					.select({
						id: applications.applicationId,
						sourceType: applications.sourceType,
					})
					.from(applications)
					.where(inArray(applications.applicationId, applicationIds))
			: Promise.resolve([]),
		composeIds.length > 0
			? db
					.select({
						id: compose.composeId,
						sourceType: compose.sourceType,
						hasBuildSection: sql<boolean>`coalesce(${compose.composeFile} ~ ${COMPOSE_BUILD_SECTION_SQL_PATTERN}, false)`,
					})
					.from(compose)
					.where(inArray(compose.composeId, composeIds))
			: Promise.resolve([]),
		db
			.select({
				applicationId: deployments.applicationId,
				composeId: deployments.composeId,
				title: deployments.title,
				status: deployments.status,
				createdAt: deployments.createdAt,
				buildOrigin: deployments.buildOrigin,
				buildRunUrl: deployments.buildRunUrl,
			})
			.from(deployments)
			.where(
				and(
					or(
						applicationIds.length > 0
							? inArray(deployments.applicationId, applicationIds)
							: undefined,
						composeIds.length > 0
							? inArray(deployments.composeId, composeIds)
							: undefined,
					),
					// Only runs of the service itself, as in pickServiceBuildOrigin.
					isNull(deployments.scheduleId),
					isNull(deployments.backupId),
					isNull(deployments.volumeBackupId),
					isNull(deployments.previewDeploymentId),
				),
			),
	]);

	return computeServiceBuildOrigins({
		applications: appRows,
		composes: composeRows.map((row) => ({
			...row,
			hasBuildSection: row.hasBuildSection === true,
		})),
		deployments: deploymentRows,
	});
};

/**
 * Adds buildOrigin / buildRunUrl to every application and compose of an environment read
 * (`findEnvironmentById`), for the project service list and the API. Reads the deployments table by id, so
 * the environment query itself stays as it is.
 */
export const attachBuildOriginsToEnvironment = async <
	T extends {
		applications?: { applicationId: string }[] | null;
		compose?: { composeId: string }[] | null;
	},
>(
	environment: T,
): Promise<
	Omit<T, "applications" | "compose"> & {
		applications: (NonNullable<T["applications"]>[number] &
			ResolvedBuildOrigin)[];
		compose: (NonNullable<T["compose"]>[number] & ResolvedBuildOrigin)[];
	}
> => {
	const applicationsIn = environment.applications ?? [];
	const composeIn = environment.compose ?? [];
	const origins = await getBuildOriginsByService({
		applicationIds: applicationsIn.map((item) => item.applicationId),
		composeIds: composeIn.map((item) => item.composeId),
	});
	const none: ResolvedBuildOrigin = {
		buildOrigin: "external",
		buildRunUrl: null,
	};
	return {
		...environment,
		applications: applicationsIn.map((item) => ({
			...item,
			...(origins.get(item.applicationId) ?? none),
		})),
		compose: composeIn.map((item) => ({
			...item,
			...(origins.get(item.composeId) ?? none),
		})),
	} as never;
};
