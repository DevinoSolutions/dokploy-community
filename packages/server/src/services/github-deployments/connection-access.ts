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
