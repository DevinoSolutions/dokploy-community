type LocalHostFlag = {
	// whether the query that carries the flag was allowed to run
	enabled: boolean;
	isError: boolean;
	// `localHostAccess` from user.getMetricsToken, once it has loaded
	localHostAccess: boolean | undefined;
};

// Whether the Dokploy host's own pages are shown. The flag comes from a
// monitoring:read route, so a query that was never enabled keeps the old
// behaviour (the server still refuses the host's routes); a query that failed
// shows no host rather than assuming the organization owns it. While it loads
// the flag reads as allowed, so callers hold the host back with their own
// pending state.
export const canShowLocalHost = ({
	enabled,
	isError,
	localHostAccess,
}: LocalHostFlag) => {
	if (!enabled) {
		return true;
	}
	if (isError) {
		return false;
	}
	return localHostAccess !== false;
};

// Whether an empty list on the Dokploy host should say why instead of "No
// results.": the organization does not own the host, so what it can see there
// is only its own services' containers, if it has any. Held back while the flag
// loads, and never for a remote server.
export const explainsEmptyLocalHost = ({
	serverId,
	isFlagPending,
	canSeeLocalHost,
}: {
	serverId: string | undefined;
	isFlagPending: boolean;
	canSeeLocalHost: boolean;
}) => !serverId && !isFlagPending && !canSeeLocalHost;
