import { IS_CLOUD } from "@dokploy/server/constants";
import {
	apiCreateAi,
	apiSaveAiCustomProviders,
	apiUpdateAi,
	deploySuggestionSchema,
} from "@dokploy/server/db/schema/ai";
import {
	createDomain,
	createMount,
	findEnvironmentById,
} from "@dokploy/server/index";
import {
	deleteAiSettings,
	getAiSettingById,
	getAiSettingsByOrganizationId,
	getCustomAiProviders,
	saveAiSettings,
	saveCustomAiProviders,
	suggestVariants,
} from "@dokploy/server/services/ai";
import { createComposeByTemplate } from "@dokploy/server/services/compose";
import {
	addNewService,
	checkServiceAccess,
} from "@dokploy/server/services/permission";
import { findProjectById } from "@dokploy/server/services/project";
import {
	getProviderHeaders,
	getProviderName,
	type Model,
	selectAIProvider,
} from "@dokploy/server/utils/ai/select-ai-provider";
import { TRPCError } from "@trpc/server";
import { generateText } from "ai";
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { assertServerInOrganization } from "@/server/api/utils/server-org-scope";
import { generatePassword } from "@/templates/utils";

/**
 * `getAiSettingById` looks an AI provider up by primary key only, so every
 * procedure that accepts a caller-supplied `aiId` has to prove the row belongs
 * to the caller's active organization before returning it (the row carries the
 * provider `apiKey`) or using its credentials to talk to a model.
 */
const findAiSettingInOrganization = async (
	aiId: string,
	activeOrganizationId: string,
) => {
	const notFound = new TRPCError({
		code: "NOT_FOUND",
		message: "AI settings not found",
	});
	let aiSettings: Awaited<ReturnType<typeof getAiSettingById>>;
	try {
		aiSettings = await getAiSettingById(aiId);
	} catch {
		throw notFound;
	}
	if (aiSettings.organizationId !== activeOrganizationId) {
		throw notFound;
	}
	return aiSettings;
};

export const aiRouter = createTRPCRouter({
	one: adminProcedure
		.input(z.object({ aiId: z.string() }))
		.query(async ({ ctx, input }) => {
			return await findAiSettingInOrganization(
				input.aiId,
				ctx.session.activeOrganizationId,
			);
		}),

	getModels: protectedProcedure
		.input(z.object({ apiUrl: z.string().min(1), apiKey: z.string() }))
		.query(async ({ input }) => {
			try {
				const providerName = getProviderName(input.apiUrl);
				const headers = getProviderHeaders(input.apiUrl, input.apiKey);
				let response = null;
				switch (providerName) {
					case "ollama":
						response = await fetch(`${input.apiUrl}/api/tags`, { headers });
						break;
					case "gemini":
						response = await fetch(
							`${input.apiUrl}/models?key=${encodeURIComponent(input.apiKey)}`,
							{ headers: {} },
						);
						break;
					case "perplexity":
						// Perplexity doesn't have a /models endpoint, return hardcoded list
						return [
							{
								id: "sonar-deep-research",
								object: "model",
								created: Date.now(),
								owned_by: "perplexity",
							},
							{
								id: "sonar-reasoning-pro",
								object: "model",
								created: Date.now(),
								owned_by: "perplexity",
							},
							{
								id: "sonar-reasoning",
								object: "model",
								created: Date.now(),
								owned_by: "perplexity",
							},
							{
								id: "sonar-pro",
								object: "model",
								created: Date.now(),
								owned_by: "perplexity",
							},
							{
								id: "sonar",
								object: "model",
								created: Date.now(),
								owned_by: "perplexity",
							},
						] as Model[];
					case "zai":
						return [
							{
								id: "glm-5",
								object: "model",
								created: Date.now(),
								owned_by: "zai",
							},
							{
								id: "glm-4.7",
								object: "model",
								created: Date.now(),
								owned_by: "zai",
							},
						] as Model[];
					case "minimax":
						return [
							{
								id: "MiniMax-M2.7",
								object: "model",
								created: Date.now(),
								owned_by: "minimax",
							},
						] as Model[];
					default:
						if (!input.apiKey)
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: "API key must contain at least 1 character(s)",
							});
						response = await fetch(`${input.apiUrl}/models`, { headers });
				}

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`Failed to fetch models: ${errorText}`);
				}

				const res = await response.json();

				if (Array.isArray(res)) {
					return res.map((model) => ({
						id: model.id || model.name,
						object: "model",
						created: Date.now(),
						owned_by: "provider",
					}));
				}

				if (res.models) {
					return res.models.map((model: any) => ({
						id: model.id || model.name,
						object: "model",
						created: Date.now(),
						owned_by: "provider",
					})) as Model[];
				}

				if (res.data) {
					return res.data as Model[];
				}

				const possibleModels =
					(Object.values(res).find(Array.isArray) as any[]) || [];
				return possibleModels.map((model) => ({
					id: model.id || model.name,
					object: "model",
					created: Date.now(),
					owned_by: "provider",
				})) as Model[];
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
				});
			}
		}),
	create: adminProcedure.input(apiCreateAi).mutation(async ({ ctx, input }) => {
		return await saveAiSettings(ctx.session.activeOrganizationId, input);
	}),

	update: adminProcedure.input(apiUpdateAi).mutation(async ({ ctx, input }) => {
		// `saveAiSettings` upserts on the `aiId` primary key, so an unscoped
		// `aiId` would let an admin overwrite another organization's provider.
		await findAiSettingInOrganization(
			input.aiId,
			ctx.session.activeOrganizationId,
		);
		return await saveAiSettings(ctx.session.activeOrganizationId, input);
	}),

	getAll: adminProcedure.query(async ({ ctx }) => {
		return await getAiSettingsByOrganizationId(
			ctx.session.activeOrganizationId,
		);
	}),

	get: adminProcedure
		.input(z.object({ aiId: z.string() }))
		.query(async ({ ctx, input }) => {
			return await findAiSettingInOrganization(
				input.aiId,
				ctx.session.activeOrganizationId,
			);
		}),

	delete: adminProcedure
		.input(z.object({ aiId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await findAiSettingInOrganization(
				input.aiId,
				ctx.session.activeOrganizationId,
			);
			return await deleteAiSettings(input.aiId);
		}),

	getCustomProviders: protectedProcedure.query(async ({ ctx }) => {
		return await getCustomAiProviders(ctx.session.activeOrganizationId);
	}),

	saveCustomProviders: adminProcedure
		.input(apiSaveAiCustomProviders)
		.mutation(async ({ ctx, input }) => {
			return await saveCustomAiProviders(
				ctx.session.activeOrganizationId,
				input.providers,
			);
		}),

	getEnabledProviders: protectedProcedure.query(async ({ ctx }) => {
		const settings = await getAiSettingsByOrganizationId(
			ctx.session.activeOrganizationId,
		);
		return settings
			.filter((s) => s.isEnabled)
			.map((s) => ({ aiId: s.aiId, name: s.name, model: s.model }));
	}),

	analyzeLogs: protectedProcedure
		.input(
			z.object({
				aiId: z.string().min(1),
				logs: z.string().min(1),
				context: z.enum(["build", "runtime"]),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Resolved outside the try/catch below, which rewrites every failure
			// to BAD_REQUEST and would otherwise swallow the authorization code.
			const aiSettings = await findAiSettingInOrganization(
				input.aiId,
				ctx.session.activeOrganizationId,
			);
			try {
				if (!aiSettings?.isEnabled) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "AI provider is not enabled",
					});
				}

				const provider = selectAIProvider(aiSettings);
				const model = provider(aiSettings.model);

				const contextLabel =
					input.context === "build" ? "build/deployment" : "runtime/container";

				const result = await generateText({
					model,
					prompt: `You are a DevOps engineer analyzing ${contextLabel} logs. Analyze the following logs and provide:

1. **Summary**: A brief summary of what's happening
2. **Issues Found**: Any errors, warnings, or problems detected
3. **Root Cause**: The most likely root cause if there are errors
4. **Suggested Fix**: Actionable steps to resolve the issues

Be concise and practical. Focus on the most important issues. If the logs look healthy, say so briefly.

Logs:
${input.logs}`,
				});

				return { analysis: result.text };
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: `Analysis failed: ${error}`,
				});
			}
		}),

	testConnection: protectedProcedure
		.input(
			z.object({
				apiUrl: z.string().min(1),
				apiKey: z.string(),
				model: z.string().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				const provider = selectAIProvider({
					apiUrl: input.apiUrl,
					apiKey: input.apiKey,
				});
				const model = provider(input.model);
				const result = await generateText({
					model,
					prompt: "Reply with 'ok'",
				});
				if (!result.text) {
					throw new Error("No response received from the model");
				}
				return { success: true, message: "Connection successful" };
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: `Connection failed: ${error}`,
				});
			}
		}),

	suggest: protectedProcedure
		.input(
			z.object({
				aiId: z.string(),
				input: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Both ids are scoped before the try/catch (which flattens errors to
			// BAD_REQUEST): `suggestVariants` uses the provider credentials behind
			// `aiId` and reads the ip address behind `serverId`.
			await findAiSettingInOrganization(
				input.aiId,
				ctx.session.activeOrganizationId,
			);
			await assertServerInOrganization(
				input.serverId,
				ctx.session.activeOrganizationId,
			);
			try {
				return await suggestVariants({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
				});
			}
		}),
	deploy: protectedProcedure
		.input(deploySuggestionSchema)
		.mutation(async ({ ctx, input }) => {
			const environment = await findEnvironmentById(input.environmentId);
			const project = await findProjectById(environment.projectId);
			// `checkServiceAccess(..., "create")` only consults `accessedProjects`
			// and short-circuits entirely for owner/admin, so the target project
			// and server must be organization-scoped explicitly before anything
			// is created or deployed.
			if (project.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access this project or it does not exist",
				});
			}
			await assertServerInOrganization(
				input.serverId ?? undefined,
				ctx.session.activeOrganizationId,
			);
			await checkServiceAccess(ctx, environment.projectId, "create");

			if (IS_CLOUD && !input.serverId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You need to use a server to create a compose",
				});
			}

			const projectName = slugify(`${project.name} ${input.id}`);

			const compose = await createComposeByTemplate({
				...input,
				composeFile: input.dockerCompose,
				env: input.envVariables,
				serverId: input.serverId,
				name: input.name,
				sourceType: "raw",
				appName: `${projectName}-${generatePassword(6)}`,
				environmentId: input.environmentId,
			});

			if (input.domains && input.domains?.length > 0) {
				for (const domain of input.domains) {
					await createDomain({
						...domain,
						domainType: "compose",
						certificateType: "none",
						composeId: compose.composeId,
					});
				}
			}
			if (input.configFiles && input.configFiles?.length > 0) {
				for (const mount of input.configFiles) {
					await createMount({
						filePath: mount.filePath,
						mountPath: "",
						content: mount.content,
						serviceId: compose.composeId,
						serviceType: "compose",
						type: "file",
					});
				}
			}

			await addNewService(ctx, compose.composeId);

			return null;
		}),
});
