import { z } from "zod";

/**
 * Opt-in "deploy ahead of the waiting queue" flag shared by the deploy and
 * redeploy inputs. Needs the `deployment:priority` permission (owners and
 * admins). See docs/deploy-queue-priority.md.
 */
export const deployPriorityInput = z
	.boolean()
	.optional()
	.describe(
		"Start this deploy ahead of the jobs already waiting in the queue. At most one such deploy runs ahead at a time, it still waits for a free build slot and for a running deploy of the same service, and it does nothing when no job is waiting. Requires the deployment priority permission (owner or admin). The result reports how many waiting jobs it went ahead of.",
	);
