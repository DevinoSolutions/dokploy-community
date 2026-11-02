import { countActiveDeploymentsOnHost, findServerById } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";

/**
 * Guards the routes that prune the Docker builder cache or run `system prune`.
 *
 * On a large BuildKit store a prune holds one write transaction for hours and
 * every `docker build` on the host waits behind it (2026-11-02: all worker
 * slots hung, the deploy queue froze). A prune therefore refuses to start while
 * builds run on the host unless the caller passes `force`, and every prune
 * leaves an audit row before it starts, because it may never return.
 */

/** Input of the routes that prune the builder cache. */
export const builderPruneInput = z.object({
	serverId: z.string().optional(),
	/** Run even though builds are active on the server. */
	force: z.boolean().default(false),
	/** Prune the whole unused cache instead of entries older than a week. */
	all: z.boolean().default(false),
});

/** Input of `settings.cleanAll`. */
export const cleanAllInput = z.object({
	serverId: z.string().optional(),
	force: z.boolean().default(false),
	/** Prune the whole unused build cache instead of entries unused for a week. */
	all: z.boolean().default(false),
});

export type BuilderPruneGuardDecision = {
	/** The prune may start. */
	allowed: boolean;
	/** It may start only because the caller forced it past running builds. */
	forced: boolean;
};

/** The whole decision: a prune starts on an idle host, or when forced. */
export const decideBuilderPrune = ({
	activeBuilds,
	force,
}: {
	activeBuilds: number;
	force: boolean;
}): BuilderPruneGuardDecision => ({
	allowed: force || activeBuilds === 0,
	forced: force && activeBuilds > 0,
});

export const builderPruneBlockedMessage = (
	activeBuilds: number,
	hostName: string,
) =>
	`Builder cache cleanup is blocked while ${activeBuilds} build(s) run on ${hostName}. It would pause every build for the whole prune. Retry when the server is idle.`;

export const LOCAL_HOST_NAME = "the Dokploy server";

export type BuilderPruneGuardDeps = {
	countActive?: (serverId: string | undefined) => Promise<number>;
	resolveHostName?: (serverId: string | undefined) => Promise<string>;
	warn?: (message: string) => void;
};

const defaultResolveHostName = async (serverId: string | undefined) => {
	if (!serverId) return LOCAL_HOST_NAME;
	return (await findServerById(serverId)).name;
};

export type BuilderPruneGuardResult = BuilderPruneGuardDecision & {
	activeBuilds: number;
	hostName: string;
	/** The build count could not be read; the server counts as busy. */
	checkFailed: boolean;
};

export const builderPruneCheckFailedMessage = (hostName: string) =>
	`Builder cache cleanup is blocked: could not check the builds running on ${hostName}. Retry when the server is idle.`;

/**
 * Counts the builds on the host and decides. Builds on a host are the
 * `running` deployments and the queued deploy jobs of every service that deploys
 * to it or builds on it (see countActiveDeploymentsOnHost). A check that fails
 * counts as busy, never as idle: the result is blocked and `checkFailed`.
 */
export const checkBuilderPrune = async (
	{ serverId, force }: { serverId?: string; force: boolean },
	deps: BuilderPruneGuardDeps = {},
): Promise<BuilderPruneGuardResult> => {
	const countActive = deps.countActive ?? countActiveDeploymentsOnHost;
	const resolveHostName = deps.resolveHostName ?? defaultResolveHostName;
	const warn = deps.warn ?? ((message: string) => console.warn(message));

	const hostName = await resolveHostName(serverId);
	let activeBuilds: number;
	try {
		activeBuilds = await countActive(serverId);
	} catch (error) {
		if (!force) {
			return {
				allowed: false,
				forced: false,
				activeBuilds: 0,
				hostName,
				checkFailed: true,
			};
		}
		warn(
			`[builder-prune] forced on ${hostName} without a build check: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return {
			allowed: true,
			forced: true,
			activeBuilds: 0,
			hostName,
			checkFailed: true,
		};
	}

	const decision = decideBuilderPrune({ activeBuilds, force });
	if (force) {
		warn(
			`[builder-prune] forced on ${hostName}: ${activeBuilds} build(s) active`,
		);
	}
	return { ...decision, activeBuilds, hostName, checkFailed: false };
};

/** Like `checkBuilderPrune`, but a blocked prune throws PRECONDITION_FAILED. */
export const assertBuilderPruneAllowed = async (
	input: { serverId?: string; force: boolean },
	deps: BuilderPruneGuardDeps = {},
): Promise<BuilderPruneGuardResult> => {
	const result = await checkBuilderPrune(input, deps);
	if (!result.allowed) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: result.checkFailed
				? builderPruneCheckFailedMessage(result.hostName)
				: builderPruneBlockedMessage(result.activeBuilds, result.hostName),
		});
	}
	return result;
};

type AuditCtx = Parameters<typeof audit>[0];

/**
 * Records who started a prune. Written before the prune runs: a prune can take
 * hours, and the request that started it may never return.
 */
export const auditBuilderPrune = (
	ctx: AuditCtx,
	{
		operation,
		serverId,
		hostName,
		force,
		all,
		...extra
	}: {
		operation: string;
		serverId?: string;
		hostName: string;
		force: boolean;
		all?: boolean;
	} & Record<string, unknown>,
	auditFn: typeof audit = audit,
) =>
	auditFn(ctx, {
		action: "delete",
		resourceType: "server",
		resourceId: serverId ?? "local",
		resourceName: hostName,
		metadata: { operation, force, all: all ?? false, ...extra },
	});
