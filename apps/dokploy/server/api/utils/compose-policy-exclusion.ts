import {
	getComposePolicySettings,
	setComposePolicyExclusion,
} from "@dokploy/server/services/compose-policy-audit";
import { isComposePolicyExcluded } from "@dokploy/server/utils/compose-policy/config";

/**
 * The per-service switch "Exclude from the restricted-compose audit". It reads
 * and writes the same list of the organization as the card in Settings >
 * Deployments (a list on the organization, not a column of compose: the
 * application and compose tables sit at the 100-column limit of a relational
 * query). The caller has already checked the permission on the compose, and
 * `organizationId` is the one of that compose. Writes are one atomic UPDATE
 * (see services/compose-policy-audit.ts), so two people flipping switches at
 * once cannot lose an entry.
 */

/** Whether the compose is excluded, and whether the audit is on at all. */
export const readComposePolicyExclusion = async (
	organizationId: string,
	composeId: string,
) => {
	const settings = await getComposePolicySettings(organizationId);
	return {
		excluded: isComposePolicyExcluded(settings.exclusions, composeId),
		auditEnabled: settings.auditEnabled,
	};
};

/** Adds or removes the compose from the list; returns the new state. */
export const writeComposePolicyExclusion = (
	organizationId: string,
	composeId: string,
	excluded: boolean,
) => setComposePolicyExclusion(organizationId, composeId, excluded);
