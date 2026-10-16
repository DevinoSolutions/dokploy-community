import {
	type ComposeRollingReplace,
	getRollingEligibility,
	getStackPreflightWarnings,
	type RollingBlocker,
	type RollingSpec,
	type StackPreflightWarning,
} from "@dokploy/server/utils/builders/compose-rolling";
import {
	addDomainToCompose,
	cloneCompose,
} from "@dokploy/server/utils/docker/domain";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { findComposeById } from "./compose";

export interface ComposeRollingServiceReport {
	name: string;
	eligible: boolean;
	blockers: RollingBlocker[];
}

export type ComposeRollingReport =
	| { available: false; reason: string }
	| {
			available: true;
			services: ComposeRollingServiceReport[];
			/** Stack composes only: services that silently stop-first. */
			stackWarnings: StackPreflightWarning[];
	  };

/**
 * The spec a deploy would run (domains, randomize and isolated deployment
 * applied), so service names and blockers match what Compose will see.
 * `fetch` clones the source first, `cache` reads what is on disk.
 */
const loadRenderedSpec = async (composeId: string, type: "fetch" | "cache") => {
	const compose = await findComposeById(composeId);
	if (type === "fetch") {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	}
	try {
		const spec = (await addDomainToCompose(
			compose,
			compose.domains,
		)) as unknown as RollingSpec | null;
		return { compose, spec };
	} catch (error) {
		return {
			compose,
			spec: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
};

/**
 * Per service of the compose: can it be rolled, and if not, why. Backs the
 * service picker of the settings card.
 */
export const getComposeRollingReport = async (
	composeId: string,
	{ type = "cache" }: { type?: "fetch" | "cache" } = {},
): Promise<ComposeRollingReport> => {
	const loaded = await loadRenderedSpec(composeId, type);
	const { compose, spec } = loaded;
	if (!spec?.services) {
		return {
			available: false,
			reason:
				"error" in loaded && loaded.error
					? loaded.error
					: "The compose file is not available yet. Load the services first.",
		};
	}
	const services = Object.keys(spec.services).map((name) => {
		const blockers = getRollingEligibility({
			spec,
			service: name,
			composeType: compose.composeType,
			hasCustomCommand: Boolean(compose.command),
		});
		return { name, eligible: blockers.length === 0, blockers };
	});
	return {
		available: true,
		services,
		stackWarnings:
			compose.composeType === "stack" ? getStackPreflightWarnings(spec) : [],
	};
};

/**
 * Refuses to save a rolling replace setting that cannot work on the compose as
 * it is now: every selected service must be eligible, with the health timeout
 * checked against its healthcheck. Deploys re-check this (drift), a save is
 * where the user hears about it.
 */
export const assertComposeRollingSettings = async (
	composeId: string,
	settings: ComposeRollingReplace,
	overrides: { composeType?: string; command?: string | null } = {},
) => {
	if (!settings.enabled) return;
	if (settings.services.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Select at least one service to roll.",
		});
	}
	const { compose, spec } = await loadRenderedSpec(composeId, "cache");
	if (!spec?.services) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"The compose file is not available yet, so the services cannot be checked. Load the services first, then save.",
		});
	}
	const composeType = overrides.composeType ?? compose.composeType;
	const command =
		overrides.command !== undefined ? overrides.command : compose.command;

	const problems: string[] = [];
	for (const service of settings.services) {
		const blockers = getRollingEligibility({
			spec,
			service,
			composeType,
			hasCustomCommand: Boolean(command),
		});
		if (blockers.length > 0) {
			problems.push(
				`${service}: ${blockers.map((blocker) => blocker.message).join(" ")}`,
			);
		}
	}
	if (problems.length > 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Rolling replace cannot be enabled. ${problems.join(" ")}`,
		});
	}
};
