import {
	createSecurity,
	deleteSecurityById,
	findSecurityById,
	updateSecurityById,
} from "@dokploy/server";
import {
	checkServicePermissionAndAccess,
	hasPermission,
} from "@dokploy/server/services/permission";
import { redactBasicAuthEntry } from "@dokploy/server/services/service-secrets";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateSecurity,
	apiFindOneSecurity,
	apiUpdateSecurity,
} from "@/server/db/schema";

export const securityRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateSecurity)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await createSecurity(input);
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceId: input.applicationId,
				resourceName: input.username,
			});
			return true;
		}),

	one: protectedProcedure
		.input(apiFindOneSecurity)
		.query(async ({ input, ctx }) => {
			const security = await findSecurityById(input.securityId);
			await checkServicePermissionAndAccess(ctx, security.applicationId, {
				service: ["read"],
			});
			// The password goes only to a caller who may edit the service: the
			// edit form of the Security tab is the one reader that needs it.
			const canEdit = await hasPermission(ctx, { service: ["create"] });
			return redactBasicAuthEntry(security, { keepPasswords: canEdit });
		}),

	delete: protectedProcedure
		.input(apiFindOneSecurity)
		.mutation(async ({ input, ctx }) => {
			const security = await findSecurityById(input.securityId);
			await checkServicePermissionAndAccess(ctx, security.applicationId, {
				service: ["create"],
			});
			const result = await deleteSecurityById(input.securityId);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceId: input.securityId,
			});
			return result;
		}),

	update: protectedProcedure
		.input(apiUpdateSecurity)
		.mutation(async ({ input, ctx }) => {
			const security = await findSecurityById(input.securityId);
			await checkServicePermissionAndAccess(ctx, security.applicationId, {
				service: ["create"],
			});
			const result = await updateSecurityById(input.securityId, input);
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceId: input.securityId,
			});
			return result;
		}),
});
