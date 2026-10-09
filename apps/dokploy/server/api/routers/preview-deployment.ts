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
import {
	getPreviewSourceMismatchMessage,
	isValidPreviewIdentifier,
	PREVIEW_IDENTIFIER_GUIDANCE,
	PREVIEW_IMAGE_TEMPLATE_REQUIRED_MESSAGE,
	resolvePreviewDockerImage,
} from "@dokploy/server/utils/preview-image";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	supportsApplicationPreviewDeployments,
	supportsPreviewDeployments,
} from "@/lib/preview-deployments";
import { audit } from "@/server/api/utils/audit";
import {
	type apiCreatePreviewDeployment,
	apiCreatePreviewDeploymentRequest,
} from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import {
	assertPreviewAuthorAllowed,
	resolveVerifiedPreviewAuthor,
} from "@/server/utils/preview-author-gate";
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
		.input(apiCreatePreviewDeploymentRequest)
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
			const sourceMismatch = getPreviewSourceMismatchMessage(
				application.sourceType === "docker",
				previewDeployment.pullRequestId,
			);
			if (sourceMismatch) {
				throw new TRPCError({ code: "BAD_REQUEST", message: sourceMismatch });
			}
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
type CreateInput = z.infer<typeof apiCreatePreviewDeploymentRequest>;
type ChangeRequestInput = z.infer<typeof apiCreatePreviewDeployment>;

/**
 * A pull request preview is built from a change request, so the fields that
 * describe it are mandatory (they are optional in the request only because a
 * Docker-image preview has none).
 */
const requireChangeRequest = (input: CreateInput): ChangeRequestInput => {
	const { branch, pullRequestId, pullRequestURL, pullRequestTitle } = input;
	if (!branch || !pullRequestId || !pullRequestURL || !pullRequestTitle) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"branch, pullRequestId, pullRequestURL and pullRequestTitle are required to preview a pull request",
		});
	}
	return { ...input, branch, pullRequestId, pullRequestURL, pullRequestTitle };
};

/**
 * Describe a Docker-image preview as the preview row the rest of the flow
 * expects. There is no change request and therefore no author: the identifier
 * only picks which image to pull, and the caller already passed the same
 * `deployment: create` permission as a regular deploy. The collaborator gate is
 * deliberately not applied (and the git provider never contacted) because it
 * authorizes the author of code that is *built* on this host; here nothing is
 * built, only the image the owner configured is pulled.
 */
const dockerImagePreviewInput = (
	application: { previewDockerImage: string | null },
	input: CreateInput,
): ChangeRequestInput => {
	const identifier = input.pullRequestNumber.trim();
	if (!isValidPreviewIdentifier(identifier)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: PREVIEW_IDENTIFIER_GUIDANCE,
		});
	}
	let image: string | null;
	try {
		image = resolvePreviewDockerImage(
			application.previewDockerImage,
			identifier,
		);
	} catch (error) {
		// A stored template that no longer passes validation (it predates the
		// rules, or was written around the API) must not be pulled.
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	if (!image) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: PREVIEW_IMAGE_TEMPLATE_REQUIRED_MESSAGE,
		});
	}
	return {
		applicationId: input.applicationId,
		branch: identifier,
		pullRequestId: `docker-${identifier}`,
		pullRequestNumber: identifier,
		pullRequestURL: "",
		pullRequestTitle: image,
	};
};

const createApplicationPreviewFromApi = async (
	ctx: CreateCtx,
	input: CreateInput,
) => {
	const applicationId = input.applicationId as string;
	await checkServicePermissionAndAccess(ctx, applicationId, {
		deployment: ["create"],
	});
	const application = await findApplicationById(applicationId);
	const isDockerImage = application.sourceType === "docker";

	if (!supportsApplicationPreviewDeployments(application.sourceType)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployments can only be created for applications using a GitHub, GitLab or Gitea provider, or a Docker image",
		});
	}

	if (!application.isPreviewDeploymentsActive) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview deployments are not enabled for this application",
		});
	}

	let verifiedInput: ChangeRequestInput;
	if (isDockerImage) {
		verifiedInput = dockerImagePreviewInput(application, input);
	} else {
		// Same collaborator gate the webhook handler applies to the PR author —
		// but the author comes from the provider's pull request list for this
		// number, never from the client (the number selects the code that gets
		// built).
		verifiedInput = await resolveVerifiedPreviewAuthor(
			application,
			requireChangeRequest(input),
		);
		await assertPreviewAuthorAllowed(application, verifiedInput);
	}

	const existingPreviewDeployment = await findPreviewDeploymentByApplicationId(
		applicationId,
		verifiedInput.pullRequestId,
	);

	let previewDeploymentId =
		existingPreviewDeployment?.previewDeploymentId || "";

	if (!existingPreviewDeployment) {
		// Matches the webhook: default 3, and the limit blocks the Nth+1 *new*
		// preview rather than allowing one over.
		const previewLimit = application.previewLimit ?? 3;
		if ((application.previewDeployments?.length ?? 0) >= previewLimit) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Preview deployments limit reached",
			});
		}
		const previewDeployment = await createPreviewDeployment(verifiedInput);
		previewDeploymentId = previewDeployment.previewDeploymentId;
	}

	const jobData: DeploymentJob = {
		applicationId,
		titleLog: "Preview Deployment",
		descriptionLog: isDockerImage
			? `Triggered via API for image preview ${verifiedInput.pullRequestNumber}`
			: `Triggered via API for PR #${input.pullRequestNumber}`,
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

	if (!supportsPreviewDeployments(compose.sourceType)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployments can only be created for compose services using a GitHub, GitLab or Gitea provider",
		});
	}

	if (!compose.isPreviewDeploymentsActive) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Preview deployments are not enabled for this compose service",
		});
	}

	// Same collaborator gate the webhook handler applies to the MR/PR author — the
	// author comes from the provider's pull request list for this number, never
	// from the client.
	const verifiedInput = await resolveVerifiedPreviewAuthor(
		compose,
		requireChangeRequest(input),
	);
	await assertPreviewAuthorAllowed(compose, verifiedInput);

	const existingPreviewDeployment = await findPreviewDeploymentByComposeId(
		composeId,
		verifiedInput.pullRequestId,
	);

	let previewDeploymentId =
		existingPreviewDeployment?.previewDeploymentId || "";

	if (!existingPreviewDeployment) {
		// Matches the webhook: default 3, and the limit blocks the Nth+1 *new*
		// preview rather than allowing one over.
		const previewLimit = compose.previewLimit ?? 3;
		const existingPreviews = await findPreviewDeploymentsByComposeId(composeId);
		if (existingPreviews.length >= previewLimit) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Preview deployments limit reached",
			});
		}
		const previewDeployment = await createComposePreview(verifiedInput);
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
