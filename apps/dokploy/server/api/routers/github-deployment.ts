import {
	beginGithubConnect,
	canRemoveGithubConnection,
	canUseGithubConnection,
	createGithubFetch,
	deleteGithubConnection,
	deleteGithubWatch,
	findApplicationById,
	findComposeById,
	findGithubConnectionInOrganization,
	findGithubWatch,
	findRecentOtherGithubDeployer,
	IS_CLOUD,
	listGithubConnectionRecords,
	listGithubWatchesForConnection,
	listGithubWatchesForOrganization,
	ownsGithubConnection,
	presentGithubWatch,
	progressGithubConnect,
	removeGhcrWatchConfigDirs,
	setGithubConnectionShared,
	upsertGithubConnection,
	upsertGithubWatch,
	visibleGithubConnections,
} from "@dokploy/server";
import { GITHUB_DEVICE_SCOPE_PRIVATE } from "@dokploy/server/db/schema";
import {
	countGhaConnectionsForGithubConnection,
	findGhaConnection,
} from "@dokploy/server/services/gha-connect";
import {
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiGithubDeploymentCompleteConnect,
	apiGithubDeploymentDisconnect,
	apiGithubDeploymentStartConnect,
	apiGithubDeploymentToggleShare,
	apiGithubDeploymentWatchOne,
	apiGithubDeploymentWatchSet,
} from "@/server/db/schema";

/**
 * Connect GitHub (device flow) and "Deploy from GitHub Deployments".
 * The GitHub token is never returned by any procedure here, and so never by
 * the MCP tools generated from them. See docs/design/github-deployments-pull.md.
 */

const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Functionality not available in cloud version",
		});
	}
};

const deps = () => ({
	// Cut off after 15 s: a hung GitHub must not hold a dashboard call open.
	fetch: createGithubFetch(),
	now: () => Date.now(),
});

/** Who is calling, for the connection ownership rules (the role is the one in the active organization). */
const viewerOf = (ctx: { user: { id: string; role: string } }) => ({
	userId: ctx.user.id,
	role: ctx.user.role,
});

/**
 * A connection's token can pull its owner's private GHCR packages, so a
 * connection is used and removed only by its owner, by an organization owner or
 * admin, or (use only) by anyone when its owner shared it. See
 * packages/server/src/services/github-deployments/connection-access.ts.
 */
/**
 * A service that follows GitHub Actions releases (ghaConnection) owns its
 * watch: the connection poll keeps the cursor, so editing or removing the watch
 * here would break it. Disconnect through ghaConnection first.
 */
const assertNotGhaConnected = async (
	serviceType: "application" | "compose",
	serviceId: string,
) => {
	if (await findGhaConnection(serviceType, serviceId)) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"This service follows GitHub Actions releases (ghaConnection). Disconnect it there first.",
		});
	}
};

const requireConnectionToUse = async (
	ctx: Parameters<typeof viewerOf>[0] & {
		session: { activeOrganizationId: string };
	},
	connectionId: string,
) => {
	const connection = await findGithubConnectionInOrganization(
		connectionId,
		ctx.session.activeOrganizationId,
	);
	if (!connection) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "GitHub connection not found",
		});
	}
	if (!canUseGithubConnection(connection, viewerOf(ctx))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"This GitHub connection belongs to another member and is not shared with the organization",
		});
	}
	return connection;
};

export const githubDeploymentRouter = createTRPCRouter({
	connections: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/githubDeployment.connections",
				description:
					"List the GitHub accounts connected for GitHub Deployments (the device-flow connection used to deploy from GitHub Actions without Dokploy being reachable) that you may use: your own, the ones their owner shared with the organization, and every one for an organization owner or admin. Returns, per connection: connectionId, githubLogin, the OAuth scopes GitHub granted, sharedWithOrganization, isOwner, status ('active' or 'revoked') and lastError. The access token is never returned.",
			},
		})
		.query(async ({ ctx }) => {
			return visibleGithubConnections(
				await listGithubConnectionRecords(ctx.session.activeOrganizationId),
				viewerOf(ctx),
			);
		}),

	toggleShare: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.toggleShare",
				description:
					"Share a GitHub connection with the organization, or take the share back. Only the member who connected it can. While shared, every member who can deploy a service may bind the connection to it, and its token then pulls that service's private GHCR images of the connected account, so share only an account whose packages the whole organization may deploy. Off by default.",
			},
		})
		.input(apiGithubDeploymentToggleShare)
		.mutation(async ({ ctx, input }) => {
			const connection = await findGithubConnectionInOrganization(
				input.connectionId,
				ctx.session.activeOrganizationId,
			);
			if (!connection) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "GitHub connection not found",
				});
			}
			if (!ownsGithubConnection(connection, viewerOf(ctx))) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the member who connected this account can share it",
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: "gitProvider",
				resourceId: connection.connectionId,
				resourceName: `GitHub Deployments: ${connection.githubLogin}`,
			});
			return await setGithubConnectionShared(
				input.connectionId,
				ctx.session.activeOrganizationId,
				input.sharedWithOrganization,
			);
		}),

	startConnect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.startConnect",
				description:
					"Start connecting a GitHub account with the OAuth device flow (scopes repo_deployment and public_repo, or repo with repositoryAccess private for private repositories). Returns flowId, userCode, verificationUri, intervalSeconds and expiresInSeconds: the user opens verificationUri, types userCode and approves; then call githubDeployment-completeConnect with the flowId every intervalSeconds until it reports 'connected'. No client secret is involved and the device code never leaves the server.",
			},
		})
		.input(apiGithubDeploymentStartConnect.optional())
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			const started = await beginGithubConnect(
				deps(),
				{
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
				},
				input?.repositoryAccess === "private"
					? { scope: GITHUB_DEVICE_SCOPE_PRIVATE }
					: {},
			);
			if (!started.ok) {
				throw new TRPCError({ code: "BAD_GATEWAY", message: started.message });
			}
			return {
				flowId: started.flowId,
				userCode: started.userCode,
				verificationUri: started.verificationUri,
				intervalSeconds: started.intervalSeconds,
				expiresInSeconds: started.expiresInSeconds,
			};
		}),

	completeConnect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.completeConnect",
				description:
					"Poll a device flow started with githubDeployment-startConnect. Returns status 'pending' (with retryAfterSeconds; calling sooner is harmless and does not reach GitHub), 'connected' (with the connection: connectionId, githubLogin, scopes; the token is stored encrypted and never returned), 'expired', 'denied' or 'failed' (with a message).",
			},
		})
		.input(apiGithubDeploymentCompleteConnect)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			const owner = {
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
			};
			const progress = await progressGithubConnect(deps(), input.flowId, owner);
			if (progress.status !== "connected") return progress;
			const connection = await upsertGithubConnection({
				organizationId: owner.organizationId,
				createdByUserId: owner.userId,
				githubLogin: progress.login,
				githubUserId: progress.userId,
				scopes: progress.scopes,
				accessToken: progress.accessToken,
			});
			await audit(ctx, {
				action: "create",
				resourceType: "gitProvider",
				resourceId: connection.connectionId,
				resourceName: `GitHub Deployments: ${connection.githubLogin}`,
			});
			return { status: "connected" as const, connection };
		}),

	disconnect: withPermission("gitProviders", "delete")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.disconnect",
				description:
					"Remove a GitHub connection and the token stored for it. Only the member who connected it or an organization owner or admin can. Every service watch that used the connection is removed with it, so those services stop following GitHub Deployments. To revoke the grant on GitHub's side too, remove 'Dokploy Community' under GitHub Settings > Applications.",
			},
		})
		.input(apiGithubDeploymentDisconnect)
		.mutation(async ({ ctx, input }) => {
			const connection = await findGithubConnectionInOrganization(
				input.connectionId,
				ctx.session.activeOrganizationId,
			);
			if (!connection) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "GitHub connection not found",
				});
			}
			if (!canRemoveGithubConnection(connection, viewerOf(ctx))) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "You can only remove your own GitHub connections",
				});
			}
			// Services that follow GitHub Actions releases through this account keep
			// their saved source and watch cursor in their own rows: removing the
			// account would orphan them (the database refuses it too).
			const connected = await countGhaConnectionsForGithubConnection(
				input.connectionId,
			);
			if (connected > 0) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `Disconnect the ${connected} service${connected === 1 ? "" : "s"} connected to GitHub Actions through this account first (ghaConnection-disconnect).`,
				});
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "gitProvider",
				resourceId: connection.connectionId,
				resourceName: `GitHub Deployments: ${connection.githubLogin}`,
			});
			// The watches go with the connection (cascade), and so does the GitHub
			// token's login on the hosts: read them first, delete their docker
			// config dirs after.
			const watches = await listGithubWatchesForConnection(
				input.connectionId,
				ctx.session.activeOrganizationId,
			);
			await deleteGithubConnection(
				input.connectionId,
				ctx.session.activeOrganizationId,
			);
			await removeGhcrWatchConfigDirs(
				watches.map((watch) => watch.watchId),
				ctx.session.activeOrganizationId,
			);
			return true;
		}),

	watches: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/githubDeployment.watches",
				description:
					"List the services of this organization that follow GitHub Deployments (a member only sees the services they were given access to): serviceType (application or compose), serviceId, connectionId, owner, repo, environment, enabled, postLogUrl, the last GitHub deployment id handled, the one in flight, when it was last checked and the last error.",
			},
		})
		.query(async ({ ctx }) => {
			const organizationId = ctx.session.activeOrganizationId;
			// Same scoping as the other service lists: owners and admins see the
			// organization, a member only the services in their accessedServices.
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, organizationId))
							.accessedServices
					: null;
			const rows = await listGithubWatchesForOrganization(
				organizationId,
				accessedServices,
			);
			return rows.map(presentGithubWatch);
		}),

	watchOne: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/githubDeployment.watchOne",
				description:
					"Read the 'Deploy from GitHub Deployments' settings of one application or compose stack, or null when it has none: connectionId, owner, repo, environment, enabled, postLogUrl and the poller's progress (last deployment id handled, in flight, last check, last error).",
			},
		})
		.input(apiGithubDeploymentWatchOne)
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["read"],
			});
			const watch = await findGithubWatch(input.serviceType, input.serviceId);
			if (!watch || watch.organizationId !== ctx.session.activeOrganizationId) {
				return null;
			}
			return presentGithubWatch(watch);
		}),

	watchSet: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.watchSet",
				description:
					'Make an application or compose stack follow GitHub Deployments, or change/disable it. Dokploy then polls owner/repo for deployments of the given environment (default production) and deploys the ones whose payload is {"dokploy":{"serviceId":"<this service>","image":"<repository>@sha256:<64 hex>"}}. The image must be pinned by digest and be a new digest of the repository the service already runs. Existing deployments are never replayed: only ones created after this is set. Changing the repository, environment or connection, or turning a disabled watch back on, resets that starting point. When several deployments are waiting only the newest is deployed; the older ones are answered as inactive. Statuses sent to GitHub carry fixed text only; set postLogUrl to also send the Dokploy dashboard link as log_url (off by default). Needs the gitProviders and deployment create permissions plus create access to the service, and a GitHub connection you may use (your own, one shared with the organization, or any for an owner or admin). Refused with a conflict when GitHub Actions deployed this service in the last 24 hours (or has a build live for it), because two deployers would write its image; send override true to proceed.',
			},
		})
		.input(apiGithubDeploymentWatchSet)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const organizationId = ctx.session.activeOrganizationId;
			await assertNotGhaConnected(input.serviceType, input.serviceId);
			// The service has to exist, be of the stated type and be this organization's.
			const service =
				input.serviceType === "application"
					? await findApplicationById(input.serviceId).catch(() => null)
					: await findComposeById(input.serviceId).catch(() => null);
			if (
				!service ||
				service.environment.project.organizationId !== organizationId
			) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Service not found",
				});
			}
			// Also on an unchanged connection: being allowed to deploy a service is
			// not being allowed to spend another member's GitHub token.
			await requireConnectionToUse(ctx, input.connectionId);
			// Two deployers: the dokploy-deploy action already pushes to this
			// service. Both would write its image; refuse unless told to go on.
			const { override, ...watchInput } = input;
			if (watchInput.enabled && !override) {
				const existing = await findGithubWatch(
					input.serviceType,
					input.serviceId,
				);
				// A watch that is already on is the pull deployer itself.
				if (!existing?.enabled) {
					const other = await findRecentOtherGithubDeployer(
						input.serviceType,
						input.serviceId,
					);
					if (other) {
						throw new TRPCError({
							code: "CONFLICT",
							message: `This service was deployed by GitHub Actions in the last 24 hours ("${other.title}"). Following GitHub Deployments as well would give it two deployers writing its image. Switch the workflow to the Deployments flow first, or set override to true to continue.`,
						});
					}
				}
			}
			const watch = await upsertGithubWatch({ ...watchInput, organizationId });
			// A watch that is off has no use for a login on any host.
			if (!watch.enabled) {
				await removeGhcrWatchConfigDirs([watch.watchId], organizationId);
			}
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: `GitHub Deployments: ${input.owner}/${input.repo}`,
			});
			return presentGithubWatch(watch);
		}),

	watchRemove: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.watchRemove",
				description:
					"Stop a service from following GitHub Deployments and forget its progress. The service and its current deployment are left as they are.",
			},
		})
		.input(apiGithubDeploymentWatchOne)
		.mutation(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			await assertNotGhaConnected(input.serviceType, input.serviceId);
			const watch = await findGithubWatch(input.serviceType, input.serviceId);
			if (!watch || watch.organizationId !== ctx.session.activeOrganizationId) {
				return true;
			}
			await deleteGithubWatch(input.serviceType, input.serviceId);
			await removeGhcrWatchConfigDirs([watch.watchId], watch.organizationId);
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: "GitHub Deployments: stopped following",
			});
			return true;
		}),
});
