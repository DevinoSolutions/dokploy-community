import {
	canUseGithubConnection,
	deleteGithubWatch,
	findApplicationById,
	findComposeById,
	findGithubConnectionInOrganization,
	findGithubWatch,
	IS_CLOUD,
	loadConnectionToken,
	removeGhcrWatchConfigDirs,
	upsertGithubWatch,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { applications, registry } from "@dokploy/server/db/schema";
import {
	applyConnectionEvent,
	type ConnectPlan,
	type ConnectReads,
	type ConnectServiceError,
	type ConnectServiceInput,
	connectGhaService,
	createGhaConnection,
	deleteGhaConnection,
	findGhaConnection,
	findGatedRelease,
	gateChangeWeakens,
	getBranchHead,
	getEnvironmentPolicy,
	getRepositoryByName,
	listReleases,
	overrideGate,
	presentGhaConnection,
	type ServiceFacts,
	serviceRowExists,
	touchConnectionActivity,
	updateGateSettings,
} from "@dokploy/server/services/gha-connect";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiGhaCheckNow,
	apiGhaConnectInput,
	apiGhaConnectionOne,
	apiGhaDeployAnyway,
	apiGhaDisconnect,
	apiGhaUpdate,
} from "@/server/db/schema";

/**
 * "Build on GitHub Actions", connected natively (T-13719). The GitHub token is
 * never returned by any procedure here, nor the saved source settings or the
 * list of handled runs. See docs/superpowers/specs/2026-11-03-gha-native-connect-design.md.
 */

const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Functionality not available in cloud version",
		});
	}
};

const apiDeps = {
	fetch: (url: string, init?: Parameters<typeof fetch>[1]) =>
		fetch(url, init as RequestInit),
	now: () => Date.now(),
};

const githubReads = (
	token: string,
	owner: string,
	repo: string,
): ConnectReads => ({
	repository: () => getRepositoryByName(apiDeps, token, { owner, repo }),
	branchHead: (branch) =>
		getBranchHead(apiDeps, token, { owner, repo }, branch),
	environmentPolicy: (environment) =>
		getEnvironmentPolicy(apiDeps, token, { owner, repo }, environment),
});

const loadServiceFacts = async (
	type: "application" | "compose",
	id: string,
	organizationId: string,
): Promise<ServiceFacts | null> => {
	if (type === "application") {
		const app = await findApplicationById(id).catch(() => null);
		if (!app || app.environment.project.organizationId !== organizationId) {
			return null;
		}
		return {
			kind: "application",
			sourceType: app.sourceType,
			owner: app.owner,
			repository: app.repository,
			fields: app as unknown as Record<string, unknown>,
		};
	}
	const stack = await findComposeById(id).catch(() => null);
	if (!stack || stack.environment.project.organizationId !== organizationId) {
		return null;
	}
	return { kind: "compose", sourceType: stack.sourceType };
};

const isUniqueViolation = (error: unknown): boolean => {
	const code = (error as { code?: string } | null)?.code;
	const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
	return code === "23505" || cause === "23505";
};

const persistConnection = async (
	organizationId: string,
	plan: ConnectPlan,
	input: ConnectServiceInput,
	mirror: { registryProbeHost: string | null },
) =>
	// One transaction: the watch, the service change and the connection row
	// happen together or not at all, so a failure (or a concurrent connect that
	// loses the unique key) leaves nothing behind, and never removes a watch it
	// did not create.
	db.transaction(async (tx) => {
		// The watch is #577's: it carries the cursor, the ETag and the in-flight
		// mark. It is created DISABLED: the connection poll (PR 4) enables it, and
		// until then the #577 loop must not answer Deployments it cannot parse as a
		// plain watch. Turning a disabled watch on resets its starting point, so the
		// first poll baselines and the backlog of old Deployments never runs.
		await upsertGithubWatch(
			{
				organizationId,
				serviceType: input.serviceType,
				serviceId: input.serviceId,
				connectionId: input.githubConnectionId,
				owner: input.owner,
				repo: input.repo,
				environment: input.environment,
				enabled: false,
			},
			tx,
		);
		if (plan.serviceUpdate && input.serviceType === "application") {
			await tx
				.update(applications)
				.set(plan.serviceUpdate)
				.where(eq(applications.applicationId, input.serviceId));
		}
		return createGhaConnection(
			{
				organizationId,
				serviceType: input.serviceType,
				serviceId: input.serviceId,
				githubConnectionId: input.githubConnectionId,
				repoId: plan.repoId,
				repoFullName: plan.repoFullName,
				workflowPath: input.workflowPath,
				trackedBranch: input.trackedBranch,
				environment: input.environment,
				serviceKey: input.serviceKey,
				protectionMode: input.protectionMode,
				registryPrefix: input.registryPrefix,
				registryId: input.registryId,
				registryProbeHost: mirror.registryProbeHost,
				gateMode: input.gateMode,
				gateWorkflows: input.gateWorkflows,
				gateTimeoutMinutes: input.gateTimeoutMinutes,
				state: "waiting",
				expectedSha: plan.expectedSha,
				previousSource: plan.previousSource,
			},
			tx,
		);
	});

const trpcCode = (code: ConnectServiceError["code"]) =>
	code === "not-found"
		? "NOT_FOUND"
		: code === "conflict"
			? "CONFLICT"
			: code === "github"
				? "BAD_GATEWAY"
				: "BAD_REQUEST";

export const ghaConnectionRouter = createTRPCRouter({
	one: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/ghaConnection.one",
				description:
					"Read how an application or compose stack follows GitHub Actions releases, or null when it does not: repository, workflow file, tracked branch, environment, service key, state (waiting, connected, stale, blocked, disconnected), the sentence the dashboard shows, the commit and run deployed, the last activity and error, and the last five releases (commit, run, attempt, delivery, status). The GitHub token, the saved source settings and the list of handled runs are never returned.",
			},
		})
		.input(apiGhaConnectionOne)
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["read"],
			});
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
				return null;
			}
			const releases = await listReleases(row.ghaConnectionId, 5);
			return {
				...presentGhaConnection(row),
				releases: releases.map((release) => ({
					releaseId: release.releaseId,
					sha: release.sha,
					runId: release.runId,
					runAttempt: release.runAttempt,
					delivery: release.delivery,
					status: release.status,
					gateState: release.gateState,
					gateReason: release.gateReason,
					createdAt: release.createdAt,
					settledAt: release.settledAt,
				})),
			};
		}),

	connect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.connect",
				description:
					"Make an application or compose stack follow the GitHub Actions releases of a repository. Dokploy never receives a call from GitHub: it polls GitHub for GitHub Deployments whose task is dokploy:<serviceKey>, reads the run artifact dokploy-release, checks it against the run, the registry and the environment's deployment branch policy, and deploys the image digest. Needs the service's create access, a GitHub connection (githubDeployment-connections) authorized with repo_deployment plus public_repo (public repositories) or repo (private ones), and a GitHub environment whose deployment branches allow only the tracked branch. An application built from git keeps its settings and has git autodeploy turned off now; it moves to the image at the first release (a public GHCR image only). For images mirrored to a private registry give registryPrefix (host[:port][/path] exactly as in the release, for example localhost:5000/registry.devino.ca) and registryId, the Dokploy registry whose URL and login check the digests; a compose stack stored in Dokploy (raw) is the supported shape. The workflow file is not created: copy the one the dashboard shows. Refuses a service that already follows GitHub Deployments.",
			},
		})
		.input(apiGhaConnectInput)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const organizationId = ctx.session.activeOrganizationId;
			const result = await connectGhaService(input, {
				githubConnection: async (id) => {
					const account = await findGithubConnectionInOrganization(
						id,
						organizationId,
					);
					if (!account) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "GitHub connection not found",
						});
					}
					// Same model as githubDeployment.watchSet: being allowed to connect a
					// service is not being allowed to spend another member's GitHub
					// token (own connection, one shared with the organization, or any
					// for an owner or admin).
					if (
						!canUseGithubConnection(account, {
							userId: ctx.user.id,
							role: ctx.user.role,
						})
					) {
						throw new TRPCError({
							code: "FORBIDDEN",
							message:
								"This GitHub connection belongs to another member and is not shared with the organization",
						});
					}
					return { scopes: account.scopes, status: account.status };
				},
				token: loadConnectionToken,
				service: (type, id) => loadServiceFacts(type, id, organizationId),
				existing: async (type, id) => ({
					connection: (await findGhaConnection(type, id)) !== null,
					plainWatch: (await findGithubWatch(type, id)) !== null,
				}),
				reads: githubReads,
				// The Dokploy registry (Settings, Registry) whose URL and login check the digests.
				registry: async (id) => {
					const [row] = await db
						.select({ registryUrl: registry.registryUrl })
						.from(registry)
						.where(
							and(
								eq(registry.registryId, id),
								eq(registry.organizationId, organizationId),
							),
						);
					return row ?? null;
				},
				persist: (plan, request, mirror) =>
					persistConnection(organizationId, plan, request, mirror),
				isUniqueViolation,
			});
			if (!result.ok) {
				throw new TRPCError({
					code: trpcCode(result.code),
					message: result.message,
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: `GitHub Actions: ${result.plan.repoFullName}`,
			});
			return presentGhaConnection(result.saved);
		}),

	disconnect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.disconnect",
				description:
					"Stop a service from following GitHub Actions releases. By default an application goes back to the git source it had before it was connected (restoreSource false leaves it on its current image). The service keeps running its current deployment. Removes the connection, its release history and its watch.",
			},
		})
		.input(apiGhaDisconnect)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			const organizationId = ctx.session.activeOrganizationId;
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			// The service may be gone (deleted before this hook existed, or by a
			// path that skips it): an owner or admin can still clear the row, which
			// holds a GitHub token's binding and blocks removing the account.
			const serviceGone =
				row !== null &&
				row.organizationId === organizationId &&
				!(await serviceRowExists(input.serviceType, input.serviceId));
			if (serviceGone) {
				if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message:
							"The service no longer exists; an organization owner or admin must clear its GitHub Actions connection",
					});
				}
			} else {
				await checkServicePermissionAndAccess(ctx, input.serviceId, {
					service: ["create"],
					deployment: ["create"],
				});
			}
			if (!row || row.organizationId !== organizationId) return true;
			const watch = await findGithubWatch(input.serviceType, input.serviceId);
			await db.transaction(async (tx) => {
				if (
					!serviceGone &&
					input.restoreSource &&
					input.serviceType === "application" &&
					row.previousSource
				) {
					await tx
						.update(applications)
						.set(
							row.previousSource as Partial<typeof applications.$inferInsert>,
						)
						.where(eq(applications.applicationId, input.serviceId));
				}
				await deleteGhaConnection(input.serviceType, input.serviceId, tx);
				await deleteGithubWatch(input.serviceType, input.serviceId, tx);
			});
			if (watch) {
				await removeGhcrWatchConfigDirs([watch.watchId], organizationId);
			}
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: "GitHub Actions: disconnected",
			});
			return true;
		}),

	checkNow: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.checkNow",
				description:
					"Ask Dokploy to look at GitHub for this service now: resets the idle slow-down, and retries a blocked connection. Needs the same access as disconnect.",
			},
		})
		.input(apiGhaCheckNow)
		.mutation(async ({ ctx, input }) => {
			// It changes state (activity time, unblocks the connection), so it is
			// gated like disconnect, not like a read.
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This service does not follow GitHub Actions",
				});
			}
			await touchConnectionActivity(row.ghaConnectionId);
			if (row.state === "blocked") {
				await applyConnectionEvent(
					row.ghaConnectionId,
					{ type: "unblock", hasRelease: row.deployedSha !== null },
					null,
				);
			}
			return true;
		}),

	update: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.update",
				description:
					"Change when a release of a service that follows GitHub Actions is deployed (the deploy gate). gateMode image deploys as soon as the image is accepted; checks waits until every check on the commit passes (the required checks of the branch, else the checks of the last green commit, else whatever the commit reports); workflows waits until the workflows named in gateWorkflows pass (by workflow name or file name without .yml, 1 to 20). gateTimeoutMinutes (5 to 720, default 60) is how long a check or workflow may take to report before the release is blocked. Changing the mode or the workflows starts the gate over and unblocks a service the gate blocked. A workflow entry ending in .yml or .yaml names a workflow file; any other entry names a workflow. Needs the same access as disconnect; a change that lets releases through on less (the gate off or swapped, a workflow removed, a longer wait) and any change while a release waits or is blocked need an organization owner or admin. Every change is audited with the settings before and after.",
			},
		})
		.input(apiGhaUpdate)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This service does not follow GitHub Actions",
				});
			}
			if (
				input.gateMode === undefined &&
				input.gateWorkflows === undefined &&
				input.gateTimeoutMinutes === undefined
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Nothing to change",
				});
			}
			const mode = input.gateMode ?? row.gateMode;
			const workflows = input.gateWorkflows ?? row.gateWorkflows ?? [];
			if (mode === "workflows" && workflows.length === 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Name at least one workflow to wait for",
				});
			}
			// Loosening the gate, or touching it while a release waits on it, is the
			// owner's or an admin's call, like Deploy anyway: a member who may manage
			// git providers must not be able to wave a release through.
			const privileged = ctx.user.role === "owner" || ctx.user.role === "admin";
			if (!privileged) {
				const weakens = gateChangeWeakens(
					{
						gateMode: row.gateMode,
						gateWorkflows: row.gateWorkflows ?? [],
						gateTimeoutMinutes: row.gateTimeoutMinutes,
					},
					{
						gateMode: mode,
						gateWorkflows: workflows,
						gateTimeoutMinutes:
							input.gateTimeoutMinutes ?? row.gateTimeoutMinutes,
					},
				);
				const gated = await findGatedRelease(row.ghaConnectionId);
				const busy =
					gated?.gateState === "waiting" || gated?.gateState === "blocked";
				if (weakens || busy) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: busy
							? "A release is waiting at the gate: only an organization owner or admin can change it now"
							: "Only an organization owner or admin can loosen the gate",
					});
				}
			}
			const saved = await updateGateSettings(row.ghaConnectionId, {
				gateMode: input.gateMode,
				gateWorkflows: input.gateWorkflows,
				gateTimeoutMinutes: input.gateTimeoutMinutes,
			});
			if (!saved) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This service does not follow GitHub Actions",
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: `GitHub Actions: deploy when ${saved.after.gateMode}`,
				metadata: {
					before: saved.before,
					after: saved.after,
					restarted: saved.restarted,
				},
			});
			const fresh = await findGhaConnection(input.serviceType, input.serviceId);
			return presentGhaConnection(fresh ?? row);
		}),

	deployAnyway: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.deployAnyway",
				description:
					"Deploy the release that is waiting at the deploy gate (or blocked by it) without waiting for its checks. Name the release (releaseId, from ghaConnection.one); it is refused with a conflict when a newer release has arrived. Only an organization owner or admin may, with deploy access to the service. Who, when and why are kept on the release and in the audit log. Returns the decision, deploy, and the commit that goes out; the next poll deploys it.",
			},
		})
		.input(apiGhaDeployAnyway)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only an organization owner or admin can deploy anyway",
				});
			}
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This service does not follow GitHub Actions",
				});
			}
			const released = await overrideGate(
				row.ghaConnectionId,
				input.releaseId,
				{
					by: ctx.user.email,
					at: new Date().toISOString(),
					reason: input.reason || null,
				},
			);
			if (released.kind === "none") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No release is waiting to be deployed",
				});
			}
			if (released.kind === "conflict") {
				throw new TRPCError({
					code: "CONFLICT",
					message: `A newer release (${released.newestSha.slice(0, 7)}) has arrived. Look at it first.`,
				});
			}
			await audit(ctx, {
				action: "deploy",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: `GitHub Actions: deploy anyway ${released.sha.slice(0, 7)}`,
				metadata: {
					reason: input.reason || null,
					releaseId: released.releaseId,
				},
			});
			return { decision: "deploy" as const, sha: released.sha };
		}),
});
