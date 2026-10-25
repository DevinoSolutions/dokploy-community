// A request that Dokploy never answered: the connection dropped, or a proxy
// replied in its place. An error Dokploy answered carries data.code.
export const isConnectionLost = (error: unknown) =>
	error instanceof Error && !(error as { data?: unknown }).data;
