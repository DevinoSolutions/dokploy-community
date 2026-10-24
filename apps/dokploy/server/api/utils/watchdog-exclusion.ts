import { IS_CLOUD } from "@dokploy/server/constants";
import {
	addWatchdogExclusion,
	getWebServerSettings,
	removeWatchdogExclusion,
} from "@dokploy/server/services/web-server-settings";
import {
	isWatchdogExcluded,
	resolveWatchdogConfig,
} from "@dokploy/server/utils/deployments/watchdog-config";
import { TRPCError } from "@trpc/server";

/**
 * The per-service switch "Exclude from the stuck-deployment watchdog". It reads
 * and writes the same instance-wide list as the admin card in Settings >
 * Deployments (a list on the web server settings, not a column: the
 * application table is at the 100-column limit of a relational query). The
 * caller has already checked the permission on the service. Writes are one
 * atomic UPDATE (see web-server-settings.ts), so two people flipping switches
 * at once cannot lose an entry.
 */

export type WatchdogServiceRef =
	| { type: "application"; id: string }
	| { type: "compose"; id: string };

const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This feature is only available for self-hosted instances",
		});
	}
};

/** Whether the service is excluded, and whether the watchdog is on at all. */
export const readServiceWatchdogExclusion = async (
	service: WatchdogServiceRef,
) => {
	if (IS_CLOUD) return { excluded: false, watchdogEnabled: false };
	const config = resolveWatchdogConfig(await getWebServerSettings());
	return {
		excluded: isWatchdogExcluded(config.exclusions, {
			applicationId: service.type === "application" ? service.id : null,
			composeId: service.type === "compose" ? service.id : null,
		}),
		watchdogEnabled: config.enabled,
	};
};

/** Adds or removes the service from the list; returns the new state. */
export const writeServiceWatchdogExclusion = async (
	service: WatchdogServiceRef,
	excluded: boolean,
) => {
	assertSelfHosted();
	if (excluded) {
		await addWatchdogExclusion(
			{ type: service.type, id: service.id },
			{ keepExisting: true },
		);
	} else {
		await removeWatchdogExclusion(service.type, service.id);
	}
	return { excluded };
};
