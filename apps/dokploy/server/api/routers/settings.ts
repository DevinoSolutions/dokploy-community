import path from "node:path";
import {
	assertRunningTraefikImageKept,
	checkGPUStatus,
	checkPortInUse,
	checkPostgresHealth,
	checkTraefikHealth,
	cleanupAll,
	cleanupBuilders,
	cleanupContainers,
	cleanupImages,
	cleanupSystem,
	cleanupVolumes,
	DEFAULT_UPDATE_DATA,
	findApplicationById,
	findComposeById,
	findServerById,
	getDockerDiskUsage,
	getDokployImageTag,
	getLogCleanupStatus,
	getReleaseNotes,
	getTraefikOverview,
	getUpdateData,
	getWebServerSettings,
	IS_CLOUD,
	isResponseCompressionEnabled,
	isTraefikDashboardPortEnabled,
	parseRawConfig,
	paths,
	prepareEnvironmentVariables,
	pullTraefikImage,
	readConfig,
	readConfigInPath,
	readDirectory,
	readEnvironmentVariableList,
	readEnvironmentVariables,
	readMainConfig,
	readMonitoringConfig,
	readMonitoringStats,
	readPorts,
	recreateDirectory,
	reloadDockerResource,
	runBackgroundJob,
	sendDockerCleanupNotifications,
	setupGPUSupport,
	spawnAsync,
	startLogCleanup,
	stopLogCleanup,
	updateLetsEncryptEmail,
	updateResponseCompression,
	updateServerById,
	updateServerTraefik,
	updateWebServerSettings,
	writeConfig,
	writeMainConfig,
	writeTraefikConfigInPath,
	writeTraefikSetup,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { checkPermission } from "@dokploy/server/services/permission";
import { getAccessibleServerIds } from "@dokploy/server/services/server";
import {
	addWatchdogExclusion,
	removeWatchdogExclusion,
} from "@dokploy/server/services/web-server-settings";
import {
	apiAddDeploymentWatchdogExclusion,
	apiRemoveDeploymentWatchdogExclusion,
	apiUpdateDeploymentWatchdog,
} from "@dokploy/server/utils/deployments/watchdog-config";
import {
	cancelDockerCleanup,
	scheduleDockerCleanup,
	WEB_SERVER_CLEANUP_JOB,
} from "@dokploy/server/utils/docker/cleanup-job";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { auditCancel } from "@/server/api/utils/cancel-audit";
import { assertServerInOrganization } from "@/server/api/utils/server-org-scope";
import {
	apiAssignDomain,
	apiEnableDashboard,
	apiModifyTraefikConfig,
	apiReadStatsLogs,
	apiReadTraefikConfig,
	apiSaveSSHKey,
	apiServerSchema,
	apiTraefikConfig,
	apiUpdateDockerCleanup,
	apiUpdateDomainRestriction,
	apiUpdateWebServerBuildsConcurrency,
	projects,
	server,
} from "@/server/db/schema";
import { cleanAllDeploymentQueue } from "@/server/queues/queueSetup";
import { applyDockerCleanupSchedule } from "@/server/utils/docker-cleanup";
import packageInfo from "../../../package.json";
import { appRouter } from "../root";
import {
	adminProcedure,
	createTRPCRouter,
	enterpriseProcedure,
	protectedProcedure,
	publicProcedure,
	withPermission,
} from "../trpc";

/**
 * Confines a caller-supplied Traefik file path to the Traefik configuration
 * directory (MAIN_TRAEFIK_PATH). The read/write Traefik file endpoints only
 * expose files listed under this directory, but the raw path was passed
 * straight to the filesystem helpers, letting a user with the `traefikFiles`
 * permission read or overwrite arbitrary files on the host (for example
 * `/etc/dokploy/.env` or `~/.ssh/authorized_keys`) via an absolute path or
 * `../` traversal. Reject anything that escapes the directory.
 */
const resolveTraefikFilePath = (
	filePath: string,
	serverId?: string | null,
): string => {
	const { MAIN_TRAEFIK_PATH } = paths(!!serverId);
	// Remote servers are Linux hosts, so their paths use posix semantics no
	// matter which platform this process runs on.
	const pathApi = serverId ? path.posix : path;
	const base = pathApi.resolve(MAIN_TRAEFIK_PATH);
	const resolved = pathApi.resolve(base, filePath);
	if (resolved !== base && !resolved.startsWith(`${base}${pathApi.sep}`)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Invalid path: file must be inside the Traefik configuration directory",
		});
	}
	return resolved;
};

const traefikUpdateLocks = new Map<string, symbol>();
const traefikUpdateErrors = new Map<string, string>();

// Env, ports and the dashboard toggle keep the running Traefik image; refuse
// before queueing when its version tag can't be read.
const assertTraefikImageKept = async (serverId: string | undefined) => {
	try {
		await assertRunningTraefikImageKept(serverId);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
		});
	}
};

// Same server scope as the other Traefik procedures; on Cloud the local
// Traefik belongs to the platform, so a serverId is required.
const assertTraefikAccess = async (
	serverId: string | undefined,
	organizationId: string | null | undefined,
) => {
	await assertServerInOrganization(serverId, organizationId);
	if (!serverId && IS_CLOUD) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};

export const settingsRouter = createTRPCRouter({
	getWebServerSettings: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return null;
		}
		const settings = await getWebServerSettings();
		return settings;
	}),
	reloadServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await reloadDockerResource("dokploy", undefined, packageInfo.version);
		await audit(ctx, {
			action: "reload",
			resourceType: "settings",
			resourceName: "dokploy",
		});
		return true;
	}),
	cleanAllDeploymentQueue: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const removed = await cleanAllDeploymentQueue();
		await auditCancel(ctx, {
			action: "clear_all_queues",
			targetType: "queue",
			targetName: "all",
			// Not scoped to one service or organization: every waiting job of the
			// instance goes.
			metadata: { removed, scope: "instance-wide" },
		});
		await audit(ctx, {
			action: "cancel",
			resourceType: "settings",
			resourceName: "clean-deployment-queue",
		});
		return true;
	}),
	reloadTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			// Run in background so the request returns immediately; avoids proxy timeouts.
			void reloadDockerResource("dokploy-traefik", input?.serverId).catch(
				(err) => {
					console.error("reloadTraefik background:", err);
				},
			);
			await audit(ctx, {
				action: "reload",
				resourceType: "settings",
				resourceName: "dokploy-traefik",
			});
			return true;
		}),
	toggleDashboard: adminProcedure
		.input(apiEnableDashboard)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertTraefikImageKept(input.serverId);
			const ports = await readPorts("dokploy-traefik", input.serverId);
			const env = await readEnvironmentVariables(
				"dokploy-traefik",
				input.serverId,
			);
			const preparedEnv = prepareEnvironmentVariables(env);
			let newPorts = ports;
			// If receive true, add 8080 to ports
			if (input.enableDashboard) {
				// Check if port 8080 is already in use before enabling dashboard
				const portCheck = await checkPortInUse(8080, input.serverId);
				if (portCheck.isInUse) {
					const conflictInfo = portCheck.conflictingContainer
						? ` by ${portCheck.conflictingContainer}`
						: "";
					throw new TRPCError({
						code: "CONFLICT",
						message: `Port 8080 is already in use${conflictInfo}. Please stop the conflicting service or use a different port for the Traefik dashboard.`,
					});
				}
				newPorts.push({
					targetPort: 8080,
					publishedPort: 8080,
					protocol: "tcp",
				});
			} else {
				newPorts = ports.filter((port) => port.targetPort !== 8080);
			}

			// Run in background so the request returns immediately; client polls /api/health.
			// Avoids proxy timeouts (520) while Traefik is recreated.
			void writeTraefikSetup({
				env: preparedEnv,
				additionalPorts: newPorts,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("toggleDashboard background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-dashboard",
			});
			return true;
		}),
	cleanUnusedImages: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			await cleanupImages(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-images",
			});
			return true;
		}),
	cleanUnusedVolumes: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			await cleanupVolumes(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-volumes",
			});
			return true;
		}),
	cleanStoppedContainers: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			await cleanupContainers(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-stopped-containers",
			});
			return true;
		}),
	cleanDockerBuilder: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-builder",
			});
		}),
	cleanDockerPrune: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			await cleanupSystem(input?.serverId);
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-prune",
			});
			return true;
		}),
	cleanAll: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			// Execute cleanup in background and return immediately to avoid gateway timeouts
			void runBackgroundJob(
				"settings.cleanAll background",
				() => cleanupAll(input?.serverId),
				{ serverId: input?.serverId ?? null },
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-all",
			});
			return {
				status: "scheduled",
				message: "Docker cleanup has been initiated in the background",
			};
		}),
	cleanMonitoring: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const { MONITORING_PATH } = paths();
		await recreateDirectory(MONITORING_PATH);
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "clean-monitoring",
		});
		return true;
	}),
	getDockerDiskUsage: withPermission("docker", "read")
		.input(z.object({ serverId: z.string().optional() }).optional())
		.query(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return [];
			}
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			if (input?.serverId) {
				// Owners/admins get every org server; members only the ones granted to them.
				const accessibleIds = await getAccessibleServerIds(ctx.session);
				if (!accessibleIds.has(input.serverId)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not authorized to access this server",
					});
				}
			}
			return getDockerDiskUsage(input?.serverId);
		}),
	saveSSHPrivateKey: adminProcedure
		.input(apiSaveSSHKey)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateWebServerSettings({
				sshPrivateKey: input.sshPrivateKey,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "ssh-private-key",
			});
			return true;
		}),
	assignDomainServer: adminProcedure
		.input(apiAssignDomain)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const settings = await updateWebServerSettings({
				host: input.host,
				letsEncryptEmail: input.letsEncryptEmail,
				certificateType: input.certificateType,
				https: input.https,
			});

			if (!settings) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Web server settings not found",
				});
			}

			updateServerTraefik(settings, input.host);
			if (input.letsEncryptEmail) {
				updateLetsEncryptEmail(input.letsEncryptEmail);
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "assign-domain-server",
			});
			return settings;
		}),
	cleanSSHPrivateKey: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await updateWebServerSettings({
			sshPrivateKey: null,
		});
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "ssh-private-key",
		});
		return true;
	}),
	updateDockerCleanup: adminProcedure
		.input(apiUpdateDockerCleanup)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				// Authorize before writing: the previous order persisted the
				// `enableDockerCleanup` flag on the target server *before*
				// checking that it belongs to the caller's organization.
				await assertServerInOrganization(
					input.serverId,
					ctx.session?.activeOrganizationId,
				);

				await updateServerById(input.serverId, {
					enableDockerCleanup: input.enableDockerCleanup,
					...(input.dockerCleanupCron && {
						dockerCleanupCron: input.dockerCleanupCron,
					}),
				});

				const server = await findServerById(input.serverId);

				if (server.enableDockerCleanup && server.serverStatus === "inactive") {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Server is inactive",
					});
				}
				// Replaces the server's job (or cancels it), so a changed schedule
				// takes effect now and not at the next restart.
				await applyDockerCleanupSchedule(
					server.serverId,
					server.organizationId,
					server.enableDockerCleanup,
					server.dockerCleanupCron,
				);
			} else if (!IS_CLOUD) {
				const settingsUpdated = await updateWebServerSettings({
					enableDockerCleanup: input.enableDockerCleanup,
					...(input.dockerCleanupCron && {
						dockerCleanupCron: input.dockerCleanupCron,
					}),
				});

				if (settingsUpdated?.enableDockerCleanup) {
					const organizationId = ctx.session.activeOrganizationId;
					scheduleDockerCleanup({
						jobName: WEB_SERVER_CLEANUP_JOB,
						hostLabel: "the Dokploy server",
						cron: settingsUpdated.dockerCleanupCron,
						afterCleanup: () => sendDockerCleanupNotifications(organizationId),
					});
				} else {
					cancelDockerCleanup(WEB_SERVER_CLEANUP_JOB);
				}
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "docker-cleanup",
			});
			return true;
		}),

	updateRemoteServersOnly: enterpriseProcedure
		.input(z.object({ remoteServersOnly: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				remoteServersOnly: input.remoteServersOnly,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "remote-servers-only",
			});
			return true;
		}),

	updateBuildsConcurrency: adminProcedure
		.input(apiUpdateWebServerBuildsConcurrency)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				buildsConcurrency: input.buildsConcurrency,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "builds-concurrency",
			});
			return true;
		}),

	// Stuck-deployment watchdog (see queues/deployment-watchdog.ts). Reading the
	// settings is getWebServerSettings, which returns the same row.
	updateDeploymentWatchdog: adminProcedure
		.input(apiUpdateDeploymentWatchdog)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				deploymentWatchdogEnabled: input.enabled,
				deploymentWatchdogIdleMinutes: input.idleMinutes,
				deploymentWatchdogMaxMinutes: input.maxMinutes,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "deployment-watchdog",
			});
			return true;
		}),

	// A service on this list is never failed by the watchdog. The list is
	// instance-wide, so a service of another organization cannot be named.
	addDeploymentWatchdogExclusion: adminProcedure
		.input(apiAddDeploymentWatchdogExclusion)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			const service =
				input.type === "compose"
					? await findComposeById(input.id)
					: await findApplicationById(input.id);
			if (
				service.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to exclude this service",
				});
			}

			// One atomic UPDATE: two edits at once cannot lose an entry.
			await addWatchdogExclusion(input, { keepExisting: false });

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "deployment-watchdog-exclusion",
				metadata: { type: input.type, id: input.id, name: service.name },
			});
			return true;
		}),

	removeDeploymentWatchdogExclusion: adminProcedure
		.input(apiRemoveDeploymentWatchdogExclusion)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			// The list is instance-wide: an admin removes only entries for services
			// of their own organization. An entry whose service is gone is stale and
			// can be removed by anyone who may edit the list.
			try {
				const service =
					input.type === "compose"
						? await findComposeById(input.id)
						: await findApplicationById(input.id);
				if (
					service.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to change this service",
					});
				}
			} catch (error) {
				if (!(error instanceof TRPCError) || error.code !== "NOT_FOUND") {
					throw error;
				}
			}

			await removeWatchdogExclusion(input.type, input.id);

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "deployment-watchdog-exclusion",
				metadata: { removed: true, type: input.type, id: input.id },
			});
			return true;
		}),

	updateEnforceSSO: enterpriseProcedure
		.input(z.object({ enforceSSO: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				enforceSSO: input.enforceSSO,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "enforce-sso",
			});
			return true;
		}),

	readTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readMainConfig();
		return traefikConfig;
	}),

	updateTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeMainConfig(input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-config",
			});
			return true;
		}),

	readWebServerTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("dokploy");
		return traefikConfig;
	}),
	updateWebServerTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("dokploy", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "web-server-traefik-config",
			});
			return true;
		}),

	readMiddlewareTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("middlewares");
		return traefikConfig;
	}),

	updateMiddlewareTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("middlewares", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "middleware-traefik-config",
			});
			return true;
		}),

	haveResponseCompressionEnabled: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return false;
		}
		return isResponseCompressionEnabled();
	}),

	toggleResponseCompression: adminProcedure
		.input(z.object({ enable: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			updateResponseCompression(input.enable);
			// Run in background so the request returns immediately; client polls /api/health.
			// The main Traefik config only reloads on restart.
			void reloadDockerResource("dokploy-traefik").catch((err) => {
				console.error("toggleResponseCompression background reload:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "response-compression",
			});
			return true;
		}),
	getUpdateData: protectedProcedure.mutation(async () => {
		if (IS_CLOUD) {
			return DEFAULT_UPDATE_DATA;
		}

		return await getUpdateData(packageInfo.version);
	}),
	getReleaseNotes: protectedProcedure
		.input(z.object({ version: z.string().min(1) }))
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return { fork: null, upstream: null };
			}

			return await getReleaseNotes(input.version);
		}),
	updateServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}

		const data = await getUpdateData(packageInfo.version);
		if (data.updateAvailable) {
			void runBackgroundJob("settings.updateServer background", () =>
				spawnAsync("docker", [
					"service",
					"update",
					"--force",
					"--image",
					`ghcr.io/devinosolutions/dokploy-community:${data.latestVersion}`,
					"dokploy",
				]),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "dokploy-version",
			});
		}

		return true;
	}),

	getDokployVersion: protectedProcedure.query(() => {
		return packageInfo.version;
	}),
	getReleaseTag: protectedProcedure.query(() => {
		return getDokployImageTag();
	}),
	readDirectories: protectedProcedure
		.input(apiServerSchema)
		.query(async ({ ctx, input }) => {
			try {
				await checkPermission(ctx, { traefikFiles: ["read"] });
				await assertServerInOrganization(
					input?.serverId,
					ctx.session?.activeOrganizationId,
				);
				const { MAIN_TRAEFIK_PATH } = paths(!!input?.serverId);
				const result = await readDirectory(MAIN_TRAEFIK_PATH, input?.serverId);
				return result || [];
			} catch (error) {
				throw error;
			}
		}),

	updateTraefikFile: protectedProcedure
		.input(apiModifyTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			const safePath = resolveTraefikFilePath(input.path, input?.serverId);
			await writeTraefikConfigInPath(
				safePath,
				input.traefikConfig,
				input?.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-file",
			});
			return true;
		}),

	readTraefikFile: protectedProcedure
		.input(apiReadTraefikConfig)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["read"] });
			await assertServerInOrganization(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);

			const safePath = resolveTraefikFilePath(input.path, input.serverId);
			return readConfigInPath(safePath, input.serverId);
		}),
	getIp: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return "";
		}
		const settings = await getWebServerSettings();
		return settings?.serverIp || "";
	}),
	updateServerIp: adminProcedure
		.input(
			z.object({
				serverIp: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const settings = await updateWebServerSettings({
				serverIp: input.serverIp,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "server-ip",
			});
			return settings;
		}),

	getOpenApiDocument: protectedProcedure.query(
		async ({ ctx }): Promise<unknown> => {
			const protocol = ctx.req.headers["x-forwarded-proto"];
			const url = `${protocol}://${ctx.req.headers.host}/api`;
			const openApiDocument = generateOpenApiDocument(appRouter, {
				title: "tRPC OpenAPI",
				version: packageInfo.version,
				baseUrl: url,
				docsUrl: `${url}/settings.getOpenApiDocument`,
				tags: [
					"admin",
					"docker",
					"compose",
					"registry",
					"cluster",
					"user",
					"domain",
					"destination",
					"backup",
					"deployment",
					"mounts",
					"certificates",
					"settings",
					"security",
					"redirects",
					"port",
					"project",
					"application",
					"mysql",
					"postgres",
					"redis",
					"mongo",
					"libsql",
					"mariadb",
					"sshRouter",
					"gitProvider",
					"bitbucket",
					"ai",
					"github",
					"gitlab",
					"gitea",
					"tag",
					"patch",
					"server",
					"volumeBackups",
					"environment",
					"auditLog",
					"customRole",
					"whitelabeling",
					"sso",
					"licenseKey",
					"organization",
					"previewDeployment",
				],
			});

			openApiDocument.info = {
				title: "Dokploy API",
				description: "Endpoints for dokploy",
				version: packageInfo.version,
			};

			// Add security schemes configuration
			openApiDocument.components = {
				...openApiDocument.components,
				securitySchemes: {
					apiKey: {
						type: "apiKey",
						in: "header",
						name: "x-api-key",
						description: "API key authentication",
					},
				},
			};

			// Apply security globally to all endpoints
			openApiDocument.security = [
				{
					apiKey: [],
				},
			];
			return openApiDocument;
		},
	),
	readTraefikEnv: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			const envVars = await readEnvironmentVariables(
				"dokploy-traefik",
				input?.serverId,
			);
			return envVars;
		}),

	writeTraefikEnv: adminProcedure
		.input(z.object({ env: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			await assertTraefikImageKept(input.serverId);
			const envs = prepareEnvironmentVariables(input.env);
			const ports = await readPorts("dokploy-traefik", input?.serverId);

			// Run in background so the request returns immediately; client polls /api/health.
			void writeTraefikSetup({
				env: envs,
				additionalPorts: ports,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("writeTraefikEnv background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-env",
			});
			return true;
		}),
	haveTraefikDashboardPortEnabled: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			return await isTraefikDashboardPortEnabled(input?.serverId);
		}),

	readStatsLogs: protectedProcedure
		.meta({
			openapi: {
				path: "/read-stats-logs",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiReadStatsLogs)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return {
					data: [],
					totalCount: 0,
				};
			}
			const rawConfig = await readMonitoringConfig(
				!!input.dateRange?.start && !!input.dateRange?.end,
				input.dateRange,
			);

			const parsedConfig = parseRawConfig(
				rawConfig as string,
				input.page,
				input.sort,
				input.search,
				input.status,
				input.dateRange,
			);

			return parsedConfig;
		}),
	readStats: adminProcedure
		.meta({
			openapi: {
				path: "/read-stats",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z
				.object({
					dateRange: z
						.object({
							start: z.string().optional(),
							end: z.string().optional(),
						})
						.optional(),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return [];
			}
			return (await readMonitoringStats(input?.dateRange)) || [];
		}),
	haveActivateRequests: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return true;
		}
		const config = readMainConfig();

		if (!config) return false;
		const parsedConfig = parse(config) as {
			accessLog?: {
				filePath: string;
			};
		};

		return !!parsedConfig?.accessLog?.filePath;
	}),
	toggleRequests: protectedProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const mainConfig = readMainConfig();
			if (!mainConfig) return false;

			const currentConfig = parse(mainConfig) as {
				accessLog?: {
					filePath: string;
				};
			};

			if (input.enable) {
				const config = {
					accessLog: {
						filePath: "/etc/dokploy/traefik/dynamic/access.log",
						format: "json",
						bufferingSize: 100,
					},
				};
				currentConfig.accessLog = config.accessLog;
			} else {
				currentConfig.accessLog = undefined;
			}

			writeMainConfig(stringify(currentConfig));
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-requests",
			});
			return true;
		}),
	isCloud: publicProcedure.query(async () => {
		return IS_CLOUD;
	}),
	isUserSubscribed: protectedProcedure.query(async ({ ctx }) => {
		const haveServers = await db.query.server.findMany({
			where: eq(server.organizationId, ctx.session?.activeOrganizationId || ""),
		});
		const haveProjects = await db.query.projects.findMany({
			where: eq(
				projects.organizationId,
				ctx.session?.activeOrganizationId || "",
			),
		});
		return haveServers.length > 0 || haveProjects.length > 0;
	}),
	health: publicProcedure.query(async () => {
		try {
			await db.execute(sql`SELECT 1`);
			return { status: "ok" };
		} catch (error) {
			console.error("Database connection error:", error);
			throw error;
		}
	}),
	checkInfrastructureHealth: adminProcedure.query(async () => {
		if (IS_CLOUD) {
			return {
				postgres: { status: "healthy" as const },
				traefik: { status: "healthy" as const },
			};
		}

		const [postgres, traefik] = await Promise.all([
			checkPostgresHealth(),
			checkTraefikHealth(),
		]);

		return { postgres, traefik };
	}),
	setupGPU: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				throw new Error("Select a server to enable the GPU Setup");
			}
			await assertServerInOrganization(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);

			try {
				await setupGPUSupport(input.serverId);
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "setup-gpu",
				});
				return { success: true };
			} catch (error) {
				console.error("GPU Setup Error:", error);
				throw error;
			}
		}),
	checkGPUStatus: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				return {
					driverInstalled: false,
					driverVersion: undefined,
					gpuModel: undefined,
					runtimeInstalled: false,
					runtimeConfigured: false,
					cudaSupport: undefined,
					cudaVersion: undefined,
					memoryInfo: undefined,
					availableGPUs: 0,
					swarmEnabled: false,
					gpuResources: 0,
				};
			}

			await assertServerInOrganization(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);

			try {
				return await checkGPUStatus(input.serverId || "");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to check GPU status";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	updateTraefikPorts: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				additionalPorts: z.array(
					z.object({
						targetPort: z.number(),
						publishedPort: z.number(),
						protocol: z.enum(["tcp", "udp", "sctp"]),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			// Kept outside the try/catch below, which rewrites every error into a
			// BAD_REQUEST and would mask the authorization failure.
			await assertServerInOrganization(
				input.serverId,
				ctx.session?.activeOrganizationId,
			);

			try {
				if (IS_CLOUD && !input.serverId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "Please set a serverId to update Traefik ports",
					});
				}
				await assertTraefikImageKept(input.serverId);
				const env = await readEnvironmentVariables(
					"dokploy-traefik",
					input?.serverId,
				);

				for (const port of input.additionalPorts) {
					const portCheck = await checkPortInUse(
						port.publishedPort,
						input.serverId,
					);
					if (portCheck.isInUse) {
						throw new TRPCError({
							code: "CONFLICT",
							message: `Port ${port.targetPort} is already in use by ${portCheck.conflictingContainer}`,
						});
					}
				}
				const preparedEnv = prepareEnvironmentVariables(env);

				// Run in background so the request returns immediately; client polls /api/health.
				void writeTraefikSetup({
					env: preparedEnv,
					additionalPorts: input.additionalPorts,
					serverId: input.serverId,
				}).catch((err) => {
					console.error(
						"updateTraefikPorts background writeTraefikSetup:",
						err,
					);
				});
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "traefik-ports",
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error updating Traefik ports",
					cause: error,
				});
			}
		}),
	getTraefikPorts: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertServerInOrganization(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			const ports = await readPorts("dokploy-traefik", input?.serverId);
			return ports;
		}),
	getTraefikOverview: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input, ctx }) => {
			await assertTraefikAccess(
				input?.serverId,
				ctx.session?.activeOrganizationId,
			);
			const key = input?.serverId ?? "local";
			const overview = await getTraefikOverview(input?.serverId);
			return {
				...overview,
				isUpdating: traefikUpdateLocks.has(key),
				lastUpdateError: traefikUpdateErrors.get(key) ?? null,
			};
		}),
	updateTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			const serverId = input?.serverId;
			await assertTraefikAccess(serverId, ctx.session?.activeOrganizationId);

			const lockKey = serverId ?? "local";
			if (traefikUpdateLocks.has(lockKey)) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "A Traefik update is already running on this server",
				});
			}
			const lock = Symbol(lockKey);
			traefikUpdateLocks.set(lockKey, lock);
			traefikUpdateErrors.delete(lockKey);
			// The lock can expire mid-update; never touch a newer update's lock.
			const ownsKey = () => {
				const holder = traefikUpdateLocks.get(lockKey);
				return holder === undefined || holder === lock;
			};
			const release = () => {
				if (traefikUpdateLocks.get(lockKey) === lock) {
					traefikUpdateLocks.delete(lockKey);
				}
			};

			let recreate: Promise<void>;
			try {
				const overview = await getTraefikOverview(serverId);
				if (overview.versionStatus !== "outdated") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Traefik is not older than the recommended version v${overview.recommendedVersion}`,
					});
				}
				// A stopped container reports no published ports, so they would be lost.
				if (overview.state !== "running") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Traefik is not running. Start it with Reload, then update it.",
					});
				}
				// Not re-parsed as dotenv, which would cut values at "#".
				const env = await readEnvironmentVariableList(
					"dokploy-traefik",
					serverId,
				);
				const ports = await readPorts("dokploy-traefik", serverId);

				try {
					await pullTraefikImage(serverId);
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Failed to pull Traefik v${overview.recommendedVersion}: ${error instanceof Error ? error.message : error}`,
						cause: error,
					});
				}

				// The only recreate that may change the version: every other
				// Traefik action keeps the image the host runs.
				recreate = writeTraefikSetup({
					env,
					additionalPorts: ports,
					serverId,
					image: `traefik:v${overview.recommendedVersion}`,
				});
			} catch (error) {
				release();
				throw error;
			}

			// Expires in case a Docker call hangs.
			const lockTimer = setTimeout(release, 5 * 60_000);
			void recreate
				.catch((err) => {
					if (ownsKey()) {
						traefikUpdateErrors.set(
							lockKey,
							err instanceof Error ? err.message : String(err),
						);
					}
					console.error("updateTraefik background recreate:", err);
				})
				.finally(() => {
					clearTimeout(lockTimer);
					release();
				});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-version",
			});
			return true;
		}),
	updateLogCleanup: protectedProcedure
		.input(
			z.object({
				cronExpression: z.string().nullable(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			let result: boolean;
			if (input.cronExpression) {
				result = await startLogCleanup(input.cronExpression);
			} else {
				result = await stopLogCleanup();
			}
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "log-cleanup",
			});
			return result;
		}),

	getLogCleanupStatus: protectedProcedure.query(async () => {
		return getLogCleanupStatus();
	}),

	getDokployCloudIps: adminProcedure.query(async () => {
		if (!IS_CLOUD) {
			return [];
		}
		const ips = process.env.DOKPLOY_CLOUD_IPS?.split(",");
		return ips;
	}),

	getDomainRestrictionConfig: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return { enabled: false, allowedWildcards: [] };
		}
		const settings = await getWebServerSettings();
		return (
			settings?.domainRestrictionConfig ?? {
				enabled: false,
				allowedWildcards: [],
			}
		);
	}),

	updateDomainRestriction: adminProcedure
		.input(apiUpdateDomainRestriction)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateWebServerSettings({
				domainRestrictionConfig: input.domainRestrictionConfig,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "domain-restriction",
			});
			return true;
		}),
});
