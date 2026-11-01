import { db } from "@dokploy/server/db";
import {
	type GithubWatchServiceType,
	githubDeploymentConnection,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema/github-deployment";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";

/**
 * Database access for the GitHub Deployments pull flow.
 *
 * The token lives in `github_deployment_connection.accessToken` (encrypted).
 * Only `loadConnectionToken` and `loadGhcrCredentials` ever read it, and neither
 * is reachable from a tRPC procedure's output.
 */

export type GithubConnectionRow =
	typeof githubDeploymentConnection.$inferSelect;
export type GithubWatchRecord = typeof githubDeploymentWatch.$inferSelect;

/** What the dashboard, the API and MCP may see of a connection: never the token. */
export const presentGithubConnection = (row: GithubConnectionRow) => ({
	connectionId: row.connectionId,
	githubLogin: row.githubLogin,
	scopes: row.scopes ? row.scopes.split(",") : [],
	status: row.status,
	lastError: row.lastError,
	createdAt: row.createdAt,
});

export const presentGithubWatch = (row: GithubWatchRecord) => ({
	watchId: row.watchId,
	serviceType: row.serviceType,
	serviceId: row.serviceId,
	connectionId: row.connectionId,
	owner: row.owner,
	repo: row.repo,
	environment: row.environment,
	enabled: row.enabled,
	postLogUrl: row.postLogUrl,
	lastSeenDeploymentId: row.lastSeenDeploymentId,
	inflightDeploymentId: row.inflightDeploymentId,
	lastCheckedAt: row.lastCheckedAt,
	lastError: row.lastError,
	createdAt: row.createdAt,
});

export const listGithubConnections = async (organizationId: string) => {
	const rows = await db
		.select()
		.from(githubDeploymentConnection)
		.where(eq(githubDeploymentConnection.organizationId, organizationId));
	return rows.map(presentGithubConnection);
};

export const findGithubConnectionInOrganization = async (
	connectionId: string,
	organizationId: string,
) => {
	const [row] = await db
		.select()
		.from(githubDeploymentConnection)
		.where(
			and(
				eq(githubDeploymentConnection.connectionId, connectionId),
				eq(githubDeploymentConnection.organizationId, organizationId),
			),
		);
	return row ? presentGithubConnection(row) : null;
};

export const upsertGithubConnection = async (input: {
	organizationId: string;
	createdByUserId: string;
	githubLogin: string;
	githubUserId: string;
	scopes: string;
	accessToken: string;
}) => {
	const [row] = await db
		.insert(githubDeploymentConnection)
		.values({ ...input, status: "active", lastError: null })
		.onConflictDoUpdate({
			target: [
				githubDeploymentConnection.organizationId,
				githubDeploymentConnection.githubUserId,
			],
			set: {
				githubLogin: input.githubLogin,
				scopes: input.scopes,
				accessToken: input.accessToken,
				createdByUserId: input.createdByUserId,
				status: "active",
				lastError: null,
			},
		})
		.returning();
	if (!row) throw new Error("Could not save the GitHub connection");
	return presentGithubConnection(row);
};

export const deleteGithubConnection = async (
	connectionId: string,
	organizationId: string,
) => {
	const rows = await db
		.delete(githubDeploymentConnection)
		.where(
			and(
				eq(githubDeploymentConnection.connectionId, connectionId),
				eq(githubDeploymentConnection.organizationId, organizationId),
			),
		)
		.returning({ id: githubDeploymentConnection.connectionId });
	return rows.length > 0;
};

/** The token of an active connection, for the poller. Null when missing or revoked. */
export const loadConnectionToken = async (connectionId: string) => {
	const [row] = await db
		.select({
			accessToken: githubDeploymentConnection.accessToken,
			status: githubDeploymentConnection.status,
		})
		.from(githubDeploymentConnection)
		.where(eq(githubDeploymentConnection.connectionId, connectionId));
	return row && row.status === "active" && row.accessToken
		? row.accessToken
		: null;
};

export const markGithubConnectionRevoked = async (connectionId: string) => {
	await db
		.update(githubDeploymentConnection)
		.set({
			status: "revoked",
			lastError: "GitHub rejected the token. Connect GitHub again.",
		})
		.where(eq(githubDeploymentConnection.connectionId, connectionId));
};

export const findGithubWatch = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	const [row] = await db
		.select()
		.from(githubDeploymentWatch)
		.where(
			and(
				eq(githubDeploymentWatch.serviceType, serviceType),
				eq(githubDeploymentWatch.serviceId, serviceId),
			),
		);
	return row ?? null;
};

/**
 * The watches of an organization. A member who is not an owner or admin only
 * sees the services in their `accessedServices` (pass `null` for no limit).
 */
export const listGithubWatchesForOrganization = async (
	organizationId: string,
	accessedServices: string[] | null,
) => {
	if (accessedServices !== null && accessedServices.length === 0) return [];
	return db
		.select()
		.from(githubDeploymentWatch)
		.where(
			and(
				eq(githubDeploymentWatch.organizationId, organizationId),
				accessedServices === null
					? undefined
					: inArray(githubDeploymentWatch.serviceId, accessedServices),
			),
		);
};

/** Watches that use one connection (read before the connection is deleted). */
export const listGithubWatchesForConnection = async (
	connectionId: string,
	organizationId: string,
) =>
	db
		.select()
		.from(githubDeploymentWatch)
		.where(
			and(
				eq(githubDeploymentWatch.connectionId, connectionId),
				eq(githubDeploymentWatch.organizationId, organizationId),
			),
		);

export const listEnabledGithubWatches = async () =>
	db
		.select()
		.from(githubDeploymentWatch)
		.where(eq(githubDeploymentWatch.enabled, true));

/**
 * Create or change the watch of a service. Pointing it at another repository,
 * environment or account, or turning a disabled watch back on, forgets the
 * cursor, so the next poll baselines again at the then-newest deployment and
 * the backlog that piled up meanwhile never runs.
 */
export const upsertGithubWatch = async (input: {
	organizationId: string;
	serviceType: GithubWatchServiceType;
	serviceId: string;
	connectionId: string;
	owner: string;
	repo: string;
	environment: string;
	enabled: boolean;
	postLogUrl?: boolean;
}) => {
	const existing = await findGithubWatch(input.serviceType, input.serviceId);
	const moved =
		!existing ||
		existing.owner !== input.owner ||
		existing.repo !== input.repo ||
		existing.environment !== input.environment ||
		existing.connectionId !== input.connectionId ||
		(!existing.enabled && input.enabled);
	const cursorReset = moved
		? {
				lastSeenDeploymentId: null,
				etag: null,
				inflightDeploymentId: null,
				inflightStartedAt: null,
			}
		: {};
	const [row] = await db
		.insert(githubDeploymentWatch)
		.values({ ...input, lastError: null })
		.onConflictDoUpdate({
			target: [
				githubDeploymentWatch.serviceType,
				githubDeploymentWatch.serviceId,
			],
			set: {
				connectionId: input.connectionId,
				owner: input.owner,
				repo: input.repo,
				environment: input.environment,
				enabled: input.enabled,
				...(input.postLogUrl === undefined
					? {}
					: { postLogUrl: input.postLogUrl }),
				lastError: null,
				...cursorReset,
			},
		})
		.returning();
	if (!row) throw new Error("Could not save the watch");
	return row;
};

export const deleteGithubWatch = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	await db
		.delete(githubDeploymentWatch)
		.where(
			and(
				eq(githubDeploymentWatch.serviceType, serviceType),
				eq(githubDeploymentWatch.serviceId, serviceId),
			),
		);
};

/**
 * Update a watch. `lastSeenDeploymentId` only ever moves forward (a late or
 * repeated write from a slow tick cannot rewind the cursor and replay a
 * deployment); the cursor is reset only by `upsertGithubWatch`.
 */
export const patchGithubWatch = async (
	watchId: string,
	patch: Omit<
		Partial<typeof githubDeploymentWatch.$inferInsert>,
		"lastSeenDeploymentId"
	> & { lastSeenDeploymentId?: number },
) => {
	const { lastSeenDeploymentId, ...rest } = patch;
	if (Object.keys(rest).length > 0) {
		await db
			.update(githubDeploymentWatch)
			.set(rest)
			.where(eq(githubDeploymentWatch.watchId, watchId));
	}
	if (lastSeenDeploymentId !== undefined) {
		await db
			.update(githubDeploymentWatch)
			.set({ lastSeenDeploymentId })
			.where(
				and(
					eq(githubDeploymentWatch.watchId, watchId),
					or(
						isNull(githubDeploymentWatch.lastSeenDeploymentId),
						lt(
							githubDeploymentWatch.lastSeenDeploymentId,
							lastSeenDeploymentId,
						),
					),
				),
			);
	}
};

/**
 * The ghcr.io login for a service that follows GitHub Deployments, or null.
 * Used at pull time only; the token is never stored on the service itself.
 * `watchId` names the watch's own Docker config dir and `owner` is the GitHub
 * account whose images the login may be used for.
 */
export const loadGhcrCredentials = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	const watch = await findGithubWatch(serviceType, serviceId);
	if (!watch || !watch.enabled) return null;
	const [row] = await db
		.select({
			githubLogin: githubDeploymentConnection.githubLogin,
			accessToken: githubDeploymentConnection.accessToken,
			status: githubDeploymentConnection.status,
		})
		.from(githubDeploymentConnection)
		.where(eq(githubDeploymentConnection.connectionId, watch.connectionId));
	if (!row || row.status !== "active" || !row.accessToken) return null;
	return {
		watchId: watch.watchId,
		owner: watch.owner,
		registryUrl: "ghcr.io",
		username: row.githubLogin,
		password: row.accessToken,
	};
};
