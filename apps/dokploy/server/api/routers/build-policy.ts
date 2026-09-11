import {
	addBuildPolicyExclusion,
	assertUnitInOrganization,
	findBuildPolicySettings,
	findRegistryById,
	findRollbackTarget,
	getAccessibleServerIds,
	grantBreakGlass,
	listBuildPolicyAudit,
	listBuildPolicyExclusions,
	recordBuildPolicyAudit,
	removeBuildPolicyExclusion,
	rollbackToDeploymentDigest,
	upsertBuildPolicySettings,
} from "@dokploy/server";
import {
	apiAddBuildPolicyExclusion,
	apiGrantBuildPolicyBreakGlass,
	apiListBuildPolicyAudit,
	apiRemoveBuildPolicyExclusion,
	apiRollbackToBuildPolicyDigest,
	apiUpdateBuildPolicySettings,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { audit } from "../utils/audit";

/**
 * Fork router: organization build policy (enforced remote builds).
 *
 * The organization is taken exclusively from `ctx.session.activeOrganizationId`
 * and never from input, so there is no id a caller could swap to read or write
 * another organization's policy.
 */

/**
 * Exclusions and break-glass decide **where** a unit builds. A compose build is
 * never relocated (`decideBuildPolicy` returns `compose_build_not_relocatable`),
 * so there is nothing to exclude a compose unit from and no local build to
 * grant: `resolveBuildPolicy` is never called on the compose path at all.
 *
 * Both procedures used to accept a `composeId` and write an FK-linked row that
 * nothing would ever read — a grant that stayed pending for ever and an audit
 * entry for a grant that was never spent. Round-2 review finding A: an API
 * affordance that does nothing is worse than no affordance, so it is refused
 * with a message that says why.
 *
 * `requiredChecks` is the one build-policy behaviour compose *does* get; see
 * `build-policy/compose-checks.ts`.
 */
const assertNotComposeUnit = (unitType: string, what: string): void => {
	if (unitType !== "compose") return;
	throw new TRPCError({
		code: "BAD_REQUEST",
		message:
			`${what} does not apply to a compose unit. A compose build is never ` +
			"relocated to the organization build server, so it is never enforced " +
			"and there is nothing to exclude it from. Required checks are the one " +
			"build-policy control that does apply to compose units; set them on " +
			"the unit itself.",
	});
};
export const buildPolicyRouter = createTRPCRouter({
	settings: protectedProcedure.query(async ({ ctx }) =>
		findBuildPolicySettings(ctx.session.activeOrganizationId),
	),

	updateSettings: adminProcedure
		.input(apiUpdateBuildPolicySettings)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;

			if (input.defaultBuildServerId) {
				const accessibleIds = await getAccessibleServerIds(ctx.session);
				if (!accessibleIds.has(input.defaultBuildServerId)) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this build server",
					});
				}
			}

			if (input.defaultRegistryId) {
				const registry = await findRegistryById(input.defaultRegistryId);
				if (registry.organizationId !== organizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this registry",
					});
				}
			}

			const settings = await upsertBuildPolicySettings(organizationId, input);

			await recordBuildPolicyAudit({
				organizationId,
				action: "settings_updated",
				actorId: ctx.user.id,
				actorEmail: ctx.user.email,
				metadata: input as Record<string, unknown>,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "organization",
				resourceId: organizationId,
				resourceName: "build-policy",
				metadata: input as Record<string, unknown>,
			});

			return settings;
		}),

	exclusions: protectedProcedure.query(async ({ ctx }) =>
		listBuildPolicyExclusions(ctx.session.activeOrganizationId),
	),

	addExclusion: adminProcedure
		.input(apiAddBuildPolicyExclusion)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { unitType, unitId } = await assertUnitInOrganization({
				organizationId,
				applicationId: input.applicationId,
				composeId: input.composeId,
			});
			assertNotComposeUnit(unitType, "An exclusion");
			const exclusion = await addBuildPolicyExclusion({
				organizationId,
				applicationId: unitType === "application" ? unitId : null,
				composeId: unitType === "compose" ? unitId : null,
				reason: input.reason,
			});

			await recordBuildPolicyAudit({
				organizationId,
				action: "exclusion_added",
				applicationId: unitType === "application" ? unitId : null,
				composeId: unitType === "compose" ? unitId : null,
				actorId: ctx.user.id,
				actorEmail: ctx.user.email,
				reason: input.reason ?? null,
			});
			await audit(ctx, {
				action: "create",
				resourceType: "organization",
				resourceId: organizationId,
				resourceName: "build-policy-exclusion",
			});

			return exclusion;
		}),

	removeExclusion: adminProcedure
		.input(apiRemoveBuildPolicyExclusion)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const removed = await removeBuildPolicyExclusion({
				organizationId,
				buildPolicyExclusionId: input.buildPolicyExclusionId,
			});
			if (!removed) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Exclusion not found",
				});
			}

			await recordBuildPolicyAudit({
				organizationId,
				action: "exclusion_removed",
				applicationId: removed.applicationId,
				composeId: removed.composeId,
				actorId: ctx.user.id,
				actorEmail: ctx.user.email,
				reason: removed.reason,
			});
			await audit(ctx, {
				action: "delete",
				resourceType: "organization",
				resourceId: organizationId,
				resourceName: "build-policy-exclusion",
			});

			return removed;
		}),

	/** "Build locally once", admin only, spent by the next deploy of the unit. */
	allowLocalBuildOnce: adminProcedure
		.input(apiGrantBuildPolicyBreakGlass)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { unitType, unitId } = await assertUnitInOrganization({
				organizationId,
				applicationId: input.applicationId,
				composeId: input.composeId,
			});
			assertNotComposeUnit(unitType, "A break-glass grant");
			await grantBreakGlass({
				organizationId,
				unitType,
				unitId,
				actorId: ctx.user.id,
				actorEmail: ctx.user.email,
				reason: input.reason,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "organization",
				resourceId: organizationId,
				resourceName: "build-policy-break-glass",
				metadata: { reason: input.reason },
			});
			return { success: true };
		}),

	/**
	 * Rollback by stored digest (spec 5.2.4): redeploy the image a past
	 * deployment published, with no build. Separate from upstream's rollback,
	 * which replays a snapshot pushed to a dedicated rollback registry.
	 */
	rollbackToDigest: adminProcedure
		.input(apiRollbackToBuildPolicyDigest)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const target = await findRollbackTarget(input.deploymentId);
			// The deployment id comes from input, so prove the application it
			// belongs to is this organization's before deploying anything.
			await assertUnitInOrganization({
				organizationId,
				applicationId: target.applicationId,
			});
			const result = await rollbackToDeploymentDigest({
				deploymentId: input.deploymentId,
				organizationId,
			});
			await audit(ctx, {
				action: "restore",
				resourceType: "deployment",
				resourceId: input.deploymentId,
				resourceName: "build-policy-rollback",
			});
			return result;
		}),

	/** Admin only: rows carry registry ids, build server ids and break-glass reasons. */
	audit: adminProcedure
		.input(apiListBuildPolicyAudit)
		.query(async ({ ctx, input }) =>
			listBuildPolicyAudit({
				organizationId: ctx.session.activeOrganizationId,
				limit: input.limit,
				offset: input.offset,
			}),
		),
});
