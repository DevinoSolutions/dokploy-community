import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema/deployment";
import {
	type GithubWatchServiceType,
	githubDeploymentConnection,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema/github-deployment";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	like,
	lt,
	not,
	or,
} from "drizzle-orm";

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
	sharedWithOrganization: row.sharedWithOrganization,
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

/**
 * What the router needs to decide who may see or use a connection: the
 * presentable fields plus its owner. Never sent to a client as is (the owner
 * is dropped by `visibleGithubConnections`), and never carries the token.
 */
export type GithubConnectionRecord = ReturnType<
	typeof presentGithubConnection
> & { createdByUserId: string | null };

const toConnectionRecord = (
	row: GithubConnectionRow,
): GithubConnectionRecord => ({
	...presentGithubConnection(row),
	createdByUserId: row.createdByUserId,
});

/** Every connection of the organization; the caller filters them by viewer. */
export const listGithubConnectionRecords = async (
	organizationId: string,
): Promise<GithubConnectionRecord[]> => {
	const rows = await db
		.select()
		.from(githubDeploymentConnection)
		.where(eq(githubDeploymentConnection.organizationId, organizationId));
	return rows.map(toConnectionRecord);
};

export const findGithubConnectionInOrganization = async (
	connectionId: string,
	organizationId: string,
): Promise<GithubConnectionRecord | null> => {
	const [row] = await db
		.select()
		.from(githubDeploymentConnection)
		.where(
			and(
				eq(githubDeploymentConnection.connectionId, connectionId),
				eq(githubDeploymentConnection.organizationId, organizationId),
			),
		);
	return row ? toConnectionRecord(row) : null;
};

/** Share a connection with the organization or take it back (the router checks who may). */
export const setGithubConnectionShared = async (
	connectionId: string,
	organizationId: string,
	sharedWithOrganization: boolean,
) => {
	const [row] = await db
		.update(githubDeploymentConnection)
		.set({ sharedWithOrganization })
		.where(
			and(
				eq(githubDeploymentConnection.connectionId, connectionId),
				eq(githubDeploymentConnection.organizationId, organizationId),
			),
		)
		.returning();
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

/** What the watch writes accept in place of the shared client: a transaction. */
export type WatchExecutor = Pick<typeof db, "select" | "insert" | "delete">;

export const findGithubWatch = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
	executor: WatchExecutor = db,
) => {
	const [row] = await executor
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
}, executor: WatchExecutor = db) => {
	const existing = await findGithubWatch(
		input.serviceType,
		input.serviceId,
		executor,
	);
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
	const [row] = await executor
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
	executor: WatchExecutor = db,
) => {
	await executor
		.delete(githubDeploymentWatch)
		.where(
			and(
				eq(githubDeploymentWatch.serviceType, serviceType),
				eq(githubDeploymentWatch.serviceId, serviceId),
			),
		);
};

/**
 * Update a watch.
 *
 * `lastSeenDeploymentId` only ever moves forward (a late or repeated write from
 * a slow tick cannot rewind the cursor and replay a deployment); the cursor is
 * reset only by `upsertGithubWatch`.
 *
 * `ifCursor` makes the whole patch a compare-and-set: it is applied only while
 * the stored cursor still equals the cursor the poll started from (`null` = not
 * baselined yet). A tick that read the watch before it was disabled and enabled
 * again (which resets the cursor to null) therefore cannot write its stale
 * cursor, ETag or progress over the reset. Returns whether anything was written.
 */
export const patchGithubWatch = async (
	watchId: string,
	patch: Omit<
		Partial<typeof githubDeploymentWatch.$inferInsert>,
		"lastSeenDeploymentId"
	> & { lastSeenDeploymentId?: number },
	options: { ifCursor?: number | null } = {},
): Promise<boolean> => {
	const { lastSeenDeploymentId, ...rest } = patch;
	const cursor = githubDeploymentWatch.lastSeenDeploymentId;
	const forward =
		lastSeenDeploymentId === undefined
			? undefined
			: or(isNull(cursor), lt(cursor, lastSeenDeploymentId));
	if (options.ifCursor !== undefined) {
		const set = {
			...rest,
			...(lastSeenDeploymentId === undefined ? {} : { lastSeenDeploymentId }),
		};
		if (Object.keys(set).length === 0) return true;
		const written = await db
			.update(githubDeploymentWatch)
			.set(set)
			.where(
				and(
					eq(githubDeploymentWatch.watchId, watchId),
					options.ifCursor === null
						? isNull(cursor)
						: eq(cursor, options.ifCursor),
					forward,
				),
			)
			.returning({ watchId: githubDeploymentWatch.watchId });
		return written.length > 0;
	}
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
			.where(and(eq(githubDeploymentWatch.watchId, watchId), forward));
	}
	return true;
};

const warnedNoPackagesScope = new Set<string>();
/** Once per watch and process: a private GHCR pull that follows will fail, and this says why. */
const warnNoPackagesScope = (watchId: string) => {
	if (warnedNoPackagesScope.has(watchId)) return;
	warnedNoPackagesScope.add(watchId);
	console.warn(
		`GitHub deployments: the GitHub connection of watch ${watchId} was not authorized for read:packages, so no ghcr.io login is made and a private package fails to pull. Reconnect GitHub with "also pull private GHCR packages" (Settings, Git).`,
	);
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
			scopes: githubDeploymentConnection.scopes,
		})
		.from(githubDeploymentConnection)
		.where(eq(githubDeploymentConnection.connectionId, watch.connectionId));
	if (!row || row.status !== "active" || !row.accessToken) return null;
	// Only a connection that was authorized for packages may log in to GHCR.
	// A GitHub Actions connection never asks for it: prod holds no GHCR token.
	if (!row.scopes.split(",").includes("read:packages")) {
		warnNoPackagesScope(watch.watchId);
		return null;
	}
	return {
		watchId: watch.watchId,
		owner: watch.owner,
		registryUrl: "ghcr.io",
		username: row.githubLogin,
		password: row.accessToken,
	};
};

/** A GitHub Actions deployment of a service this recent counts as "the action deploys it". */
export const OTHER_DEPLOYER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The title ending that marks a Dokploy deployment started by the poller
 * ("... [deployment #<GitHub deployment id>]"). Those rows are this feature's
 * own, not a second deployer.
 */
export const GITHUB_DEPLOYMENT_HANDLE_LIKE = "% [deployment #%]";

/**
 * Another deployer on this service: a deployment row of the last 24 hours that
 * the dokploy-deploy action sent (a live row registered while GitHub builds, or
 * any row with build origin github-actions), other than the ones this poller
 * started. Setting up a watch on such a service makes two writers of its image;
 * the router refuses unless asked to override.
 */
export const findRecentOtherGithubDeployer = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
	now: number = Date.now(),
) => {
	const [row] = await db
		.select({
			title: deployments.title,
			createdAt: deployments.createdAt,
			externalBuildOnly: deployments.externalBuildOnly,
		})
		.from(deployments)
		.where(
			and(
				serviceType === "application"
					? eq(deployments.applicationId, serviceId)
					: eq(deployments.composeId, serviceId),
				gte(
					deployments.createdAt,
					new Date(now - OTHER_DEPLOYER_WINDOW_MS).toISOString(),
				),
				or(
					eq(deployments.externalBuildOnly, true),
					eq(deployments.buildOrigin, "github-actions"),
				),
				not(like(deployments.title, GITHUB_DEPLOYMENT_HANDLE_LIKE)),
			),
		)
		.orderBy(desc(deployments.createdAt))
		.limit(1);
	return row ?? null;
};
