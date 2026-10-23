import type { ServiceType } from "@dokploy/server/db/schema";
import { loadVolumeBindingFacts } from "@dokploy/server/services/volume-binding";
import {
	assertVolumeBindingAllowed,
	isPrivilegedVolumeRole,
} from "@dokploy/server/utils/volume-backups/binding";

/**
 * A Docker volume name is global to the host, so a volume backup, a restore or
 * a named mount may only use a name that belongs to the service it is saved on
 * (see utils/volume-backups/binding.ts). Throws BAD_REQUEST otherwise.
 *
 * `existingRow` marks a name that is already stored on the row being saved
 * again: it keeps the owner/admin reach, because the role of whoever stored it
 * is unknown. Run-time checks refuse it when another organization claims it.
 *
 * Must run after the service permission check and before anything is written.
 */
export const assertVolumeNameForService = async (
	ctx: { user: { role?: string | null } },
	{
		serviceType,
		serviceId,
		volumeName,
		existingRow = false,
	}: {
		serviceType: ServiceType;
		serviceId: string;
		volumeName: string;
		existingRow?: boolean;
	},
) => {
	const facts = await loadVolumeBindingFacts({
		serviceType,
		serviceId,
		volumeName,
	});
	assertVolumeBindingAllowed(facts, {
		privileged: existingRow || isPrivilegedVolumeRole(ctx.user.role),
	});
};
