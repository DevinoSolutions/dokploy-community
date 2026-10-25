import {
	assertCanUpdateGitProvider,
	assertGitProviderAccess,
	canViewGitProviderSecrets,
	findGithubById,
	getAccessibleGitProviderIds,
	getGithubBranches,
	getGithubPullRequests,
	getGithubRepositories,
	haveGithubRequirements,
	parseGithubAppUrl,
	updateGithub,
	updateGitProvider,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { TRPCError } from "@trpc/server";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindGithubBranches,
	apiFindGithubPullRequests,
	apiFindOneGithub,
	apiUpdateGithub,
} from "@/server/db/schema";

export const githubRouter = createTRPCRouter({
	one: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input, ctx }) => {
			const github = await findGithubById(input.githubId);
			await assertGitProviderAccess(ctx.session, github.gitProvider);

			if (!(await canViewGitProviderSecrets(ctx.session, github.gitProvider))) {
				return {
					...github,
					githubClientSecret: null,
					githubPrivateKey: null,
					githubWebhookSecret: null,
				};
			}

			return github;
		}),
	getGithubRepositories: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input, ctx }) => {
			const github = await findGithubById(input.githubId);
			await assertGitProviderAccess(ctx.session, github.gitProvider);
			return await getGithubRepositories(input.githubId);
		}),
	getGithubBranches: protectedProcedure
		.input(apiFindGithubBranches)
		.query(async ({ input, ctx }) => {
			if (input.githubId) {
				const github = await findGithubById(input.githubId);
				await assertGitProviderAccess(ctx.session, github.gitProvider);
			}
			return await getGithubBranches(input);
		}),
	getGithubPullRequests: protectedProcedure
		.input(apiFindGithubPullRequests)
		.query(async ({ input, ctx }) => {
			if (input.githubId) {
				const github = await findGithubById(input.githubId);
				await assertGitProviderAccess(ctx.session, github.gitProvider);
			}
			return await getGithubPullRequests(input);
		}),
	githubProviders: protectedProcedure.query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleGitProviderIds(ctx.session);

		let result = await db.query.github.findMany({
			with: {
				gitProvider: true,
			},
		});

		result = result.filter(
			(provider) =>
				provider.gitProvider.organizationId ===
					ctx.session.activeOrganizationId &&
				accessibleIds.has(provider.gitProvider.gitProviderId),
		);

		const filtered = result
			.filter((provider) => haveGithubRequirements(provider))
			.map((provider) => {
				return {
					githubId: provider.githubId,
					githubUrl: provider.githubUrl,
					gitProvider: {
						...provider.gitProvider,
					},
				};
			});

		return filtered;
	}),

	testConnection: protectedProcedure
		.input(apiFindOneGithub)
		.mutation(async ({ input, ctx }) => {
			try {
				const github = await findGithubById(input.githubId);
				await assertGitProviderAccess(ctx.session, github.gitProvider);
				const result = await getGithubRepositories(input.githubId);
				return `Found ${result.length} repositories`;
			} catch (err) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: err instanceof Error ? err?.message : `Error: ${err}`,
				});
			}
		}),
	update: withPermission("gitProviders", "create")
		.input(apiUpdateGithub)
		.mutation(async ({ input, ctx }) => {
			// The provider row is addressed by id: it has to belong to the caller's
			// organization before it is rewritten (updateGitProvider re-assigns the
			// organization), and its own gitProviderId is the one that is updated.
			const github = await findGithubById(input.githubId);
			await assertCanUpdateGitProvider(ctx.session, github.gitProvider);
			// A changed link has to stay on the provider's GitHub instance (the
			// install step redirects there). An unchanged value is kept as it is,
			// so providers saved earlier can still be edited.
			if (
				input.githubAppName !== github.githubAppName &&
				!parseGithubAppUrl(input.githubAppName, github.githubUrl)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The app URL has to be on the provider's GitHub instance",
				});
			}
			await updateGitProvider(github.gitProviderId, {
				name: input.name,
				organizationId: ctx.session.activeOrganizationId,
			});

			await updateGithub(input.githubId, {
				...input,
				gitProviderId: github.gitProviderId,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "gitProvider",
				resourceId: input.gitProviderId,
				resourceName: input.name,
			});
		}),
});
