import { findServerById, getWebServerSettings } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { assertServerInOrganization } from "./server-org-scope";

/**
 * `server.getServerMetrics` and `user.getContainerMetrics` used to take the
 * metrics `url` and bearer `token` straight from the client and `fetch()` them
 * from the Dokploy host. That is a server-side request forgery primitive: any
 * authenticated user holding `monitoring:read` could make the host issue a GET
 * against an arbitrary internal address (other containers, cloud metadata
 * endpoints, ...) and read the response body back through tRPC, with an
 * attacker-chosen `Authorization` header attached.
 *
 * Both procedures now take a `serverId` instead and derive the endpoint from
 * the stored row, so the URL can only ever be a Dokploy-managed monitoring
 * endpoint inside the caller's own organization.
 *
 * Returns the endpoint *base* (`http://ip:port`); callers append their own path
 * (`/metrics`, `/metrics/containers`).
 */
export const resolveMetricsEndpoint = async (
	serverId: string | undefined,
	activeOrganizationId: string | null | undefined,
): Promise<{ baseUrl: string; token: string }> => {
	const notConfigured = new TRPCError({
		code: "BAD_REQUEST",
		message:
			"Monitoring is not configured for this server. Go to Settings → Servers → Setup Monitoring.",
	});

	if (serverId) {
		// Fail-closed before any row is read: a cross-organization serverId must
		// not even reveal whether monitoring is configured.
		await assertServerInOrganization(serverId, activeOrganizationId);
		const server = await findServerById(serverId);
		const port = server.metricsConfig?.server?.port;
		const token = server.metricsConfig?.server?.token;
		if (!server.ipAddress || !port || !token) {
			throw notConfigured;
		}
		return { baseUrl: `http://${server.ipAddress}:${port}`, token };
	}

	// Local Dokploy host. `pnpm dev` runs the metrics collector as a standalone
	// stub on localhost:3001 with a fixed token; this mirrors the dev-only
	// endpoint the monitoring page used to hardcode client-side.
	if (process.env.NODE_ENV !== "production") {
		return { baseUrl: "http://localhost:3001", token: "metrics" };
	}

	const settings = await getWebServerSettings();
	const port = settings?.metricsConfig?.server?.port;
	const token = settings?.metricsConfig?.server?.token;
	if (!settings?.serverIp || !port || !token) {
		throw notConfigured;
	}
	return { baseUrl: `http://${settings.serverIp}:${port}`, token };
};
