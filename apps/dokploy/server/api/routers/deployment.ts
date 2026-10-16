import {
	cancelBuildServerDeploymentById,
	cancelHostScheduleRun,
	cancelScheduleRun,
	claimScheduleRunCancel,
	decideRunWithoutProcess,
	endScheduleRunWithoutProcess,
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findAllDeploymentsCentralized,
	findApplicationById,
	findComposeById,
	findDeploymentById,
	getScheduleRunLaunch,
	IS_CLOUD,
	isMissingProcessError,
	removeDeployment,
	resolveServicePath,
	revertScheduleRunCancel,
	STRANDED_LOG_LINE,
	updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { assertDeploymentAccess } from "@dokploy/server/services/deployment-access";
import {
	LOG_UNAVAILABLE_MESSAGE,
	locateDeploymentLog,
} from "@dokploy/server/services/deployment-log-host";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { findServerById } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	assertCanPrioritize,
	recordPriorityUse,
} from "@/server/api/utils/deploy-priority";
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

	// Flag a deploy that is already waiting so it goes ahead of the jobs before
	// it (see docs/deploy-queue-priority.md). The id is the one queueList shows.
	prioritizeQueued: protectedProcedure
		.input(z.object({ jobId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			await assertCanPrioritize(ctx);
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Cloud deploys do not wait in a local queue",
				});
			}
			// A missing job and one the caller may not touch answer alike, so the
			// queue (which is shared) cannot be probed for other organizations' jobs.
			const notWaiting = new TRPCError({
				code: "NOT_FOUND",
				message:
					"No waiting deploy with that id. It may have started, finished or been cancelled.",
			});
			const waiting = await myQueue.getJobs(["waiting"]);
			const job = waiting.find(
				(candidate) => String(candidate.id) === input.jobId,
			);
			if (!job) throw notWaiting;
			const data = job.data as { composeId?: string; applicationId?: string };
			const serviceId = data.composeId ?? data.applicationId;
			if (!serviceId) throw notWaiting;
			try {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					deployment: ["create"],
				});
			} catch {
				throw notWaiting;
			}

			const outcome = myQueue.prioritize(job.id, ctx.user.email);
			if (!outcome) throw notWaiting;

			const isCompose = Boolean(data.composeId);
			const service = isCompose
				? await findComposeById(serviceId)
				: await findApplicationById(serviceId);
			const priority = await recordPriorityUse(ctx, {
				resourceType: isCompose ? "compose" : "application",
				resourceId: serviceId,
				resourceName:
					"appName" in service
						? service.appName
						: (service as { name: string }).name,
				via: "prioritizeQueued",
				jobId: job.id,
				outcome,
			});
			return { success: true, jobId: job.id, priority };
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
			return deploymentsList;
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
			if (deployment.status !== "running") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			const { schedule } = deployment;
			// The run of an application or compose schedule is stopped by its tag,
			// not by its pid (see below), so it can be cancelled before the pid is
			// recorded.
			const stoppedByTag =
				schedule?.scheduleType === "application" ||
				schedule?.scheduleType === "compose";

			// A run of a server or dokploy-server schedule whose script never printed
			// its pid is stopped by its tag too: asking for a retry would never end.
			const stoppedByTagWithoutPid =
				Boolean(schedule) && !stoppedByTag && !deployment.pid;
			const stoppedByPid = !stoppedByTag && !stoppedByTagWithoutPid;

			if (stoppedByPid && !deployment.pid) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: schedule
						? "The run is still starting, try again in a moment"
						: "Deployment is not running",
				});
			}

			// `pid` is a free text column and ends up in a shell command: only a
			// plain decimal pid >= 2 is accepted (`kill -9 0` signals our own
			// process group and `kill -9 1` signals init).
			if (stoppedByPid && !/^(?:[2-9]|[1-9]\d+)$/.test(deployment.pid ?? "")) {
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

			if (schedule) {
				// A cancelled run is not a failed one: it is marked `cancelled` before
				// anything is killed, so the run's own error handling (which fires as
				// soon as the kill lands) leaves it alone and sends no failure alert.
				// This also refuses a run that finished since it was read above.
				const claim = await claimScheduleRunCancel(deployment.deploymentId);
				if (!claim) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Deployment is not running",
					});
				}
				let nothingToStop = false;
				let noProcessOutcome: ReturnType<
					typeof decideRunWithoutProcess
				> | null = null;
				try {
					if (
						schedule.scheduleType === "application" ||
						schedule.scheduleType === "compose"
					) {
						// The pid is that of a process inside the service's container,
						// where it may belong to something else by now: stop the run by
						// its tag instead. A container that is gone has nothing left to
						// stop.
						const stopped = await cancelScheduleRun(
							schedule.scheduleId,
							deployment.deploymentId,
						);
						nothingToStop = stopped.containerFound && !stopped.found;
					} else if (stoppedByTagWithoutPid) {
						const stopped = await cancelHostScheduleRun(
							deploymentHostServerId(deployment),
							deployment.deploymentId,
						);
						if (!stopped.found) {
							noProcessOutcome = decideRunWithoutProcess({
								launch: getScheduleRunLaunch(deployment.deploymentId),
								startedAt: deployment.startedAt ?? deployment.createdAt,
							});
						}
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
					// cancelled again, and surface why. A run that has ended on its own
					// since the claim is not brought back: it has nobody left to end it.
					await revertScheduleRunCancel(deployment.deploymentId, claim).catch(
						(revertError) =>
							console.error(
								`Failed to restore run ${deployment.deploymentId} after a failed cancel:`,
								revertError,
							),
					);
					throw error;
				}
				// The container is there but nothing in it carries the run's tag: the
				// command has not started yet, or it is over. A run that is still
				// going gets its claim undone and the user a retry; one that ended
				// meanwhile (its end was noted on the row, so the revert does not
				// apply) is cancelled as far as anyone can tell.
				//
				// A server run with no pid and no tagged process (see
				// decideRunWithoutProcess): not launched yet, the cancel stands and
				// the launch point stops the command; launched moments ago, the claim
				// is undone for a retry; launched long ago or stranded by a restart,
				// nothing is left to stop, so it ends cancelled with a line in its log
				// instead of looping.
				if (noProcessOutcome === "retry") {
					if (await revertScheduleRunCancel(deployment.deploymentId, claim)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "The run is still starting, try again in a moment",
						});
					}
				} else if (
					noProcessOutcome === "gone" ||
					noProcessOutcome === "stranded"
				) {
					await endScheduleRunWithoutProcess(
						deployment.deploymentId,
						deploymentHostServerId(deployment),
						deployment.logPath,
						noProcessOutcome === "stranded" ? STRANDED_LOG_LINE : undefined,
					);
				} else if (
					nothingToStop &&
					(await revertScheduleRunCancel(deployment.deploymentId, claim))
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "The run is still starting, try again in a moment",
					});
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

	// The host the log drawer opens a deployment's log on: the same answer
	// readLogs reads from. Null is this host. `unavailable` is set (to the
	// message to show) when the log is on none of the connected servers.
	logHost: protectedProcedure
		.input(z.object({ deploymentId: z.string().min(1) }))
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			await assertDeploymentAccess(ctx, deployment, "read");
			const { host, missing } = await locateDeploymentLog(
				deployment,
				deploymentHostServerId(deployment),
				ctx.session.activeOrganizationId,
			);
			return {
				serverId: host,
				...(missing ? { unavailable: LOG_UNAVAILABLE_MESSAGE } : {}),
			};
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
			const { host: serverId, missing } = await locateDeploymentLog(
				deployment,
				deploymentHostServerId(deployment),
				ctx.session.activeOrganizationId,
			);
			if (missing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: LOG_UNAVAILABLE_MESSAGE,
				});
			}
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
