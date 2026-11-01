import {
	beginGithubConnect,
	deleteGithubConnection,
	deleteGithubWatch,
	findApplicationById,
	findComposeById,
	findGithubConnectionInOrganization,
	findGithubWatch,
	IS_CLOUD,
	listGithubConnections,
	presentGithubWatch,
	progressGithubConnect,
	upsertGithubConnection,
	upsertGithubWatch,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { githubDeploymentWatch } from "@dokploy/server/db/schema";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiGithubDeploymentCompleteConnect,
	apiGithubDeploymentDisconnect,
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
	fetch: (url: string, init?: Parameters<typeof fetch>[1]) =>
		fetch(url, init as RequestInit),
	now: () => Date.now(),
});

export const githubDeploymentRouter = createTRPCRouter({
	connections: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/githubDeployment.connections",
				description:
					"List the GitHub accounts this organization connected for GitHub Deployments (the device-flow connection used to deploy from GitHub Actions without Dokploy being reachable). Returns, per connection: connectionId, githubLogin, the OAuth scopes GitHub granted, status ('active' or 'revoked') and lastError. The access token is never returned.",
			},
		})
		.query(async ({ ctx }) => {
			return await listGithubConnections(ctx.session.activeOrganizationId);
		}),

	startConnect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.startConnect",
				description:
					"Start connecting a GitHub account with the OAuth device flow (scopes repo_deployment and read:packages). Returns flowId, userCode, verificationUri, intervalSeconds and expiresInSeconds: the user opens verificationUri, types userCode and approves; then call githubDeployment-completeConnect with the flowId every intervalSeconds until it reports 'connected'. No client secret is involved and the device code never leaves the server.",
			},
		})
		.mutation(async ({ ctx }) => {
			assertSelfHosted();
			const started = await beginGithubConnect(deps(), {
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
			});
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
					"Remove a GitHub connection and the token stored for it. Every service watch that used the connection is removed with it, so those services stop following GitHub Deployments. To revoke the grant on GitHub's side too, remove 'Dokploy Community' under GitHub Settings > Applications.",
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
			await audit(ctx, {
				action: "delete",
				resourceType: "gitProvider",
				resourceId: connection.connectionId,
				resourceName: `GitHub Deployments: ${connection.githubLogin}`,
			});
			await deleteGithubConnection(
				input.connectionId,
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
					"List every service of this organization that follows GitHub Deployments: serviceType (application or compose), serviceId, connectionId, owner, repo, environment, enabled, the last GitHub deployment id handled, the one in flight, when it was last checked and the last error.",
			},
		})
		.query(async ({ ctx }) => {
			const rows = await db
				.select()
				.from(githubDeploymentWatch)
				.where(
					eq(
						githubDeploymentWatch.organizationId,
						ctx.session.activeOrganizationId,
					),
				);
			return rows.map(presentGithubWatch);
		}),

	watchOne: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/githubDeployment.watchOne",
				description:
					"Read the 'Deploy from GitHub Deployments' settings of one application or compose stack, or null when it has none: connectionId, owner, repo, environment, enabled and the poller's progress (last deployment id handled, in flight, last check, last error).",
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

	watchSet: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "POST",
				path: "/githubDeployment.watchSet",
				description:
					'Make an application or compose stack follow GitHub Deployments, or change/disable it. Dokploy then polls owner/repo for deployments of the given environment (default production) and deploys the ones whose payload is {"dokploy":{"serviceId":"<this service>","image":"<repository>@sha256:<64 hex>"}}. The image must be pinned by digest and be a new digest of the repository the service already runs. Existing deployments are never replayed: only ones created after this is set. Changing the repository, environment or connection resets that starting point.',
			},
		})
		.input(apiGithubDeploymentWatchSet)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
			});
			const organizationId = ctx.session.activeOrganizationId;
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
			const connection = await findGithubConnectionInOrganization(
				input.connectionId,
				organizationId,
			);
			if (!connection) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "GitHub connection not found",
				});
			}
			const watch = await upsertGithubWatch({ ...input, organizationId });
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: `GitHub Deployments: ${input.owner}/${input.repo}`,
			});
			return presentGithubWatch(watch);
		}),

	watchRemove: withPermission("gitProviders", "read")
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
			});
			const watch = await findGithubWatch(input.serviceType, input.serviceId);
			if (!watch || watch.organizationId !== ctx.session.activeOrganizationId) {
				return true;
			}
			await deleteGithubWatch(input.serviceType, input.serviceId);
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: "GitHub Deployments: stopped following",
			});
			return true;
		}),
});
