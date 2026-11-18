/**
 * Who may use a GitHub connection (the device-flow token of one person).
 *
 * The token acts as the connecting person on GitHub (`repo` is full control of
 * their private repositories, `public_repo` read and write on their public
 * ones, `read:packages` their private GHCR packages), so a connection is not an
 * organization-wide resource. The model is the one Git
 * providers have (services/git-provider.ts):
 *
 * - the person who connected it (`createdByUserId`) owns it;
 * - an organization owner or admin may use and remove any connection;
 * - every other member may use (bind to a service) only their own connection,
 *   or one its owner shared with the organization (`sharedWithOrganization`);
 * - only the owner and owners/admins may remove one, and only the owner may
 *   share it.
 *
 * Pure functions, no I/O, so the rules are tested without a database.
 */

export interface ConnectionAccessRecord {
	createdByUserId: string | null;
	sharedWithOrganization: boolean;
}

export interface ConnectionViewer {
	userId: string;
	/** The viewer's role in the active organization. */
	role: string;
}

export const isOrganizationAdmin = (viewer: ConnectionViewer) =>
	viewer.role === "owner" || viewer.role === "admin";

export const ownsGithubConnection = (
	connection: ConnectionAccessRecord,
	viewer: ConnectionViewer,
) =>
	connection.createdByUserId !== null &&
	connection.createdByUserId === viewer.userId;

/** May `viewer` see this connection and bind it to a service? */
export const canUseGithubConnection = (
	connection: ConnectionAccessRecord,
	viewer: ConnectionViewer,
) =>
	isOrganizationAdmin(viewer) ||
	ownsGithubConnection(connection, viewer) ||
	connection.sharedWithOrganization;

/** May `viewer` remove this connection (and so every watch that uses it)? */
export const canRemoveGithubConnection = (
	connection: ConnectionAccessRecord,
	viewer: ConnectionViewer,
) => isOrganizationAdmin(viewer) || ownsGithubConnection(connection, viewer);

/**
 * May the poller use this connection's token for this watch (T-13796)?
 *
 * Checked at use time, on every tick and every pull, so it holds however the
 * rows came to be (the router, a restore, a direct change), not only when the
 * owner unshares through `toggleShare`:
 *
 * - while the connection is shared with the organization, yes;
 * - otherwise only a watch whose last saver is the connection's owner, or
 *   (`creatorIsAdmin`) a current owner or admin of the organization, who may
 *   use any connection;
 * - a watch with no recorded saver on a connection that is not shared is
 *   blocked (fail closed) until the connection's owner saves it again.
 *
 * Blocking is not deleting: sharing the connection again, or the owner saving
 * the watch, makes it work again without re-creating anything.
 */
export type WatchAccess =
	| { allowed: true }
	| {
			allowed: false;
			reason: "not-shared" | "creator-unknown";
			message: string;
	  };

export const WATCH_BLOCKED_NOT_SHARED =
	'Paused: the GitHub connection of this watch is no longer shared with the organization. Share it again, or its owner can take the watch over (Settings, Git, GitHub Deployments, "Take over watches").';
export const WATCH_BLOCKED_CREATOR_UNKNOWN =
	'Paused: the GitHub connection of this watch is not shared with the organization and the member who set the watch up is unknown. Its owner must save the watch again or take it over (Settings, Git, GitHub Deployments, "Take over watches"), or share the connection.';

export const evaluateWatchAccess = async (
	connection: ConnectionAccessRecord,
	watch: { createdByUserId: string | null },
	creatorIsAdmin: () => Promise<boolean>,
): Promise<WatchAccess> => {
	if (connection.sharedWithOrganization) return { allowed: true };
	const creator = watch.createdByUserId;
	if (creator === null) {
		return {
			allowed: false,
			reason: "creator-unknown",
			message: WATCH_BLOCKED_CREATOR_UNKNOWN,
		};
	}
	if (
		connection.createdByUserId !== null &&
		creator === connection.createdByUserId
	) {
		return { allowed: true };
	}
	if (await creatorIsAdmin()) return { allowed: true };
	return {
		allowed: false,
		reason: "not-shared",
		message: WATCH_BLOCKED_NOT_SHARED,
	};
};

/** What the connection list shows `viewer`: their own, the shared ones, and everything to an owner or admin. */
export const visibleGithubConnections = <
	T extends ConnectionAccessRecord & { createdByUserId: string | null },
>(
	connections: T[],
	viewer: ConnectionViewer,
): Array<Omit<T, "createdByUserId"> & { isOwner: boolean }> =>
	connections
		.filter((connection) => canUseGithubConnection(connection, viewer))
		.map(({ createdByUserId, ...rest }) => ({
			...rest,
			isOwner: createdByUserId !== null && createdByUserId === viewer.userId,
		}));
