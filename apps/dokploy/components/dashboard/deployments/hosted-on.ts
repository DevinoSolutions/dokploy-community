import { isGithubActionsDeployment } from "@dokploy/server/services/build-origin-shared";

type ServerRef =
	| { serverId: string; name: string; serverType?: string | null }
	| null
	| undefined;

export type HostedOnInput = {
	buildOrigin?: string | null;
	title?: string | null;
	server?: ServerRef;
	buildServer?: ServerRef;
	application?: { server?: ServerRef; buildServer?: ServerRef } | null;
	compose?: { server?: ServerRef } | null;
};

export type HostedOn = {
	hostName: string;
	hostType: string | null;
	builtOn: { name: string; type: string | null } | null;
};

/** Name shown for a service that runs on the Dokploy host itself (no remote server). */
export const DOKPLOY_HOST_NAME = "Dokploy";

/**
 * The "Hosted on" cell of the deployments table (T-13981): always where the service runs, plus the build
 * server only when Dokploy built the image on a different machine. GitHub Actions rows never get a build line.
 */
export function describeHostedOn(d: HostedOnInput): HostedOn {
	const host = d.server ?? d.application?.server ?? d.compose?.server ?? null;
	const hostName = host?.name ?? DOKPLOY_HOST_NAME;
	const build = d.buildServer ?? d.application?.buildServer ?? null;
	const builtOn =
		build && !isGithubActionsDeployment(d) && build.serverId !== host?.serverId
			? { name: build.name, type: build.serverType ?? null }
			: null;
	return { hostName, hostType: host?.serverType ?? null, builtOn };
}
