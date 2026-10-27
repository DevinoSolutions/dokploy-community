import { type getWebServerSettings, isRootOrganization } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { canAccessLocalHost } from "./local-host-access";

type WebServerSettings = NonNullable<
	Awaited<ReturnType<typeof getWebServerSettings>>
>;

type Caller = {
	session: { activeOrganizationId?: string | null };
	user: { role: string };
};

/**
 * The web server settings row belongs to the instance, not to the organization
 * of whoever asks: every organization on a self-hosted instance reads it. Its
 * SSH key is the instance's own and never leaves the server, and the monitoring
 * token is for the owners and admins of the organization that owns the
 * instance.
 */
export const canSeeMetricsToken = async ({ session, user }: Caller) =>
	(user.role === "owner" || user.role === "admin") &&
	!!session.activeOrganizationId &&
	(await isRootOrganization(session.activeOrganizationId));

export const redactMetricsConfig = <
	T extends WebServerSettings["metricsConfig"] | undefined,
>(
	metricsConfig: T,
	showToken: boolean,
): T =>
	showToken || !metricsConfig?.server
		? metricsConfig
		: { ...metricsConfig, server: { ...metricsConfig.server, token: "" } };

/**
 * The row as the API returns it: no SSH key, only whether there is one. The
 * host's address and its metrics settings go only to the organization that owns
 * the instance (null for any other), the rest of the row serves every
 * organization.
 */
export const toWebServerSettingsView = async (
	settings: WebServerSettings | undefined,
	caller: Caller,
) => {
	if (!settings) {
		return null;
	}
	const { sshPrivateKey, ...rest } = settings;
	const ownsHost = await canAccessLocalHost(
		undefined,
		caller.session.activeOrganizationId,
	);
	return {
		...rest,
		serverIp: ownsHost ? rest.serverIp : null,
		metricsConfig: ownsHost
			? redactMetricsConfig(
					rest.metricsConfig,
					await canSeeMetricsToken(caller),
				)
			: null,
		hasSSHPrivateKey: !!sshPrivateKey,
	};
};

/**
 * The routes that change what the host connects to or sends the token to (the
 * server IP, the domain, the monitoring setup) are the instance's own: they are
 * for the owners and admins of the organization that owns it.
 */
export const assertCanManageInstance = async (caller: Caller) => {
	if (!(await canSeeMetricsToken(caller))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Only an owner or admin of the organization that owns this instance can do this",
		});
	}
};
