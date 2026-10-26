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
