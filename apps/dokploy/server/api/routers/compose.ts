import { dirname, join } from "node:path";
import {
	addDomainToCompose,
	assertCanUseServiceGitProviders,
	assertComposeBuildSettings,
	assertDeployReferencesInOrganization,
	// build-policy hook: required-checks support check at the API boundary.
	assertRequiredChecksSupportedForUpdate,
	assertServiceReferencesInOrganization,
	cancelBuildServerDeploymentsForService,
	clearOldDeployments,
	cloneBitbucketRepository,
	cloneCompose,
	cloneGiteaRepository,
	cloneGithubRepository,
	cloneGitlabRepository,
	cloneGitRepository,
	createCommand,
	createCompose,
	createComposeByTemplate,
	createDomain,
	createMount,
	deleteMount,
	deprovisionCloudflareForDomains,
	execAsync,
	execAsyncRemote,
	executeTransfer,
	findComposeById,
	findDomainsByComposeId,
	findEnvironmentById,
	findProjectById,
	findServerById,
	getAccessibleServerIds,
	getComposeBuildOverridePath,
	getComposeContainer,
	getContainerLogs,
	getWebServerSettings,
	IS_CLOUD,
	// build-policy hook: narrows a thrown support error to a 400.
	isBuildPolicyError,
	loadServices,
	paths,
	processTemplate,
	randomizeComposeFile,
	randomizeIsolatedDeploymentComposeFile,
	removeCompose,
	removeComposeDirectory,
	removeDeploymentsByComposeId,
	removeDomainById,
	removeUptimelyServiceRows,
	scanServiceForTransfer,
	startCompose,
	stopCompose,
	updateCompose,
	updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	assertComposeRollingSettings,
	getComposeRollingReport,
} from "@dokploy/server/services/compose-rolling";
import { assertComposeFileVolumesBound } from "@dokploy/server/services/compose-volume-binding";
import { canEditDeployGitSource } from "@dokploy/server/services/git-provider";
import {
	addNewService,
	assertEnvironmentInOrganization,
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import {
	listEnvKeys,
	shapeServiceRead,
} from "@dokploy/server/services/service-secrets";
import {
	type CompleteTemplate,
	fetchTemplateFiles,
	fetchTemplateLogo,
	fetchTemplatesList,
} from "@dokploy/server/templates/github";
import { assertSafeComposePath } from "@dokploy/server/utils/compose-path";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import _ from "lodash";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import { parse } from "toml";
import { stringify } from "yaml";
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
	assertSafeTemplateGitUrl,
	buildGuardedTemplateReadCommand,
	getTemplateReadRefusal,
	TEMPLATE_CLONE_ENV,
	TemplateFileRefusedError,
} from "@/server/utils/template-file-read";
import {
	apiCreateCompose,
	apiDeleteCompose,
	apiDeployCompose,
	apiFetchServices,
	apiFindCompose,
	apiRandomizeCompose,
	apiReadCompose,
	apiRedeployCompose,
	apiSaveEnvironmentVariablesCompose,
	apiTransferCompose,
	apiUpdateCompose,
	compose as composeTable,
	environments,
	projects,
} from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	cleanQueuesByCompose,
	keepOldestQueuesByCompose,
	killDockerBuild,
	myQueue,
} from "@/server/queues/queueSetup";
import { applyTemplateToCompose } from "@/server/utils/apply-template";
import { cancelDeployment, deploy } from "@/server/utils/deploy";
import {
	runTransferWithDowntime,
	validateTransferTargetServer,
} from "@/server/utils/transfer";
import { generatePassword } from "@/templates/utils";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { audit } from "../utils/audit";
import { auditCancel } from "../utils/cancel-audit";
import { withComposeFetchLock } from "../utils/compose-fetch-lock";
import {
	readComposePolicyExclusion,
	writeComposePolicyExclusion,
} from "../utils/compose-policy-exclusion";
import {
	assertCanPrioritize,
	recordPriorityUse,
} from "../utils/deploy-priority";
import { cancelRunningDeploymentLocally } from "../utils/local-cancel";
import { coalesceManualComposeDeploy } from "../utils/manual-compose-coalesce";
import { serializeManualDeploy } from "../utils/manual-deploy-lock";
import {
	readServiceWatchdogExclusion,
	writeServiceWatchdogExclusion,
} from "../utils/watchdog-exclusion";

export const composeRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateCompose)
		.mutation(async ({ ctx, input }) => {
			try {
				const environment = await findEnvironmentById(input.environmentId);
				const project = await findProjectById(environment.projectId);

				await checkServiceAccess(ctx, project.projectId, "create");

				const webServerSettings = await getWebServerSettings();
				if (
					(IS_CLOUD || webServerSettings?.remoteServersOnly) &&
					!input.serverId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You need to use a server to create a compose",
					});
				}
				if (project.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this project",
					});
				}

				if (input.serverId) {
					const accessibleIds = await getAccessibleServerIds(ctx.session);
					if (!accessibleIds.has(input.serverId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this server",
						});
					}
				}

				const newService = await createCompose({
					...input,
				});

				await addNewService(ctx, newService.composeId);

				await audit(ctx, {
					action: "create",
					resourceType: "service",
					resourceId: newService.composeId,
					resourceName: newService.appName,
				});
				return newService;
			} catch (error) {
				throw error;
			}
		}),

	one: protectedProcedure
		.input(apiReadCompose)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.composeId, "read");

			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this compose",
				});
			}

			let hasGitProviderAccess = true;
			let unauthorizedProvider: string | null = null;

			const getGitProviderId = () => {
				switch (compose.sourceType) {
					case "github":
						return compose.github?.gitProviderId;
					case "gitlab":
						return compose.gitlab?.gitProviderId;
					case "bitbucket":
						return compose.bitbucket?.gitProviderId;
					case "gitea":
						return compose.gitea?.gitProviderId;
					default:
						return null;
				}
			};

			const gitProviderId = getGitProviderId();

			if (gitProviderId) {
				const canEdit = await canEditDeployGitSource(
					gitProviderId,
					ctx.session,
				);
				if (!canEdit) {
					hasGitProviderAccess = false;
					unauthorizedProvider = compose.sourceType;
				}
			}

			return {
				...shapeServiceRead(compose, input.includeEnv),
				hasGitProviderAccess,
				unauthorizedProvider,
			};
		}),

	envKeys: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.composeId, "read");
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this compose",
				});
			}
			// Names only: the values never leave the server.
			return { env: listEnvKeys(compose.env) };
		}),

	update: protectedProcedure
		.input(apiUpdateCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});

			// Registries, git providers and the SSH key give the build credentials: each
			// one that is set has to be the caller's organization's (T-6895).
			await assertServiceReferencesInOrganization(
				input,
				ctx.session.activeOrganizationId,
			);
			// Being in the organization is not enough: the caller has to be able to use
			// the git provider (own, shared or assigned), as the provider picker implies.
			await assertCanUseServiceGitProviders(
				input,
				() => findComposeById(input.composeId),
				ctx.session,
			);

			// Build server: the caller must be allowed to use the server (same check
			// as applications), and the settings as a whole must be valid. Checked
			// against the merged result, so clearing the registry on its own, or
			// adding a custom command to a build-server compose, is refused too.
			if (
				input.buildServerId !== undefined ||
				input.buildRegistryId !== undefined ||
				input.command !== undefined
			) {
				if (input.buildServerId) {
					const accessibleIds = await getAccessibleServerIds(ctx.session);
					if (!accessibleIds.has(input.buildServerId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this build server",
						});
					}
				}
				const existing = await findComposeById(input.composeId);
				await assertComposeBuildSettings(
					{
						buildServerId:
							input.buildServerId !== undefined
								? input.buildServerId
								: existing.buildServerId,
						buildRegistryId:
							input.buildRegistryId !== undefined
								? input.buildRegistryId
								: existing.buildRegistryId,
						command:
							input.command !== undefined ? input.command : existing.command,
					},
					ctx.session.activeOrganizationId,
				);
			}

			// >>> build-policy hook: refuse a required check this compose unit can
			// never satisfy, here rather than on every deploy. Same rule and the
			// same message as the application path. See finding F in the round-2
			// review and build-policy/source.ts.
			if (input.requiredChecks !== undefined) {
				const current = await findComposeById(input.composeId);
				try {
					assertRequiredChecksSupportedForUpdate(
						{
							unitName: current.name,
							sourceType: current.sourceType,
							githubId: current.githubId,
							owner: current.owner,
							repository: current.repository,
							customGitUrl: current.customGitUrl,
						},
						{ ...input, unitName: current.name },
					);
				} catch (error) {
					if (isBuildPolicyError(error)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: error.message,
						});
					}
					throw error;
				}
			}
			// <<< build-policy hook

			// Rolling replace: every selected service must be able to roll on the
			// compose as it is now (deploys re-check, a save is where the user
			// hears about it).
			if (input.rollingReplace) {
				await assertComposeRollingSettings(
					input.composeId,
					input.rollingReplace,
					{ composeType: input.composeType, command: input.command },
				);
			}

			// A raw compose file that mounts a volume which is not the compose's own
			// is refused at save (T-6822), with the randomize / isolated renames
			// applied; a deploy checks the final file again, which also covers git
			// sources.
			if (input.composeFile) {
				const existing = await findComposeById(input.composeId);
				const effective = { ...existing, ..._.omitBy(input, _.isUndefined) };
				if (effective.sourceType === "raw") {
					try {
						await assertComposeFileVolumesBound(
							effective,
							input.composeFile,
						);
					} catch (error) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}

			// The status is written by deploys only (the schema omits it too).
			const { composeStatus: _composeStatus, ...update } = input as typeof input & {
					composeStatus?: unknown;
				};
			const updated = await updateCompose(input.composeId, update);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: updated?.name,
			});
			return updated;
		}),
	saveEnvironment: protectedProcedure
		.input(apiSaveEnvironmentVariablesCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				envVars: ["write"],
			});
			const updated = await updateCompose(input.composeId, {
				env: input.env,
				createEnvFile: input.createEnvFile,
			});

			if (!updated) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error adding environment variables",
				});
			}

			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: updated?.name,
			});
			return true;
		}),
	delete: protectedProcedure
		.input(apiDeleteCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.composeId, "delete");
			const composeResult = await findComposeById(input.composeId);

			if (
				composeResult.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to delete this compose",
				});
			}

			// Domains are FK-cascade deleted with the compose, so de-provision any
			// Cloudflare publishing BEFORE the row (and its domains) is removed.
			const composeDomains = await findDomainsByComposeId(input.composeId);
			await deprovisionCloudflareForDomains(composeDomains);

			const result = await db
				.delete(composeTable)
				.where(eq(composeTable.composeId, input.composeId))
				.returning();

			await removeUptimelyServiceRows([
				{ serviceType: "compose", serviceId: input.composeId },
			]);

			if (!IS_CLOUD) {
				await cleanQueuesByCompose(input.composeId);
			}

			const cleanupOperations = [
				async () => await removeCompose(composeResult, input.deleteVolumes),
				async () => await removeDeploymentsByComposeId(composeResult),
				async () => await removeComposeDirectory(composeResult.appName),
			];

			for (const operation of cleanupOperations) {
				try {
					await operation();
				} catch (_) {}
			}

			await audit(ctx, {
				action: "delete",
				resourceType: "service",
				resourceId: composeResult.composeId,
				resourceName: composeResult.appName,
			});
			return composeResult;
		}),
	cleanQueues: protectedProcedure
		.input(
			apiFindCompose.extend({
				mode: z
					.enum(["all", "keepOldest"])
					.default("all")
					.describe(
						'"all" (default) removes every waiting job of the compose stack, PR previews included. "keepOldest" keeps the earliest waiting job of each group of duplicates and removes the later ones; only plain deploy and redeploy jobs of the compose stack are considered (never PR previews), deploy and redeploy are separate, and jobs that differ in freshVolumes, pinnedImage or priority are not duplicates. Active jobs are never touched. keepOldest returns { kept, removed }, each a list of { jobId, enqueuedAt, type }.',
					),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["cancel"],
			});
			const compose = await findComposeById(input.composeId);
			// The jobs are already gone once the queue helper returns, so a failing
			// audit must not turn the answer into an error and hide what was removed.
			const auditRemoved = async (
				action: "clean_queue" | "keep_oldest_queue",
				metadata: Record<string, unknown>,
			) => {
				await auditCancel(ctx, {
					action,
					targetType: "compose",
					targetId: compose.composeId,
					targetName: compose.appName,
					composeId: compose.composeId,
					metadata,
				});
				try {
					await audit(ctx, {
						action: "cancel",
						resourceType: "compose",
						resourceId: compose.composeId,
						resourceName: compose.name,
						metadata,
					});
				} catch (error) {
					console.error("cleanQueues audit failed:", error);
				}
			};
			if (input.mode === "keepOldest") {
				const result = await keepOldestQueuesByCompose(input.composeId);
				if (result.removed.length > 0) {
					await auditRemoved("keep_oldest_queue", {
						queue: "keepOldest",
						removedJobIds: result.removed.map((job) => job.jobId),
					});
				}
				return result;
			}
			const removed = await cleanQueuesByCompose(input.composeId);
			if (removed > 0) {
				await auditRemoved("clean_queue", { queue: "all", removed });
			}
			return { success: true, message: "Queues cleaned successfully" };
		}),
	clearDeployments: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			await clearOldDeployments(compose.composeId, "compose");
			await auditCancel(ctx, {
				action: "clear_deployments",
				targetType: "compose",
				targetId: compose.composeId,
				targetName: compose.appName,
				composeId: compose.composeId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.name,
			});
			return true;
		}),
	// "Exclude from the stuck-deployment watchdog": the service owner can opt out
	// of the automatic failing of stuck deployments (see queues/deployment-watchdog.ts).
	watchdogExclusion: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["read"],
			});
			return readServiceWatchdogExclusion({
				type: "compose",
				id: input.composeId,
			});
		}),

	setWatchdogExclusion: protectedProcedure
		.input(
			apiFindCompose.extend({ excluded: z.boolean() }),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			const result = await writeServiceWatchdogExclusion(
				{ type: "compose", id: input.composeId },
				input.excluded,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.appName,
				metadata: { watchdogExcluded: input.excluded },
			});
			return result;
		}),

	// "Exclude from the restricted-compose audit": the service owner can opt out
	// of the read-only audit (see services/compose-policy-audit.ts).
	composePolicyAuditExclusion: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["read"],
			});
			const compose = await findComposeById(input.composeId);
			return readComposePolicyExclusion(
				compose.environment.project.organizationId,
				input.composeId,
			);
		}),

	setComposePolicyAuditExclusion: protectedProcedure
		.input(apiFindCompose.extend({ excluded: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			// Leaving a compose out of the audit is the organization's decision,
			// not the service owner's: owners and admins only (reading is open to
			// whoever can read the service).
			if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Only an organization owner or admin can exclude a compose from the restricted-compose audit",
				});
			}
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			const result = await writeComposePolicyExclusion(
				compose.environment.project.organizationId,
				input.composeId,
				input.excluded,
				{ userId: ctx.user.id },
			);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.appName,
				metadata: { composePolicyAuditExcluded: input.excluded },
			});
			return result;
		}),

	killBuild: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["cancel"],
			});
			const compose = await findComposeById(input.composeId);
			const auditKill = async (deploymentIds: readonly string[]) => {
				// One entry per deployment it stopped, so each cancelled deployment
				// can show who stopped it; the one service-level entry when none was.
				for (const deploymentId of deploymentIds.length
					? deploymentIds
					: [undefined]) {
					await auditCancel(ctx, {
						action: "kill_build",
						targetType: "compose",
						targetId: compose.composeId,
						targetName: compose.appName,
						composeId: compose.composeId,
						deploymentId,
					});
				}
				await audit(ctx, {
					action: "cancel",
					resourceType: "compose",
					resourceId: compose.composeId,
					resourceName: compose.name,
				});
			};
			// A compose that builds on a build server is cancelled there, by
			// deployment (see deployment-cancel.ts). The `pkill "docker compose"`
			// below only ever runs on the serving host, where it would hit every
			// other compose operation running there.
			if (compose.buildServerId) {
				const remote = await cancelBuildServerDeploymentsForService({
					type: "compose",
					composeId: input.composeId,
				});
				await auditKill(remote.deploymentIds);
				return;
			}
			// A rolling replace that is running on the serving host has a cancel
			// launcher of its own: it is signalled by its pid file, so the shield
			// around its `up` steps holds. The `pkill` below matches by command
			// line and would interrupt a recreate half way. It stays the fallback
			// when nothing was stopped (the release step left no pid file, the
			// launcher is missing, the host did not answer).
			const rolling = await cancelBuildServerDeploymentsForService({
				type: "compose",
				composeId: input.composeId,
			});
			if (rolling.stopped === 0) {
				await killDockerBuild("compose", compose.serverId);
			}
			await auditKill(rolling.deploymentIds);
		}),

	// `cache` reads the compose file on disk. `fetch` clones the source over the
	// code dir a deploy reads first, so it needs what a deploy needs and runs
	// under the compose's deploy lock (see compose-fetch-lock.ts).
	loadServices: protectedProcedure
		.input(apiFetchServices)
		.query(async ({ input, ctx }) => {
			if (input.type !== "fetch") {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					service: ["read"],
				});
				return await loadServices(input.composeId, "cache");
			}
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			return await withComposeFetchLock(compose, () =>
				loadServices(input.composeId, "fetch"),
			);
		}),
	rollingEligibility: protectedProcedure
		.input(apiFetchServices)
		.query(async ({ input, ctx }) => {
			if (input.type !== "fetch") {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					service: ["read"],
				});
				return await getComposeRollingReport(input.composeId, {
					type: "cache",
				});
			}
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			return await withComposeFetchLock(compose, () =>
				getComposeRollingReport(input.composeId, { type: "fetch" }),
			);
		}),
	loadMountsByService: protectedProcedure
		.input(
			z.object({
				composeId: z.string().min(1),
				serviceName: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			const container = await getComposeContainer(compose, input.serviceName);
			const mounts = container?.Mounts.filter(
				(mount) => mount.Type === "volume" && mount.Source !== "",
			);
			return mounts;
		}),
	fetchSourceType: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			try {
				// A clone over the code dir, like the Fetch of loadServices.
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					service: ["create"],
					deployment: ["create"],
				});
				const compose = await findComposeById(input.composeId);

				await withComposeFetchLock(compose, async () => {
					const command = await cloneCompose(compose);
					if (compose.serverId) {
						await execAsyncRemote(compose.serverId, command);
					} else {
						await execAsync(command);
					}
				});
				return compose.sourceType;
			} catch (err) {
				if (
					err instanceof TRPCError &&
					(err.code === "FORBIDDEN" ||
						err.code === "UNAUTHORIZED" ||
						err.code === "CONFLICT")
				) {
					throw err;
				}
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error fetching source type",
					cause: err,
				});
			}
		}),

	randomizeCompose: protectedProcedure
		.input(apiRandomizeCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const result = await randomizeComposeFile(input.composeId, input.suffix);
			const compose = await findComposeById(input.composeId);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.name,
			});
			return result;
		}),
	isolatedDeployment: protectedProcedure
		.input(apiRandomizeCompose)
		.mutation(async ({ input, ctx }) => {
			// The preview clones the source over the code dir first, like a Fetch.
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
				deployment: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			const result = await withComposeFetchLock(compose, () =>
				randomizeIsolatedDeploymentComposeFile(input.composeId, input.suffix),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.name,
			});
			return result;
		}),
	getConvertedCompose: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			const domains = await findDomainsByComposeId(input.composeId);
			const composeFile = await addDomainToCompose(compose, domains);
			return stringify(composeFile, {
				lineWidth: 1000,
			});
		}),

	deploy: protectedProcedure
		.input(apiDeployCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			if (input.priority) await assertCanPrioritize(ctx);
			const compose = await findComposeById(input.composeId);

			const jobData: DeploymentJob = {
				composeId: input.composeId,
				titleLog: input.title || "Manual deployment",
				type: "deploy",
				applicationType: "compose",
				descriptionLog: input.description || "",
				server: !!compose.serverId,
				serverId: compose.serverId ?? undefined,
				freshVolumes: input.freshVolumes,
			};

			if (IS_CLOUD && compose.serverId) {
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
				await audit(ctx, {
					action: "deploy",
					resourceType: "compose",
					resourceId: input.composeId,
					resourceName: compose.name,
				});
				if (!input.priority) return true;
				// Cloud runs the deploy straight away: there is no queue to go ahead
				// in, and the caller is told so rather than left to assume.
				return {
					success: true,
					message: "Deployment started",
					composeId: compose.composeId,
					priority: await recordPriorityUse(ctx, {
						resourceType: "compose",
						resourceId: input.composeId,
						resourceName: compose.name,
						via: "deploy",
						outcome: undefined,
					}),
				};
			}
			const addJob = () =>
				myQueue.add(
					"deployments",
					{
						...jobData,
						...(input.priority
							? { priority: true, priorityBy: ctx.user.id }
							: {}),
					},
					{
						removeOnComplete: true,
						removeOnFail: true,
					},
				);
			// A priority request wants to jump the queue, so it is never folded into
			// a waiting job (which would keep that job's place). Everything else
			// coalesces and queues as one step per compose, so a second click cannot
			// slip in between the two and leave a duplicate. A waiting deploy that
			// took this one over means there is nothing to enqueue.
			const queued = input.priority
				? await addJob()
				: await serializeManualDeploy(`compose:${input.composeId}`, async () =>
						(await coalesceManualComposeDeploy(compose, jobData, ctx)).merged
							? undefined
							: addJob(),
					);
			await audit(ctx, {
				action: "deploy",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.name,
			});
			const priority = input.priority
				? await recordPriorityUse(ctx, {
						resourceType: "compose",
						resourceId: input.composeId,
						resourceName: compose.name,
						via: "deploy",
						jobId: queued?.id,
						outcome: queued?.priority,
					})
				: undefined;
			return {
				success: true,
				message: "Deployment queued",
				composeId: compose.composeId,
				...(priority ? { priority } : {}),
			};
		}),
	redeploy: protectedProcedure
		.input(apiRedeployCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			if (input.priority) await assertCanPrioritize(ctx);
			const compose = await findComposeById(input.composeId);
			const jobData: DeploymentJob = {
				composeId: input.composeId,
				titleLog: input.title || "Rebuild deployment",
				type: "redeploy",
				applicationType: "compose",
				descriptionLog: input.description || "",
				server: !!compose.serverId,
				serverId: compose.serverId ?? undefined,
				freshVolumes: input.freshVolumes,
			};
			if (IS_CLOUD && compose.serverId) {
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
				await audit(ctx, {
					action: "deploy",
					resourceType: "compose",
					resourceId: input.composeId,
					resourceName: compose.name,
				});
				if (!input.priority) return true;
				// Cloud runs the deploy straight away: there is no queue to go ahead
				// in, and the caller is told so rather than left to assume.
				return {
					success: true,
					message: "Redeployment started",
					composeId: compose.composeId,
					priority: await recordPriorityUse(ctx, {
						resourceType: "compose",
						resourceId: input.composeId,
						resourceName: compose.name,
						via: "redeploy",
						outcome: undefined,
					}),
				};
			}
			const addJob = () =>
				myQueue.add(
					"deployments",
					{
						...jobData,
						...(input.priority
							? { priority: true, priorityBy: ctx.user.id }
							: {}),
					},
					{
						removeOnComplete: true,
						removeOnFail: true,
					},
				);
			// A priority request wants to jump the queue, so it is never folded into
			// a waiting job (which would keep that job's place). Everything else
			// coalesces and queues as one step per compose, so a second click cannot
			// slip in between the two and leave a duplicate. A waiting deploy that
			// took this one over means there is nothing to enqueue.
			const queued = input.priority
				? await addJob()
				: await serializeManualDeploy(`compose:${input.composeId}`, async () =>
						(await coalesceManualComposeDeploy(compose, jobData, ctx)).merged
							? undefined
							: addJob(),
					);
			await audit(ctx, {
				action: "deploy",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: compose.name,
			});
			const priority = input.priority
				? await recordPriorityUse(ctx, {
						resourceType: "compose",
						resourceId: input.composeId,
						resourceName: compose.name,
						via: "redeploy",
						jobId: queued?.id,
						outcome: queued?.priority,
					})
				: undefined;
			return {
				success: true,
				message: "Redeployment queued",
				composeId: compose.composeId,
				...(priority ? { priority } : {}),
			};
		}),
	stop: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			await stopCompose(input.composeId);
			const composeForStop = await findComposeById(input.composeId);
			await audit(ctx, {
				action: "stop",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: composeForStop.name,
			});
			return true;
		}),
	start: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			await startCompose(input.composeId);
			const composeForStart = await findComposeById(input.composeId);
			await audit(ctx, {
				action: "start",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: composeForStart.name,
			});
			return true;
		}),
	getDefaultCommand: protectedProcedure
		.input(apiFindCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			const { COMPOSE_PATH } = paths(!!compose.serverId);
			const projectPath = join(COMPOSE_PATH, compose.appName, "code");
			const command = createCommand(
				compose,
				compose.mounts.length > 0 ? projectPath : undefined,
				compose.buildServerId
					? { overridePath: getComposeBuildOverridePath(compose) }
					: undefined,
			);
			return `docker ${command}`;
		}),
	refreshToken: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			await updateCompose(input.composeId, {
				refreshToken: nanoid(),
			});
			const composeForToken = await findComposeById(input.composeId);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: composeForToken.name,
			});
			return true;
		}),
	loadTemplateFromGit: protectedProcedure
		.input(z.object({ composeId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this compose",
				});
			}

			// A stored provider or SSH key of another organization must not be used to clone.
			await assertDeployReferencesInOrganization(compose, "source");
			// The template is read next to the compose file.
			assertSafeComposePath(compose.composePath || "./docker-compose.yml");

			const tempAppName = `${compose.appName}-temp-template-${nanoid()}`;

			const entity = {
				...compose,
				appName: tempAppName,
				type: "compose" as const,
			};

			// The clone is of a repository that is not trusted: only remote URLs, and
			// owner-only files (T-8413).
			if (compose.sourceType === "git") {
				try {
					assertSafeTemplateGitUrl(compose.customGitUrl);
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error ? error.message : "Invalid repository URL",
					});
				}
			}

			let command = `set -e;${TEMPLATE_CLONE_ENV}`;
			if (compose.sourceType === "github") {
				command += await cloneGithubRepository(entity);
			} else if (compose.sourceType === "gitlab") {
				command += await cloneGitlabRepository(entity);
			} else if (compose.sourceType === "bitbucket") {
				command += await cloneBitbucketRepository(entity);
			} else if (compose.sourceType === "git") {
				command += await cloneGitRepository(entity);
			} else if (compose.sourceType === "gitea") {
				command += await cloneGiteaRepository(entity);
			}

			const { COMPOSE_PATH } = paths(!!compose.serverId);
			const tempPath = join(COMPOSE_PATH, tempAppName, "code");
			const composeDir = dirname(compose.composePath || "./docker-compose.yml");

			// A file of the repository is read only when it is a regular file reached
			// without a symbolic link (T-8413).
			const readCommand = buildGuardedTemplateReadCommand(
				tempPath,
				join(composeDir, "template.toml"),
			);
			const cleanCommand = quote([
				"rm",
				"-rf",
				join(COMPOSE_PATH, tempAppName),
			]);

			try {
				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, command);
				} else {
					await execAsync(command);
				}

				let templateContent = "";
				try {
					if (compose.serverId) {
						const { stdout } = await execAsyncRemote(
							compose.serverId,
							readCommand,
						);
						templateContent = stdout;
					} else {
						const { stdout } = await execAsync(readCommand);
						templateContent = stdout;
					}
				} catch (e) {
					const refusal = getTemplateReadRefusal(e);
					if (refusal) {
						throw refusal;
					}
					if (compose.serverId) {
						await execAsyncRemote(compose.serverId, cleanCommand);
					} else {
						await execAsync(cleanCommand);
					}
					return null;
				}

				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, cleanCommand);
				} else {
					await execAsync(cleanCommand);
				}

				const config = parse(templateContent) as CompleteTemplate;

				let serverIp = "127.0.0.1";

				if (compose.serverId) {
					const server = await findServerById(compose.serverId);
					serverIp = server.ipAddress;
				} else if (process.env.NODE_ENV === "development") {
					serverIp = "127.0.0.1";
				} else {
					const settings = await getWebServerSettings();
					serverIp = settings?.serverIp || "127.0.0.1";
				}

				const configModified = {
					...config,
					variables: {
						APP_NAME: compose.appName,
						...config.variables,
					},
				};

				const processedTemplate = processTemplate(configModified, {
					serverIp: serverIp,
					projectName: compose.appName,
				});

				await applyTemplateToCompose(compose, processedTemplate);

				return {
					success: true,
					message: "Template loaded and applied successfully",
				};
			} catch (error) {
				try {
					if (compose.serverId) {
						await execAsyncRemote(compose.serverId, cleanCommand);
					} else {
						await execAsync(cleanCommand);
					}
				} catch {}

				if (error instanceof TemplateFileRefusedError) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: error.message,
					});
				}

				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Error loading template from git: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				});
			}
		}),
	deployTemplate: protectedProcedure
		.input(
			z.object({
				environmentId: z.string(),
				serverId: z.string().optional(),
				id: z.string(),
				baseUrl: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const environment = await findEnvironmentById(input.environmentId);

			await checkServiceAccess(ctx, environment.projectId, "create");

			const webServerSettings = await getWebServerSettings();
			if (
				(IS_CLOUD || webServerSettings?.remoteServersOnly) &&
				!input.serverId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You need to use a server to create a compose",
				});
			}

			if (input.serverId) {
				const accessibleIds = await getAccessibleServerIds(ctx.session);
				if (!accessibleIds.has(input.serverId)) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			}

			const [template, templateLogo] = await Promise.all([
				fetchTemplateFiles(input.id, input.baseUrl),
				fetchTemplateLogo(input.id, input.baseUrl),
			]);

			let serverIp = "127.0.0.1";

			const project = await findProjectById(environment.projectId);

			if (input.serverId) {
				const server = await findServerById(input.serverId);
				serverIp = server.ipAddress;
			} else if (process.env.NODE_ENV === "development") {
				serverIp = "127.0.0.1";
			} else {
				const settings = await getWebServerSettings();
				serverIp = settings?.serverIp || "127.0.0.1";
			}

			const projectName = slugify(`${project.name} ${input.id}`);
			const appName = `${projectName}-${generatePassword(6)}`;
			const config = {
				...template.config,
				variables: {
					APP_NAME: appName,
					...template.config.variables,
				},
			};
			const generate = processTemplate(config, {
				serverIp: serverIp,
				projectName: projectName,
			});

			const compose = await createComposeByTemplate({
				...input,
				composeFile: template.dockerCompose,
				env: generate.envs?.join("\n"),
				serverId: input.serverId,
				name: input.id,
				sourceType: "raw",
				appName: appName,
				icon: templateLogo,
			});

			await addNewService(ctx, compose.composeId);

			if (generate.mounts && generate.mounts?.length > 0) {
				for (const mount of generate.mounts) {
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

			if (generate.domains && generate.domains?.length > 0) {
				for (const domain of generate.domains) {
					await createDomain({
						...domain,
						domainType: "compose",
						certificateType: "none",
						composeId: compose.composeId,
						host: domain.host || "",
					});
				}
			}

			await audit(ctx, {
				action: "create",
				resourceType: "compose",
				resourceId: compose.composeId,
				resourceName: compose.name,
			});
			return compose;
		}),

	templates: protectedProcedure
		.input(z.object({ baseUrl: z.string().optional() }))
		.query(async ({ input }) => {
			try {
				const githubTemplates = await fetchTemplatesList(input.baseUrl);

				if (githubTemplates.length > 0) {
					return githubTemplates;
				}
			} catch (error) {
				console.warn(
					"Failed to fetch templates from GitHub, falling back to local templates:",
					error,
				);
			}
			return [];
		}),

	getTags: protectedProcedure
		.input(z.object({ baseUrl: z.string().optional() }))
		.query(async ({ input }) => {
			try {
				const githubTemplates = await fetchTemplatesList(input.baseUrl);
				const allTags = githubTemplates.flatMap((template) => template.tags);
				return _.uniq(allTags);
			} catch (error) {
				console.warn("Failed to fetch template tags:", error);
				return [];
			}
		}),
	disconnectGitProvider: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});

			await updateCompose(input.composeId, {
				repository: null,
				branch: null,
				owner: null,
				composePath: undefined,
				githubId: null,
				triggerType: "push",

				gitlabRepository: null,
				gitlabOwner: null,
				gitlabBranch: null,
				gitlabId: null,
				gitlabProjectId: null,
				gitlabPathNamespace: null,

				bitbucketRepository: null,
				bitbucketOwner: null,
				bitbucketBranch: null,
				bitbucketId: null,

				giteaRepository: null,
				giteaOwner: null,
				giteaBranch: null,
				giteaId: null,

				customGitBranch: null,
				customGitUrl: null,
				customGitSSHKeyId: null,

				sourceType: "github", // Reset to default
				watchPaths: null,
				enableSubmodules: false,
			});

			const composeForDisconnect = await findComposeById(input.composeId);
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: composeForDisconnect.name,
			});
			return true;
		}),

	move: protectedProcedure
		.input(
			z.object({
				composeId: z.string(),
				targetEnvironmentId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				service: ["create"],
			});

			// The target must be an environment of the caller's active organization.
			await assertEnvironmentInOrganization(
				input.targetEnvironmentId,
				ctx.session.activeOrganizationId,
			);

			const updatedCompose = await db
				.update(composeTable)
				.set({
					environmentId: input.targetEnvironmentId,
				})
				.where(eq(composeTable.composeId, input.composeId))
				.returning()
				.then((res) => res[0]);

			if (!updatedCompose) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to move compose",
				});
			}

			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: input.composeId,
				resourceName: updatedCompose.name,
			});
			return updatedCompose;
		}),

	processTemplate: protectedProcedure
		.input(
			z.object({
				base64: z.string(),
				composeId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					service: ["create"],
				});
				const compose = await findComposeById(input.composeId);

				const decodedData = Buffer.from(input.base64, "base64").toString(
					"utf-8",
				);
				let serverIp = "127.0.0.1";

				if (compose.serverId) {
					const server = await findServerById(compose.serverId);
					serverIp = server.ipAddress;
				} else if (process.env.NODE_ENV === "development") {
					serverIp = "127.0.0.1";
				} else {
					const settings = await getWebServerSettings();
					serverIp = settings?.serverIp || "127.0.0.1";
				}
				const templateData = JSON.parse(decodedData);
				const config = parse(templateData.config) as CompleteTemplate;

				if (!templateData.compose || !config) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Invalid template format. Must contain compose and config fields",
					});
				}

				const configModified = {
					...config,
					variables: {
						APP_NAME: compose.appName,
						...config.variables,
					},
				};

				const processedTemplate = processTemplate(configModified, {
					serverIp: serverIp,
					projectName: compose.appName,
				});

				return {
					compose: templateData.compose,
					template: processedTemplate,
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Error processing template: ${
						error instanceof Error ? error.message : error
					}`,
				});
			}
		}),

	previewTemplate: protectedProcedure
		.input(
			z.object({
				base64: z.string(),
				appName: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				if (input.serverId) {
					const accessibleIds = await getAccessibleServerIds(ctx.session);
					if (!accessibleIds.has(input.serverId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this server",
						});
					}
				}

				const decodedData = Buffer.from(input.base64, "base64").toString(
					"utf-8",
				);

				let serverIp = "127.0.0.1";

				if (input.serverId) {
					const server = await findServerById(input.serverId);
					serverIp = server.ipAddress;
				} else if (process.env.NODE_ENV !== "development") {
					const settings = await getWebServerSettings();
					serverIp = settings?.serverIp || "127.0.0.1";
				}

				const templateData = JSON.parse(decodedData);
				const config = parse(templateData.config) as CompleteTemplate;

				if (!templateData.compose || !config) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Invalid template format. Must contain compose and config fields",
					});
				}

				const configModified = {
					...config,
					variables: {
						APP_NAME: input.appName,
						...config.variables,
					},
				};

				const processedTemplate = processTemplate(configModified, {
					serverIp,
					projectName: input.appName,
				});

				return {
					compose: templateData.compose,
					template: processedTemplate,
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Error processing template: ${error instanceof Error ? error.message : error}`,
				});
			}
		}),

	import: protectedProcedure
		.input(
			z.object({
				base64: z.string(),
				composeId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					service: ["create"],
				});
				const compose = await findComposeById(input.composeId);
				const decodedData = Buffer.from(input.base64, "base64").toString(
					"utf-8",
				);

				for (const mount of compose.mounts) {
					await deleteMount(mount.mountId);
				}

				// Tear down Cloudflare publishing before the domain rows are deleted,
				// otherwise the stored tunnel/DNS/ingress state is orphaned.
				await deprovisionCloudflareForDomains(compose.domains);
				for (const domain of compose.domains) {
					await removeDomainById(domain.domainId);
				}

				let serverIp = "127.0.0.1";

				if (compose.serverId) {
					const server = await findServerById(compose.serverId);
					serverIp = server.ipAddress;
				} else if (process.env.NODE_ENV === "development") {
					serverIp = "127.0.0.1";
				} else {
					const settings = await getWebServerSettings();
					serverIp = settings?.serverIp || "127.0.0.1";
				}

				const templateData = JSON.parse(decodedData);

				const config = parse(templateData.config) as CompleteTemplate;

				if (!templateData.compose || !config) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Invalid template format. Must contain compose and config fields",
					});
				}

				const configModified = {
					...config,
					variables: {
						APP_NAME: compose.appName,
						...config.variables,
					},
				};

				const processedTemplate = processTemplate(configModified, {
					serverIp: serverIp,
					projectName: compose.appName,
				});
				// `applyTemplateToCompose` already persists `template.envs` as the
				// compose env, so no `env` option is needed here.
				await applyTemplateToCompose(compose, processedTemplate, {
					composeFile: templateData.compose,
					sourceType: "raw",
				});

				if (processedTemplate.mounts && processedTemplate.mounts.length > 0) {
					for (const mount of processedTemplate.mounts) {
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

				if (processedTemplate.domains && processedTemplate.domains.length > 0) {
					for (const domain of processedTemplate.domains) {
						await createDomain({
							...domain,
							domainType: "compose",
							certificateType: "none",
							composeId: compose.composeId,
							host: domain.host || "",
						});
					}
				}

				await audit(ctx, {
					action: "update",
					resourceType: "compose",
					resourceId: input.composeId,
					resourceName: compose.appName,
				});
				return {
					success: true,
					message: "Template imported successfully",
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Error importing template: ${
						error instanceof Error ? error.message : error
					}`,
				});
			}
		}),

	cancelDeployment: protectedProcedure
		.input(apiFindCompose)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["cancel"],
			});
			const compose = await findComposeById(input.composeId);

			if (IS_CLOUD && compose.serverId) {
				try {
					await updateCompose(input.composeId, {
						composeStatus: "idle",
					});

					if (compose.deployments[0]) {
						await updateDeploymentStatus(
							compose.deployments[0].deploymentId,
							"done",
						);
					}

					await cancelDeployment({
						composeId: input.composeId,
						applicationType: "compose",
					});

					await auditCancel(ctx, {
						action: "cancel_deployment",
						targetType: "compose",
						targetId: compose.composeId,
						targetName: compose.appName,
						composeId: compose.composeId,
					});
					await audit(ctx, {
						action: "cancel",
						resourceType: "compose",
						resourceId: input.composeId,
						resourceName: compose.name,
					});
					return {
						success: true,
						message: "Deployment cancellation requested",
					};
				} catch (error) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to cancel deployment",
					});
				}
			}

			// Self-hosted: stop the running deployment on its host and let the job
			// free its queue slot (see cancel-active-deployment.ts).
			if (!IS_CLOUD) {
				return cancelRunningDeploymentLocally(ctx, {
					type: "compose",
					composeId: compose.composeId,
					appName: compose.appName,
					name: compose.name,
				});
			}

			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "This service has no server to cancel its deployment on",
			});
		}),

	search: protectedProcedure
		.input(
			z.object({
				q: z.string().optional(),
				name: z.string().optional(),
				appName: z.string().optional(),
				description: z.string().optional(),
				projectId: z.string().optional(),
				environmentId: z.string().optional(),
				limit: z.number().min(1).max(100).default(20),
				offset: z.number().min(0).default(0),
			}),
		)
		.query(async ({ ctx, input }) => {
			const baseConditions = [
				eq(projects.organizationId, ctx.session.activeOrganizationId),
			];

			if (input.projectId) {
				baseConditions.push(eq(environments.projectId, input.projectId));
			}
			if (input.environmentId) {
				baseConditions.push(
					eq(composeTable.environmentId, input.environmentId),
				);
			}

			if (input.q?.trim()) {
				const term = `%${input.q.trim()}%`;
				baseConditions.push(
					or(
						ilike(composeTable.name, term),
						ilike(composeTable.appName, term),
						ilike(composeTable.description ?? "", term),
					)!,
				);
			}

			if (input.name?.trim()) {
				baseConditions.push(ilike(composeTable.name, `%${input.name.trim()}%`));
			}
			if (input.appName?.trim()) {
				baseConditions.push(
					ilike(composeTable.appName, `%${input.appName.trim()}%`),
				);
			}
			if (input.description?.trim()) {
				baseConditions.push(
					ilike(
						composeTable.description ?? "",
						`%${input.description.trim()}%`,
					),
				);
			}

			const { accessedServices } = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);
			if (accessedServices.length === 0) return { items: [], total: 0 };
			baseConditions.push(
				sql`${composeTable.composeId} IN (${sql.join(
					accessedServices.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			);

			const where = and(...baseConditions);

			const [items, countResult] = await Promise.all([
				db
					.select({
						composeId: composeTable.composeId,
						name: composeTable.name,
						appName: composeTable.appName,
						description: composeTable.description,
						environmentId: composeTable.environmentId,
						composeStatus: composeTable.composeStatus,
						sourceType: composeTable.sourceType,
						createdAt: composeTable.createdAt,
					})
					.from(composeTable)
					.innerJoin(
						environments,
						eq(composeTable.environmentId, environments.environmentId),
					)
					.innerJoin(projects, eq(environments.projectId, projects.projectId))
					.where(where)
					.orderBy(desc(composeTable.createdAt))
					.limit(input.limit)
					.offset(input.offset),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(composeTable)
					.innerJoin(
						environments,
						eq(composeTable.environmentId, environments.environmentId),
					)
					.innerJoin(projects, eq(environments.projectId, projects.projectId))
					.where(where),
			]);

			return {
				items,
				total: countResult[0]?.count ?? 0,
			};
		}),

	readLogs: protectedProcedure
		.input(
			apiFindCompose.extend({
				containerId: z
					.string()
					.min(1)
					.regex(/^[a-zA-Z0-9.\-_]+$/, "Invalid container id."),
				tail: z.number().int().min(1).max(10000).default(100),
				since: z
					.string()
					.regex(/^(all|\d+[smhd])$/, "Invalid since format")
					.default("all"),
				search: z
					.string()
					.regex(/^[a-zA-Z0-9 ._-]{0,500}$/)
					.optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.composeId, "read");
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this compose",
				});
			}
			return await getContainerLogs(
				input.containerId,
				input.tail,
				input.since,
				input.search,
				compose.serverId,
				true,
			);
		}),

	// Scan compose for transfer — pre-flight check
	transferScan: protectedProcedure
		.input(apiTransferCompose)
		.mutation(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);

			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to transfer this compose",
				});
			}

			await checkServiceAccess(ctx, input.composeId, "delete");

			const targetServerId = await validateTransferTargetServer({
				targetServerId: input.targetServerId,
				sourceServerId: compose.serverId,
				organizationId: ctx.session.activeOrganizationId,
			});

			return scanServiceForTransfer({
				serviceId: input.composeId,
				serviceType: "compose",
				appName: compose.appName,
				sourceServerId: compose.serverId,
				targetServerId,
			});
		}),

	transferScanWithLogs: protectedProcedure
		.meta({
			openapi: {
				enabled: false,
				method: "POST",
				path: "/compose.transferScanWithLogs",
			},
		})
		.input(apiTransferCompose)
		.subscription(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);

			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to transfer this compose",
				});
			}

			await checkServiceAccess(ctx, input.composeId, "delete");

			const targetServerId = await validateTransferTargetServer({
				targetServerId: input.targetServerId,
				sourceServerId: compose.serverId,
				organizationId: ctx.session.activeOrganizationId,
			});

			return observable<string>((emit) => {
				scanServiceForTransfer(
					{
						serviceId: input.composeId,
						serviceType: "compose",
						appName: compose.appName,
						sourceServerId: compose.serverId,
						targetServerId,
					},
					(progress) => {
						emit.next(
							JSON.stringify({
								type: "scan_progress",
								payload: progress,
							}),
						);
					},
				)
					.then((result) => {
						emit.next(
							JSON.stringify({
								type: "scan_complete",
								payload: result,
							}),
						);
						emit.complete();
					})
					.catch((error) => {
						const message =
							error instanceof Error ? error.message : "Unknown scan error";
						emit.next(
							JSON.stringify({
								type: "scan_error",
								payload: { message },
							}),
						);
						emit.complete();
					});
			});
		}),

	// Transfer compose to a different server (node)
	transfer: protectedProcedure
		.input(
			apiTransferCompose.extend({
				decisions: z
					.record(z.string(), z.enum(["skip", "overwrite"]))
					.optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);

			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to transfer this compose",
				});
			}

			await checkServiceAccess(ctx, input.composeId, "delete");

			const targetServerId = await validateTransferTargetServer({
				targetServerId: input.targetServerId,
				sourceServerId: compose.serverId,
				organizationId: ctx.session.activeOrganizationId,
			});

			const result = await runTransferWithDowntime({
				stopSource: async () => {
					await stopCompose(input.composeId);
				},
				startSource: async () => {
					await startCompose(input.composeId);
				},
				executeTransfer: async () =>
					executeTransfer(
						{
							serviceId: input.composeId,
							serviceType: "compose",
							appName: compose.appName,
							sourceServerId: compose.serverId,
							targetServerId,
						},
						input.decisions || {},
						(_progress) => {},
					),
				commitTransfer: async () => {
					await db
						.update(composeTable)
						.set({ serverId: targetServerId })
						.where(eq(composeTable.composeId, input.composeId));
				},
			});

			if (!result.success) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Transfer failed: ${result.errors.join(", ")}`,
				});
			}

			return { success: true };
		}),

	transferWithLogs: protectedProcedure
		.meta({
			openapi: {
				enabled: false,
				method: "POST",
				path: "/compose.transferWithLogs",
			},
		})
		.input(
			apiTransferCompose.extend({
				decisions: z
					.record(z.string(), z.enum(["skip", "overwrite"]))
					.optional(),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);

			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to transfer this compose",
				});
			}

			await checkServiceAccess(ctx, input.composeId, "delete");

			const targetServerId = await validateTransferTargetServer({
				targetServerId: input.targetServerId,
				sourceServerId: compose.serverId,
				organizationId: ctx.session.activeOrganizationId,
			});

			return observable<string>((emit) => {
				runTransferWithDowntime({
					stopSource: async () => {
						await stopCompose(input.composeId);
					},
					startSource: async () => {
						await startCompose(input.composeId);
					},
					executeTransfer: async () =>
						executeTransfer(
							{
								serviceId: input.composeId,
								serviceType: "compose",
								appName: compose.appName,
								sourceServerId: compose.serverId,
								targetServerId,
							},
							input.decisions || {},
							(progress) => {
								emit.next(JSON.stringify(progress));
							},
						),
					commitTransfer: async () => {
						await db
							.update(composeTable)
							.set({ serverId: targetServerId })
							.where(eq(composeTable.composeId, input.composeId));
					},
				})
					.then((result) => {
						if (result.success) {
							emit.next("Transfer completed successfully!");
						} else {
							const errorMessage = result.errors.join(", ") || "Unknown error";
							emit.next(`Transfer failed: ${errorMessage}`);
						}
						emit.complete();
					})
					.catch((error) => {
						const message =
							error instanceof Error ? error.message : "Unknown transfer error";
						emit.next(`Transfer failed: ${message}`);
						emit.complete();
					});
			});
		}),
});
