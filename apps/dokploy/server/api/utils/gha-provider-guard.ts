import { findApplicationById, findComposeById } from "@dokploy/server";
import {
	checkRedeployable,
	checkSourceTypeChange,
	isGhaSourceType,
	keepsProvider,
} from "@dokploy/server/services/gha-connect/provider";
import { findGhaConnection } from "@dokploy/server/services/gha-connect/store";
import { TRPCError } from "@trpc/server";

/**
 * Router side of GitHub Actions as a provider (T-13879): a service that is connected cannot be moved to another
 * source by a side door, and a service cannot be marked github-actions without Connect. The rules are in
 * `services/gha-connect/provider`; this only reads the service and its connection.
 */

type Kind = "application" | "compose";

/**
 * Refuses an edit that would move a connected service off GitHub Actions (or onto it without Connect). Returns true
 * when the call only repeats the provider the service already has (the compose file editor sends `raw` back), so the
 * caller must leave the source type out of the write.
 *
 * `strict` is for calls that replace the service's content (a template, an import, a zip): even the equivalent
 * stored-file type is refused there, because the call would overwrite what GitHub Actions releases pinned.
 */
export const assertSourceChangeAllowed = async (input: {
	serviceType: Kind;
	serviceId: string;
	/** The source type the call would set; undefined when it does not set one. */
	nextSourceType: string | undefined;
	strict?: boolean;
}): Promise<boolean> => {
	if (input.nextSourceType === undefined) return false;
	const current =
		input.serviceType === "application"
			? await findApplicationById(input.serviceId).catch(() => null)
			: await findComposeById(input.serviceId).catch(() => null);
	const currentSourceType = current?.sourceType;
	if (!currentSourceType) return false;
	const connected = isGhaSourceType(currentSourceType)
		? (await findGhaConnection(input.serviceType, input.serviceId)) !== null
		: false;
	if (
		!input.strict &&
		connected &&
		keepsProvider(input.serviceType, currentSourceType, input.nextSourceType)
	) {
		return true;
	}
	const refusal = checkSourceTypeChange({
		currentSourceType,
		connected,
		nextSourceType: input.nextSourceType,
	});
	if (refusal) {
		throw new TRPCError({ code: refusal.code, message: refusal.message });
	}
	return false;
};

/** A manual deploy of a GitHub Actions application with no release yet: say what to do instead of queueing it. */
export const assertRedeployable = async (
	service: { sourceType: string; dockerImage?: string | null },
	applicationId: string,
) => {
	if (!isGhaSourceType(service.sourceType)) return;
	const connection = await findGhaConnection("application", applicationId);
	const redeploy = checkRedeployable(
		"application",
		service,
		connection?.trackedBranch,
	);
	if (!redeploy.ok) {
		throw new TRPCError({ code: "BAD_REQUEST", message: redeploy.message });
	}
};
