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
	getBranchHead,
	getEnvironmentPolicy,
	getRepositoryByName,
	listReleases,
	presentGhaConnection,
	serviceRowExists,
	type ServiceFacts,
	touchConnectionActivity,
} from "@dokploy/server/services/gha-connect";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiGhaCheckNow,
	apiGhaConnect,
	apiGhaConnectionOne,
	apiGhaDisconnect,
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
		.input(apiGhaConnect)
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
});
