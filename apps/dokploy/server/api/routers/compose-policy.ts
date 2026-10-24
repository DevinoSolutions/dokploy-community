import { findComposeById } from "@dokploy/server";
import {
	getComposePolicySettings,
	listComposeNamesInOrganization,
	listComposePolicyFindings,
	setComposePolicyAudit,
	setComposePolicyExclusion,
} from "@dokploy/server/services/compose-policy-audit";
import {
	apiListComposePolicyFindings,
	apiUpdateComposePolicySettings,
} from "@dokploy/server/utils/compose-policy/config";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { audit } from "../utils/audit";

/**
 * Fork router (T-7455): the "restricted compose" audit. Owners and admins
 * only, and the organization always comes from the session, never from input.
 * The audit is read-only: it records what a sandbox WOULD refuse and never
 * blocks a deploy (see services/compose-policy-audit.ts).
 */
export const composePolicyRouter = createTRPCRouter({
	// The switch and the excluded composes (named when they still exist).
	settings: adminProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const settings = await getComposePolicySettings(organizationId);
		const names = await listComposeNamesInOrganization(
			organizationId,
			settings.exclusions.map((entry) => entry.id),
		);
		return {
			auditEnabled: settings.auditEnabled,
			exclusions: settings.exclusions.map((entry) => ({
				...entry,
				name: names.find((item) => item.composeId === entry.id)?.name ?? null,
			})),
		};
	}),

	updateSettings: adminProcedure
		.input(apiUpdateComposePolicySettings)
		.mutation(async ({ input, ctx }) => {
			const result = await setComposePolicyAudit(
				ctx.session.activeOrganizationId,
				input.auditEnabled,
				{ userId: ctx.user.id },
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "restricted-compose-audit",
				metadata: { auditEnabled: input.auditEnabled },
			});
			return result;
		}),

	// Takes a compose off the list, also one that was deleted (a stale entry).
	// The list belongs to the organization of the session, so only its own
	// entries can be removed. Adding is the per-service switch on the compose.
	removeExclusion: adminProcedure
		.input(z.object({ composeId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const result = await setComposePolicyExclusion(
				ctx.session.activeOrganizationId,
				input.composeId,
				false,
				{ userId: ctx.user.id },
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "restricted-compose-audit-exclusion",
				metadata: { removed: true, composeId: input.composeId },
			});
			return result;
		}),

	// Findings of the caller's organization, newest first. A compose of another
	// organization is refused; one that was deleted can still be looked at, its
	// findings belong to this organization.
	findings: adminProcedure
		.input(apiListComposePolicyFindings)
		.query(async ({ input, ctx }) => {
			const organizationId = ctx.session.activeOrganizationId;
			if (input.composeId) {
				try {
					const compose = await findComposeById(input.composeId);
					if (compose.environment.project.organizationId !== organizationId) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not allowed to read this compose",
						});
					}
				} catch (error) {
					if (!(error instanceof TRPCError) || error.code !== "NOT_FOUND") {
						throw error;
					}
				}
			}
			return listComposePolicyFindings(organizationId, {
				composeId: input.composeId,
				since: input.since,
				limit: input.limit,
			});
		}),
});
