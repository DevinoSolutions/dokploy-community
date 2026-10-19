interface CancelledByEntry {
	actorType: "user" | "api_key" | "oauth_client" | "system";
	actorEmail: string | null;
	apiKeyName: string | null;
	apiKeyShortId: string | null;
	oauthClientName?: string | null;
	oauthClientShortId?: string | null;
}

/**
 * The line a cancelled deployment shows under its status: who stopped it.
 * An API key is named by its name, or by the start of its id when it has none
 * (or has been deleted), next to the user it belongs to. An MCP client that
 * authenticated with an OAuth token is named the same way, by its name or by
 * the start of its client id.
 */
export const describeCancelledBy = (entry: CancelledByEntry): string => {
	if (entry.actorType === "system") return "Cancelled by system";
	const user = entry.actorEmail?.trim() || null;
	if (entry.actorType === "api_key") {
		const key = entry.apiKeyName?.trim() || entry.apiKeyShortId;
		const label = key ? `API key ${key}` : "an API key";
		return user ? `Cancelled by ${label} (${user})` : `Cancelled by ${label}`;
	}
	if (entry.actorType === "oauth_client") {
		const client = entry.oauthClientName?.trim() || entry.oauthClientShortId;
		if (!client) return `Cancelled by ${user ?? "a user"}`;
		return user
			? `Cancelled by ${user} via MCP client ${client}`
			: `Cancelled by MCP client ${client}`;
	}
	return `Cancelled by ${user ?? "a user"}`;
};

/** How long after a deployment is cancelled its trail entry is still awaited. */
export const CANCELLED_BY_WAIT_MS = 2 * 60 * 1000;

interface ListedDeployment {
	deploymentId: string;
	status: string | null;
	createdAt: string;
	finishedAt: string | null;
}

/**
 * Whether to keep re-reading the cancel trail: a deployment was cancelled in
 * the last two minutes and has no entry yet (the entry is written just after
 * the status changes). Older cancelled rows without an entry, such as ones
 * cancelled before the trail existed, never get one, so they stop the polling.
 */
export const isAwaitingCancelledBy = (
	deployments: ListedDeployment[] | undefined,
	trailDeploymentIds: ReadonlySet<string>,
	now: number,
): boolean =>
	Boolean(
		deployments?.some((deployment) => {
			if (deployment.status !== "cancelled") return false;
			if (trailDeploymentIds.has(deployment.deploymentId)) return false;
			const cancelledAt = Date.parse(
				deployment.finishedAt ?? deployment.createdAt,
			);
			return now - cancelledAt <= CANCELLED_BY_WAIT_MS;
		}),
	);
