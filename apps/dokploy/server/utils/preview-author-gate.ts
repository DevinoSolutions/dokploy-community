import {
	checkGitlabMemberPermissions,
	checkGitlabMemberPermissionsByUserId,
	checkUserRepositoryPermissions,
	findGithubById,
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
}

export interface PreviewAuthorGateInput {
	pullRequestAuthor?: string;
	pullRequestAuthorId?: number;
}

const AUTHOR_REQUIRED_MESSAGE =
	"Preview deployment blocked: the change request author is required so their repository access can be verified. Send pullRequestAuthor (and pullRequestAuthorId for GitLab), or turn off the collaborator permission requirement in the preview deployment settings.";

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
