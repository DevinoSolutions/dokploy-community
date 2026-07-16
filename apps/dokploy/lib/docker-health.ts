export type ContainerHealth = "healthy" | "unhealthy" | "starting" | "none";

/**
 * Extract the Docker healthcheck state embedded in a `docker ps` status string
 * (Dokploy/dokploy#1557). Docker appends it in parentheses, e.g.:
 *   - "Up 2 minutes (healthy)"
 *   - "Up 5 seconds (health: starting)"
 *   - "Up 10 minutes (unhealthy)"
 *
 * Returns "none" when the container declares no healthcheck (the common case,
 * where the status has no parenthesised health suffix).
 */
export const parseContainerHealth = (
	status: string | null | undefined,
): ContainerHealth => {
	if (!status) {
		return "none";
	}
	const match = status.match(
		/\((?:health:\s*)?(unhealthy|healthy|starting)\)/i,
	);
	if (!match) {
		return "none";
	}
	const value = match[1]?.toLowerCase();
	if (value === "unhealthy") {
		return "unhealthy";
	}
	if (value === "healthy") {
		return "healthy";
	}
	return "starting";
};
