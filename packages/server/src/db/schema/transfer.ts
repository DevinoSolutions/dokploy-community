import { z } from "zod";
import { serviceType } from "./mount";

export const apiTransferService = z.object({
	serviceType: z.enum(serviceType.enumValues),
	serviceId: z.string().min(1),
	targetServerId: z.string().min(1).nullable(),
	removeSourceData: z.boolean().default(false),
	// The volumes and bind mount directories that already hold data on the
	// target server and that the caller agrees to write over. A transfer is
	// refused while the target holds data under a name that is not listed here.
	overwriteTargets: z.array(z.string().min(1).max(4096)).max(500).default([]),
});

// The same request, without the part that only a transfer needs: what the
// pre-flight scan is given.
export const apiTransferPreflight = apiTransferService.omit({
	removeSourceData: true,
});
