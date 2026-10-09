import {
	checkGiteaUserRepositoryPermissions,
	checkGitlabMemberPermissions,
	checkGitlabMemberPermissionsByUserId,
	checkUserRepositoryPermissions,
	findGithubById,
	getGiteaPullRequests,
	getGithubPullRequests,
	getGitlabMergeRequests,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";

/**
 * The subset of an application/compose row this gate needs. Both tables carry
 * these columns with the same meaning.
 */
export interface PreviewAuthorGateResource {
	name: string;
	sourceType: string;
	previewRequireCollaboratorPermissions: boolean | null;
	owner: string | null;
	repository: string | null;
	githubId: string | null;
	gitlabId: string | null;
	gitlabProjectId: number | null;
	giteaId: string | null;
	giteaOwner: string | null;
	giteaRepository: string | null;
}

export interface PreviewAuthorGateInput {
	pullRequestAuthor?: string;
	pullRequestAuthorId?: number;
}

const AUTHOR_REQUIRED_MESSAGE =
	"Preview deployment blocked: the change request author is required so their repository access can be verified. Send pullRequestAuthor (and pullRequestAuthorId for GitLab), or turn off the collaborator permission requirement in the preview deployment settings.";

export interface PreviewChangeRequestInput extends PreviewAuthorGateInput {
	branch: string;
	pullRequestId: string;
	pullRequestNumber: string;
}

/**
 * Replace the client-claimed change request identity with the provider's.
 *
 * A preview checks out `refs/pull/<pullRequestNumber>/head`, so the number
 * selects the code that gets built. The author gate only authorizes whoever the
 * request *names* as the author; without this lookup a caller could name a
 * collaborator while pointing the number at an untrusted fork's pull request.
 * Here the open change request is fetched from the provider by number and its
 * real author (and head branch) replace whatever the client sent. An unknown or
 * closed change request, or an id that does not belong to that number, is
 * rejected; a provider failure blocks the deployment (fail closed).
 *
 * Returns the input untouched when `previewRequireCollaboratorPermissions` is
 * off (no author is checked then) and when the provider is not configured —
 * `assertPreviewAuthorAllowed` rejects that case with its own message.
 */
export const resolveVerifiedPreviewAuthor = async <
	T extends PreviewChangeRequestInput,
>(
	resource: PreviewAuthorGateResource,
	input: T,
): Promise<T> => {
	if (resource.previewRequireCollaboratorPermissions === false) {
		return input;
	}

	const listChangeRequests = async () => {
		if (
			resource.sourceType === "github" &&
			resource.githubId &&
			resource.owner &&
			resource.repository
		) {
			return await getGithubPullRequests({
				githubId: resource.githubId,
				owner: resource.owner,
				repo: resource.repository,
			});
		}
		if (
			resource.sourceType === "gitlab" &&
			resource.gitlabId &&
			resource.gitlabProjectId
		) {
			// Only the numeric project id is used to list merge requests.
			return await getGitlabMergeRequests({
				gitlabId: resource.gitlabId,
				id: resource.gitlabProjectId,
				owner: "",
				repo: "",
			});
		}
		if (
			resource.sourceType === "gitea" &&
			resource.giteaId &&
			resource.giteaOwner &&
			resource.giteaRepository
		) {
			return await getGiteaPullRequests({
				giteaId: resource.giteaId,
				owner: resource.giteaOwner,
				repositoryName: resource.giteaRepository,
			});
		}
		return null;
	};

	let changeRequests: Awaited<ReturnType<typeof listChangeRequests>>;
	try {
		changeRequests = await listChangeRequests();
	} catch (error) {
		console.error(
			`Error listing change requests to verify the author for ${resource.name}:`,
			error,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Preview deployment blocked: could not look up the pull request to verify its author",
		});
	}

	if (changeRequests === null) {
		return input;
	}

	const number = input.pullRequestNumber.trim();
	const changeRequest = changeRequests.find(
		(candidate) =>
			String(candidate.number) === number &&
			String(candidate.id) === input.pullRequestId.trim(),
	);

	if (!changeRequest) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Preview deployment blocked: no open pull request #${number} matches the request (it may be closed or the id is wrong)`,
		});
	}

	return {
		...input,
		branch: changeRequest.branch || input.branch,
		pullRequestAuthor: changeRequest.authorUsername ?? undefined,
		pullRequestAuthorId: changeRequest.authorId ?? undefined,
	};
};

/**
 * Authorize a preview deployment by the *change request author*, mirroring what
 * `pages/api/deploy/github.ts` and `pages/api/deploy/gitlab.ts` do for webhook
 * deliveries. Without it, creating a preview through the API (or the manual
 * "Build Pull Request" dialog) would execute an untrusted fork's build on the
 * host even though `previewRequireCollaboratorPermissions` is on.
 *
 * Deliberately does *not* check the base branch: bypassing base-branch matching
 * is the whole point of building a preview manually.
 *
 * Fails closed — a provider error blocks the deployment, matching the webhook
 * handlers, which skip the app when the permission lookup throws.
 */
export const assertPreviewAuthorAllowed = async (
	resource: PreviewAuthorGateResource,
	input: PreviewAuthorGateInput,
): Promise<void> => {
	if (resource.previewRequireCollaboratorPermissions === false) {
		console.warn(
			`⚠️  SECURITY: Preview deployment for ${resource.name} allows deployment from any change request author (security check disabled)`,
		);
		return;
	}

	if (resource.sourceType === "github") {
		await assertGithubAuthorAllowed(resource, input);
		return;
	}

	if (resource.sourceType === "gitlab") {
		await assertGitlabAuthorAllowed(resource, input);
		return;
	}

	if (resource.sourceType === "gitea") {
		await assertGiteaAuthorAllowed(resource, input);
		return;
	}

	throw new TRPCError({
		code: "BAD_REQUEST",
		message: `Preview deployments cannot verify the author for source type "${resource.sourceType}"`,
	});
};

const assertGithubAuthorAllowed = async (
	resource: PreviewAuthorGateResource,
	input: PreviewAuthorGateInput,
) => {
	const author = input.pullRequestAuthor?.trim();
	if (!author) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: AUTHOR_REQUIRED_MESSAGE,
		});
	}

	const { githubId, owner, repository } = resource;
	if (!githubId || !owner || !repository) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployment blocked: the GitHub provider, owner and repository must be configured before the author's access can be verified",
		});
	}

	let hasWriteAccess: boolean;
	let permission: string | null;
	try {
		const githubProvider = await findGithubById(githubId);
		({ hasWriteAccess, permission } = await checkUserRepositoryPermissions(
			githubProvider,
			owner,
			repository,
			author,
		));
	} catch (error) {
		console.error(
			`Error validating pull request author permissions for ${resource.name}:`,
			error,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: could not verify that ${author} has write access to ${owner}/${repository}`,
		});
	}

	if (!hasWriteAccess) {
		console.warn(
			`🚨 SECURITY: Blocked manual preview deployment for ${resource.name} from unauthorized user ${author} on ${owner}/${repository}. Permission: ${permission || "none"}`,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: ${author} does not have write access to ${owner}/${repository} (permission: ${permission || "none"})`,
		});
	}
};

/**
 * Gitea/Forgejo authorizes by handle, like GitHub. Two Gitea specifics:
 * the repository owner short circuits the lookup (Gitea only answers the
 * collaborator endpoint for repository admins), and an *unverified* answer —
 * Gitea refusing to name a permission — blocks the build without claiming the
 * author is untrusted.
 */
const assertGiteaAuthorAllowed = async (
	resource: PreviewAuthorGateResource,
	input: PreviewAuthorGateInput,
) => {
	const author = input.pullRequestAuthor?.trim();
	if (!author) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: AUTHOR_REQUIRED_MESSAGE,
		});
	}

	const { giteaId, giteaOwner, giteaRepository } = resource;
	if (!giteaId || !giteaOwner || !giteaRepository) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployment blocked: the Gitea provider, owner and repository must be configured before the author's access can be verified",
		});
	}

	// The repository owner always has admin access on their own repository.
	if (author.toLowerCase() === giteaOwner.toLowerCase()) {
		return;
	}

	let hasWriteAccess: boolean;
	let permission: string | null;
	let verified: boolean;
	try {
		({ hasWriteAccess, permission, verified } =
			await checkGiteaUserRepositoryPermissions(
				giteaId,
				giteaOwner,
				giteaRepository,
				author,
			));
	} catch (error) {
		console.error(
			`Error validating pull request author permissions for ${resource.name}:`,
			error,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: could not verify that ${author} has write access to ${giteaOwner}/${giteaRepository}`,
		});
	}

	if (!verified) {
		console.error(
			`🚨 SECURITY: Could not verify permissions of ${author} on ${giteaOwner}/${giteaRepository}; the Gitea account connected to Dokploy needs admin access on the repository.`,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: the Gitea account connected to Dokploy cannot read collaborator permissions for ${giteaOwner}/${giteaRepository}`,
		});
	}

	if (!hasWriteAccess) {
		console.warn(
			`🚨 SECURITY: Blocked manual preview deployment for ${resource.name} from unauthorized user ${author} on ${giteaOwner}/${giteaRepository}. Permission: ${permission || "none"}`,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: ${author} does not have write access to ${giteaOwner}/${giteaRepository} (permission: ${permission || "none"})`,
		});
	}
};

const assertGitlabAuthorAllowed = async (
	resource: PreviewAuthorGateResource,
	input: PreviewAuthorGateInput,
) => {
	const authorId = input.pullRequestAuthorId;
	const authorUsername = input.pullRequestAuthor?.trim();
	if (!authorId && !authorUsername) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: AUTHOR_REQUIRED_MESSAGE,
		});
	}

	const { gitlabId, gitlabProjectId } = resource;
	if (!gitlabId || !gitlabProjectId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Preview deployment blocked: the GitLab provider and project must be configured before the author's access can be verified",
		});
	}

	const authorLabel = authorUsername
		? `@${authorUsername}`
		: `the merge request author (id ${authorId})`;

	let hasWriteAccess: boolean;
	let accessLevel: number | null;
	try {
		// Prefer the numeric id: it is the identity the MR webhook authorizes
		// (`object_attributes.author_id`) and it cannot be spoofed by renames.
		({ hasWriteAccess, accessLevel } = authorId
			? await checkGitlabMemberPermissionsByUserId(
					gitlabId,
					gitlabProjectId,
					authorId,
				)
			: await checkGitlabMemberPermissions(
					gitlabId,
					gitlabProjectId,
					authorUsername as string,
				));
	} catch (error) {
		console.error(
			`Error validating merge request author permissions for ${resource.name}:`,
			error,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: could not verify that ${authorLabel} has write access to this GitLab project`,
		});
	}

	if (!hasWriteAccess) {
		console.warn(
			`🚨 SECURITY: Blocked manual preview deployment for ${resource.name} from ${authorLabel}. Access level: ${accessLevel}`,
		);
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Preview deployment blocked: ${authorLabel} does not have write access to this GitLab project (access level: ${accessLevel ?? "none"})`,
		});
	}
};
