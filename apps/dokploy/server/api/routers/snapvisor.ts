import {
	createSnapvisor,
	findApplicationSnapvisorTarget,
	findComposeSnapvisorTarget,
	findPreviewDeploymentById,
	findPreviewSnapvisorTarget,
	findSnapvisorByOrganizationId,
	IS_CLOUD,
	isSameSnapvisorBaseUrl,
	listSnapvisorProjects,
	maskSnapvisorAccessToken,
	refreshPreviewBuild as refreshSnapvisorPreviewBuild,
	removeSnapvisor,
	SNAPVISOR_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
	type SnapvisorIntegration,
	setApplicationSnapvisorProject,
	setComposeSnapvisorProject,
	snapvisorBuildReviewUrl,
	testSnapvisorConnection,
	updateSnapvisor,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateSnapvisor,
	apiSetSnapvisorApplicationProject,
	apiSetSnapvisorComposeProject,
	apiSnapvisorPreviewBuild,
	apiTestSnapvisorConnection,
	apiUpdateSnapvisor,
} from "@/server/db/schema";

/**
 * The Snapvisor integration is a self-hosted-only feature (the Settings →
 * Integrations page is hidden on cloud); refuse it server-side too.
 */
const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Functionality not available in cloud version",
		});
	}
};

/** Client-safe view of the integration: the access token is masked, never sent. */
const presentIntegration = (integration: SnapvisorIntegration) => {
	const { accessToken, ...rest } = integration;
	return { ...rest, accessTokenMasked: maskSnapvisorAccessToken(accessToken) };
};

const requireIntegration = async (organizationId: string) => {
	const integration = await findSnapvisorByOrganizationId(organizationId);
	if (!integration) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message:
				"Snapvisor is not connected. An admin can connect it in Settings → Integrations.",
		});
	}
	return integration;
};

/** Converts a thrown client/service error into a tRPC BAD_REQUEST. */
const asBadRequest = (error: unknown, fallback: string): never => {
	if (error instanceof TRPCError) throw error;
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : fallback,
		cause: error,
	});
};

/**
 * Loads the application or compose service behind a preview deployment and
 * proves it belongs to the caller's organization before any Snapvisor call.
 * Shared by the two procedures that take a `previewDeploymentId` instead of a
 * service id.
 */
const requirePreviewService = async (
	ctx: Parameters<typeof checkServicePermissionAndAccess>[0],
	previewDeploymentId: string,
) => {
	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);
	const serviceId =
		previewDeployment.applicationId ?? previewDeployment.composeId;
	if (!serviceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Snapvisor visual testing only supports application and compose previews",
		});
	}
	await checkServicePermissionAndAccess(ctx, serviceId, {
		service: ["read"],
	});
	return previewDeployment;
};

/** The organization check on top of `checkServicePermissionAndAccess`. */
const assertTargetInOrganization = (
	target: { organizationId: string },
	organizationId: string,
	noun: string,
) => {
	if (target.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: `You are not authorized to access this ${noun}`,
		});
	}
};

/**
 * Snapvisor integration (org-scoped).
 *
 * Credential procedures (one/create/update/remove/testConnection/projects)
 * are `adminProcedure`: they read or store the org-wide personal access
 * token. Per-service procedures take an id, so each one first proves the
 * service/preview belongs to the caller's organization and that the caller
 * may access it (`checkServicePermissionAndAccess` →
 * `assertServiceInOrganization`), the same pattern as `uptimelyRouter`.
 */
export const snapvisorRouter = createTRPCRouter({
	one: adminProcedure.query(async ({ ctx }) => {
		assertSelfHosted();
		const integration = await findSnapvisorByOrganizationId(
			ctx.session.activeOrganizationId,
		);
		return integration ? presentIntegration(integration) : null;
	}),

	create: adminProcedure
		.input(apiCreateSnapvisor)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			const created = await createSnapvisor(
				input,
				ctx.session.activeOrganizationId,
			);
			await audit(ctx, {
				action: "create",
				resourceType: "snapvisor",
				resourceId: created.snapvisorId,
				resourceName: created.name,
			});
			return presentIntegration(created);
		}),

	update: adminProcedure
		.input(apiUpdateSnapvisor)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			const updated = await updateSnapvisor(
				ctx.session.activeOrganizationId,
				input,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "snapvisor",
				resourceId: updated.snapvisorId,
				resourceName: updated.name,
			});
			return presentIntegration(updated);
		}),

	remove: adminProcedure.mutation(async ({ ctx }) => {
		assertSelfHosted();
		const removed = await removeSnapvisor(ctx.session.activeOrganizationId);
		if (removed) {
			await audit(ctx, {
				action: "delete",
				resourceType: "snapvisor",
				resourceId: removed.snapvisorId,
				resourceName: removed.name,
			});
		}
		return true;
	}),

	testConnection: adminProcedure
		.input(apiTestSnapvisorConnection)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			// Edit flow: the token field is blank (write-only), so test with the
			// stored token of the caller's own integration.
			let accessToken = input.accessToken;
			if (!accessToken) {
				const integration = await findSnapvisorByOrganizationId(
					ctx.session.activeOrganizationId,
				);
				accessToken = integration?.accessToken;
				// Never replay the stored token against a URL typed into the form.
				if (
					integration &&
					!isSameSnapvisorBaseUrl(input.baseUrl, integration.baseUrl)
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: SNAPVISOR_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
					});
				}
			}
			if (!accessToken) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "An access token is required to test the connection",
				});
			}
			try {
				return await testSnapvisorConnection({
					accessToken,
					baseUrl: input.baseUrl,
				});
			} catch (error) {
				return asBadRequest(error, "Error connecting to Snapvisor");
			}
		}),

	projects: adminProcedure.query(async ({ ctx }) => {
		assertSelfHosted();
		const integration = await requireIntegration(
			ctx.session.activeOrganizationId,
		);
		try {
			return await listSnapvisorProjects(integration);
		} catch (error) {
			return asBadRequest(error, "Error listing Snapvisor projects");
		}
	}),

	setApplicationProject: protectedProcedure
		.input(apiSetSnapvisorApplicationProject)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			// Choosing which Snapvisor project an application posts to is a
			// service-management action, on top of the org + service access check.
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			const target = await findApplicationSnapvisorTarget(input.applicationId);
			assertTargetInOrganization(
				target,
				ctx.session.activeOrganizationId,
				"application",
			);
			const updated = await setApplicationSnapvisorProject(
				input.applicationId,
				input.projectName,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "snapvisor",
				resourceId: input.applicationId,
				resourceName: updated.name,
				metadata: { projectName: input.projectName },
			});
			return { projectName: updated.snapvisorProjectName };
		}),

	setComposeProject: protectedProcedure
		.input(apiSetSnapvisorComposeProject)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			// Same gate as `setApplicationProject`: a service-management action on
			// top of the org + service access check.
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const target = await findComposeSnapvisorTarget(input.composeId);
			assertTargetInOrganization(
				target,
				ctx.session.activeOrganizationId,
				"compose service",
			);
			const updated = await setComposeSnapvisorProject(
				input.composeId,
				input.projectName,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "snapvisor",
				resourceId: input.composeId,
				resourceName: updated.name,
				metadata: { projectName: input.projectName },
			});
			return { projectName: updated.snapvisorProjectName };
		}),

	previewBuild: protectedProcedure
		.input(apiSnapvisorPreviewBuild)
		.query(async ({ input, ctx }) => {
			assertSelfHosted();
			const previewDeployment = await requirePreviewService(
				ctx,
				input.previewDeploymentId,
			);
			const integration = await findSnapvisorByOrganizationId(
				ctx.session.activeOrganizationId,
			);
			if (!integration || !previewDeployment.snapvisorBuildId) {
				return {
					configured: !!integration,
					buildId: previewDeployment.snapvisorBuildId,
					buildStatus: previewDeployment.snapvisorBuildStatus,
					reviewUrl: null as string | null,
				};
			}
			const target = await findPreviewSnapvisorTarget(previewDeployment);
			return {
				configured: true,
				buildId: previewDeployment.snapvisorBuildId,
				buildStatus: previewDeployment.snapvisorBuildStatus,
				reviewUrl: target?.snapvisorProjectName
					? snapvisorBuildReviewUrl(
							integration,
							target.snapvisorProjectName,
							previewDeployment.snapvisorBuildId,
						)
					: null,
			};
		}),

	refreshPreviewBuild: protectedProcedure
		.input(apiSnapvisorPreviewBuild)
		.mutation(async ({ input, ctx }) => {
			assertSelfHosted();
			await requirePreviewService(ctx, input.previewDeploymentId);
			try {
				return await refreshSnapvisorPreviewBuild({
					previewDeploymentId: input.previewDeploymentId,
				});
			} catch (error) {
				return asBadRequest(error, "Error refreshing the Snapvisor build");
			}
		}),
});
