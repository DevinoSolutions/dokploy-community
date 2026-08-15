import {
	createComposePreview,
	createPreviewDeployment,
	findApplicationById,
	findComposeById,
	findPreviewDeploymentByApplicationId,
	findPreviewDeploymentByComposeId,
	findPreviewDeploymentById,
	findPreviewDeploymentsByApplicationId,
	findPreviewDeploymentsByComposeId,
	IS_CLOUD,
	removePreviewDeployment,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { apiCreatePreviewDeployment } from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// A preview deployment belongs to either an application or a compose service.
// `all` accepts whichever id the caller has; the mutations resolve authz through
// whichever foreign key the row carries.
const apiFindAllPreviewDeployments = z
	.object({
		applicationId: z.string().optional(),
		composeId: z.string().optional(),
	})
	.refine((data) => !!data.applicationId !== !!data.composeId, {
		message: "Exactly one of applicationId or composeId must be provided",
	});

export const previewDeploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllPreviewDeployments)
		.query(async ({ input, ctx }) => {
			if (input.composeId) {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					deployment: ["read"],
				});
				return await findPreviewDeploymentsByComposeId(input.composeId);
			}
			await checkServicePermissionAndAccess(
				ctx,
				input.applicationId as string,
				{
					deployment: ["read"],
				},
			);
			return await findPreviewDeploymentsByApplicationId(
				input.applicationId as string,
			);
		}),

	one: protectedProcedure
		.input(z.object({ previewDeploymentId: z.string() }))
		.query(async ({ input, ctx }) => {
			const previewDeployment = await findPreviewDeploymentById(
				input.previewDeploymentId,
			);
			await checkServicePermissionAndAccess(
				ctx,
				(previewDeployment.composeId ??
					previewDeployment.applicationId) as string,
				{ deployment: ["read"] },
			);
			return previewDeployment;
		}),

	delete: protectedProcedure
		.input(z.object({ previewDeploymentId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const previewDeployment = await findPreviewDeploymentById(
				input.previewDeploymentId,
			);
			await checkServicePermissionAndAccess(
				ctx,
				(previewDeployment.composeId ??
					previewDeployment.applicationId) as string,
				{ deployment: ["cancel"] },
			);
			await removePreviewDeployment(input.previewDeploymentId);
			await audit(ctx, {
				action: "delete",
				resourceType: "previewDeployment",
				resourceId: input.previewDeploymentId,
			});
			return true;
		}),

	create: protectedProcedure
		.input(apiCreatePreviewDeployment)
		.mutation(async ({ input, ctx }) => {
			if (input.composeId) {
				return await createComposePreviewFromApi(ctx, input);
			}
			return await createApplicationPreviewFromApi(ctx, input);
		}),

	redeploy: protectedProcedure
		.input(
			z.object({
				previewDeploymentId: z.string(),
				title: z.string().optional(),
				description: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const previewDeployment = await findPreviewDeploymentById(
				input.previewDeploymentId,
			);

			if (previewDeployment.composeId) {
				await checkServicePermissionAndAccess(
					ctx,
					previewDeployment.composeId,
					{
						deployment: ["create"],
					},
				);
				const compose = await findComposeById(previewDeployment.composeId);
				const jobData: DeploymentJob = {
					composeId: previewDeployment.composeId,
					titleLog: input.title || "Rebuild Preview Deployment",
					descriptionLog: input.description || "",
					type: "redeploy",
					applicationType: "compose-preview",
					previewDeploymentId: input.previewDeploymentId,
					server: !!compose.serverId,
					serverId: compose.serverId ?? undefined,
				};

				if (IS_CLOUD && compose.serverId) {
					deploy(jobData).catch((error) => {
						console.error("Background deployment failed:", error);
					});
					await audit(ctx, {
						action: "redeploy",
						resourceType: "previewDeployment",
						resourceId: input.previewDeploymentId,
					});
					return true;
				}
				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
					},
				);
				await audit(ctx, {
					action: "redeploy",
					resourceType: "previewDeployment",
					resourceId: input.previewDeploymentId,
				});
				return true;
			}

			await checkServicePermissionAndAccess(
				ctx,
				previewDeployment.applicationId as string,
				{ deployment: ["create"] },
			);
			const application = await findApplicationById(
				previewDeployment.applicationId as string,
			);
			const jobData: DeploymentJob = {
				applicationId: previewDeployment.applicationId as string,
				titleLog: input.title || "Rebuild Preview Deployment",
				descriptionLog: input.description || "",
				type: "redeploy",
				applicationType: "application-preview",
				previewDeploymentId: input.previewDeploymentId,
				server: !!application.serverId,
				serverId: application.serverId ?? undefined,
			};

			if (IS_CLOUD && application.serverId) {
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
				await audit(ctx, {
					action: "redeploy",
					resourceType: "previewDeployment",
					resourceId: input.previewDeploymentId,
				});
				return true;
			}
			await myQueue.add(
				"deployments",
				{ ...jobData },
				{
					removeOnComplete: true,
					removeOnFail: true,
				},
			);
			await audit(ctx, {
				action: "redeploy",
				resourceType: "previewDeployment",
				resourceId: input.previewDeploymentId,
			});
			return true;
		}),
});

type CreateCtx = Parameters<typeof checkServicePermissionAndAccess>[0] &
	Parameters<typeof audit>[0];
type CreateInput = z.infer<typeof apiCreatePreviewDeployment>;

const createApplicationPreviewFromApi = async (
	ctx: CreateCtx,
	input: CreateInput,
) => {
	const applicationId = input.applicationId as string;
	await checkServicePermissionAndAccess(ctx, applicationId, {
		deployment: ["create"],
	});
	const application = await findApplicationById(applicationId);

	if (application.sourceType !== "github") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployments can only be created for applications using a GitHub provider",
		});
	}

	if (!application.isPreviewDeploymentsActive) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview deployments are not enabled for this application",
		});
	}

	const existingPreviewDeployment = await findPreviewDeploymentByApplicationId(
		applicationId,
		input.pullRequestId,
	);

	let previewDeploymentId =
		existingPreviewDeployment?.previewDeploymentId || "";

	if (!existingPreviewDeployment) {
		const previewLimit = application.previewLimit || 0;
		if ((application.previewDeployments?.length ?? 0) > previewLimit) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Preview deployments limit reached",
			});
		}
		const previewDeployment = await createPreviewDeployment(input);
		previewDeploymentId = previewDeployment.previewDeploymentId;
	}

	const jobData: DeploymentJob = {
		applicationId,
		titleLog: "Preview Deployment",
		descriptionLog: `Triggered via API for PR #${input.pullRequestNumber}`,
		type: "deploy",
		applicationType: "application-preview",
		previewDeploymentId,
		server: !!application.serverId,
	};

	if (IS_CLOUD && application.serverId) {
		jobData.serverId = application.serverId;
		deploy(jobData).catch((error) => {
			console.error("Background deployment failed:", error);
		});
		await audit(ctx, {
			action: "create",
			resourceType: "previewDeployment",
			resourceId: previewDeploymentId,
		});
		return findPreviewDeploymentById(previewDeploymentId);
	}

	await myQueue.add(
		"deployments",
		{ ...jobData },
		{
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
	await audit(ctx, {
		action: "create",
		resourceType: "previewDeployment",
		resourceId: previewDeploymentId,
	});
	return findPreviewDeploymentById(previewDeploymentId);
};

const createComposePreviewFromApi = async (
	ctx: CreateCtx,
	input: CreateInput,
) => {
	const composeId = input.composeId as string;
	await checkServicePermissionAndAccess(ctx, composeId, {
		deployment: ["create"],
	});
	const compose = await findComposeById(composeId);

	if (compose.sourceType !== "github" && compose.sourceType !== "gitlab") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployments can only be created for compose services using a GitHub or GitLab provider",
		});
	}

	if (!compose.isPreviewDeploymentsActive) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview deployments are not enabled for this compose service",
		});
	}

	const existingPreviewDeployment = await findPreviewDeploymentByComposeId(
		composeId,
		input.pullRequestId,
	);

	let previewDeploymentId =
		existingPreviewDeployment?.previewDeploymentId || "";

	if (!existingPreviewDeployment) {
		const previewLimit = compose.previewLimit || 0;
		const existingPreviews = await findPreviewDeploymentsByComposeId(composeId);
		if (existingPreviews.length > previewLimit) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Preview deployments limit reached",
			});
		}
		const previewDeployment = await createComposePreview(input);
		previewDeploymentId = previewDeployment.previewDeploymentId;
	}

	const jobData: DeploymentJob = {
		composeId,
		titleLog: "Preview Deployment",
		descriptionLog: `Triggered via API for PR #${input.pullRequestNumber}`,
		type: "deploy",
		applicationType: "compose-preview",
		previewDeploymentId,
		server: !!compose.serverId,
	};

	if (IS_CLOUD && compose.serverId) {
		jobData.serverId = compose.serverId;
		deploy(jobData).catch((error) => {
			console.error("Background deployment failed:", error);
		});
		await audit(ctx, {
			action: "create",
			resourceType: "previewDeployment",
			resourceId: previewDeploymentId,
		});
		return findPreviewDeploymentById(previewDeploymentId);
	}

	await myQueue.add(
		"deployments",
		{ ...jobData },
		{
			removeOnComplete: true,
			removeOnFail: true,
		},
	);
	await audit(ctx, {
		action: "create",
		resourceType: "previewDeployment",
		resourceId: previewDeploymentId,
	});
	return findPreviewDeploymentById(previewDeploymentId);
};
