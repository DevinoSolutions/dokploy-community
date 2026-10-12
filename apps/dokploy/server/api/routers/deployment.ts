import {
	cancelBuildServerDeploymentById,
	cancelScheduleRun,
	claimScheduleRunCancel,
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findAllDeploymentsCentralized,
	findDeploymentById,
	IS_CLOUD,
	isMissingProcessError,
	removeDeployment,
	resolveServicePath,
	revertScheduleRunCancel,
	updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { assertDeploymentAccess } from "@dokploy/server/services/deployment-access";
import {
	resolveDeploymentLogReadHost,
	withDeploymentLogServerId,
} from "@dokploy/server/services/deployment-log-host";
import { findServerById } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	deployments,
	server,
} from "@/server/db/schema";
import { myQueue } from "@/server/queues/queueSetup";
import { fetchDeployApiJobs, type QueueJobRow } from "@/server/utils/deploy";
import { resolveDeploymentAllByTypeAuthTarget } from "@/server/utils/deployment-all-by-type-target";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

// The remote server that runs a deployment, or null for the Dokploy host.
const deploymentHostServerId = (
	deployment: Awaited<ReturnType<typeof findDeploymentById>>,
) =>
	deployment.serverId ||
	deployment.schedule?.serverId ||
	deployment.application?.serverId ||
	deployment.compose?.serverId ||
	null;

export const deploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return await findAllDeploymentsByComposeId(input.composeId);
		}),
	allByServer: withPermission("deployment", "read")
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			const targetServer = await findServerById(input.serverId);
			if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this server.",
				});
			}
			return await findAllDeploymentsByServerId(input.serverId);
		}),
	allCentralized: withPermission("deployment", "read").query(
		async ({ ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;
			if (accessedServices !== null && accessedServices.length === 0) {
				return [];
			}
			return findAllDeploymentsCentralized(orgId, accessedServices);
		},
	),

	queueList: withPermission("deployment", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		let rows: QueueJobRow[];

		if (IS_CLOUD) {
			const servers = await db.query.server.findMany({
				where: eq(server.organizationId, orgId),
				columns: { serverId: true },
			});
			const serverRowsArrays = await Promise.all(
				servers.map(({ serverId }) => fetchDeployApiJobs(serverId)),
			);
			rows = serverRowsArrays.flat();
			rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		} else {
			const jobs = await myQueue.getJobs();
			const jobRows = await Promise.all(
				jobs.map(async (job) => {
					const state = await job.getState();
					return {
						id: String(job.id),
						name: job.name ?? undefined,
						data: job.data as Record<string, unknown>,
						timestamp: job.timestamp,
						processedOn: job.processedOn,
						finishedOn: job.finishedOn,
						failedReason: job.failedReason ?? undefined,
						state,
					};
				}),
			);
			jobRows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
			rows = jobRows;
		}

		return Promise.all(
			rows.map(async (row) => ({
				...row,
				servicePath: await resolveServicePath(
					orgId,
					(row.data ?? {}) as Record<string, unknown>,
				),
			})),
		);
	}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			const target = await resolveDeploymentAllByTypeAuthTarget(input);
			if (target.kind === "service") {
				await checkServicePermissionAndAccess(ctx, target.serviceId, {
					deployment: ["read"],
				});
			} else if (target.kind === "server") {
				await checkPermission(ctx, { deployment: ["read"] });
				const targetServer = await findServerById(target.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message:
							"You are not authorized to access this resource or it does not exist",
					});
				}
			} else if (target.kind === "organization") {
				await checkPermission(ctx, { deployment: ["read"] });
				const member = await findMemberByUserId(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				if (
					(member.role !== "owner" && member.role !== "admin") ||
					target.organizationId !== ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message:
							"You are not authorized to access this resource or it does not exist",
					});
				}
			} else {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access this resource or it does not exist",
				});
			}
			const deploymentsList = await db.query.deployments.findMany({
				where: eq(deployments[`${input.type}Id`], input.id),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: true,
				},
			});
			// The log drawer opens the file on `logServerId` (the build server).
			return withDeploymentLogServerId(deploymentsList);
		}),
	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await assertDeploymentAccess(ctx, deployment, "cancel");

			// A build that runs on a build server has no local pid: it is stopped
			// there, by deployment (see deployment-cancel.ts).
			const remote = await cancelBuildServerDeploymentById(
				deployment.deploymentId,
			);
			if (remote?.status === "cancelled") {
				await audit(ctx, {
					action: "cancel",
					resourceType: "deployment",
					resourceId: deployment.deploymentId,
				});
				return;
			}

			// A pid left on a finished deployment may since belong to another process.
			if (deployment.status !== "running" || !deployment.pid) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			// `pid` is a free text column and ends up in a shell command: only a
			// plain decimal pid >= 2 is accepted (`kill -9 0` signals our own
			// process group and `kill -9 1` signals init).
			if (!/^(?:[2-9]|[1-9]\d+)$/.test(deployment.pid)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment has an invalid process id",
				});
			}

			const killOnHost = async () => {
				const command = `kill -9 ${deployment.pid}`;
				const serverId = deploymentHostServerId(deployment);
				if (serverId) {
					await execAsyncRemote(serverId, command);
				} else if (IS_CLOUD) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Deployment has no server to stop it on",
					});
				} else {
					await execAsync(command);
				}
			};

			const { schedule } = deployment;
			if (schedule) {
				// A cancelled run is not a failed one: it is marked `cancelled` before
				// anything is killed, so the run's own error handling (which fires as
				// soon as the kill lands) leaves it alone and sends no failure alert.
				// This also refuses a run that finished since it was read above.
				if (!(await claimScheduleRunCancel(deployment.deploymentId))) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Deployment is not running",
					});
				}
				try {
					if (
						schedule.scheduleType === "application" ||
						schedule.scheduleType === "compose"
					) {
						// The pid is that of a process inside the service's container,
						// where it may belong to something else by now: stop the run by
						// its tag instead. A container that is gone has nothing left to
						// stop.
						await cancelScheduleRun(schedule.scheduleId, deployment.deploymentId);
					} else {
						try {
							await killOnHost();
						} catch (error) {
							// The process already exited (or its row was orphaned by a
							// restart): there is nothing left to stop, so the run stays
							// cancelled.
							if (!isMissingProcessError(error)) throw error;
						}
					}
				} catch (error) {
					// The run was not stopped: show it as running again so it can be
					// cancelled again, and surface why.
					await revertScheduleRunCancel(deployment.deploymentId).catch(
						(revertError) =>
							console.error(
								`Failed to restore run ${deployment.deploymentId} after a failed cancel:`,
								revertError,
							),
					);
					throw error;
				}
				await audit(ctx, {
					action: "cancel",
					resourceType: "deployment",
					resourceId: deployment.deploymentId,
				});
				return;
			}

			await killOnHost();
			await updateDeploymentStatus(deployment.deploymentId, "error");
			await audit(ctx, {
				action: "cancel",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
		}),

	removeDeployment: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await assertDeploymentAccess(ctx, deployment, "cancel");
			const result = await removeDeployment(input.deploymentId);
			await audit(ctx, {
				action: "delete",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
			return result;
		}),

	readLogs: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
				tail: z.number().int().min(1).max(10000).default(100),
			}),
		)
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await assertDeploymentAccess(ctx, deployment, "read");

			if (!deployment.logPath) {
				return "";
			}

			const command = `tail -n ${input.tail} ${quote([deployment.logPath])} 2>/dev/null || echo ""`;
			// An application built on a build server writes its log there, not on
			// the host that runs it (the log drawer reads it the same way).
			// Preview rows written before the build server was recorded are
			// resolved through their owner.
			const serverId = await resolveDeploymentLogReadHost(
				deployment,
				deploymentHostServerId(deployment),
			);
			if (serverId) {
				// The log drawer's websocket refuses a foreign server; so does this.
				const logServer = await findServerById(serverId);
				if (logServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this server.",
					});
				}
				const { stdout } = await execAsyncRemote(serverId, command);
				return stdout;
			}

			if (IS_CLOUD) {
				return "";
			}

			const { stdout } = await execAsync(command);
			return stdout;
		}),
});
