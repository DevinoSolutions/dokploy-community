import {
	checkPreviewAuthorPermissions,
	createComposePreview,
	createPreviewDeployment,
	createPreviewSecurityBlockedComment,
	findPreviewDeploymentByApplicationId,
	findPreviewDeploymentByComposeId,
	findPreviewDeploymentsByPullRequestId,
	getPreviewCommentContext,
	IS_CLOUD,
	removePreviewDeployment,
} from "@dokploy/server";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";

/**
 * Gitea and Forgejo name some pull request actions differently than GitHub:
 * new commits arrive as `synchronized` rather than `synchronize`, and any label
 * change is `label_updated` (adding *or* removing a single label) while
 * `label_cleared` only fires when every label is removed at once.
 *
 * @link https://github.com/go-gitea/gitea/blob/main/modules/structs/hook.go
 */
const CODE_ACTIONS = ["opened", "reopened", "synchronized"];

/**
 * Actions that may create a preview. Label changes are included because a
 * pull request can become eligible by gaining one of `previewLabels`, exactly
 * like GitHub's `labeled`.
 */
const CREATE_ACTIONS = [...CODE_ACTIONS, "label_updated"];

/** Every pull request action this handler reacts to at all. */
const HANDLED_ACTIONS = [...CREATE_ACTIONS, "label_cleared"];

/**
 * Mirrors `shouldDeployPreviewDeployment` in `pages/api/deploy/github.ts`:
 * code-changing events always (re)deploy, label events only deploy when they
 * just created a preview that did not exist yet.
 *
 * Without this a label change redeploys an existing preview, which is both
 * wasteful and wrong for `label_cleared` — Gitea still ships the removed labels
 * in the payload, so the label filter would pass for a pull request that no
 * longer carries the label.
 */
export const shouldDeployGiteaPreview = ({
	action,
	createdPreviewDeployment,
}: {
	action: string | undefined;
	createdPreviewDeployment: boolean;
}) => CODE_ACTIONS.includes(action ?? "") || createdPreviewDeployment;

/**
 * Gitea serializes a user handle as `login` (`username` is only kept as a
 * backwards compatible alias), and handles are case insensitive.
 */
const getPayloadOwner = (repository: any): string | undefined =>
	repository?.owner?.login ??
	repository?.owner?.username ??
	repository?.owner?.name;

const sameHandle = (a?: string | null, b?: string | null) =>
	!!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The columns this handler needs from an application or a compose service.
 * Both tables carry them with the same meaning.
 */
interface PreviewResource {
	name: string;
	sourceType: string;
	serverId: string | null;
	giteaId: string | null;
	giteaOwner: string | null;
	giteaRepository: string | null;
	giteaBranch: string | null;
	isPreviewDeploymentsActive: boolean | null;
	previewLabels: string[] | null;
	previewLimit: number | null;
	previewRequireCollaboratorPermissions: boolean | null;
	previewDeployments?: { previewDeploymentId: string }[];
}

export interface PreviewApplication extends PreviewResource {
	applicationId: string;
}

export interface PreviewCompose extends PreviewResource {
	composeId: string;
}

interface HandlerResult {
	status: number;
	message: string;
}

/**
 * Detect whether a Gitea/Forgejo webhook delivery is a pull request event.
 *
 * Gitea folds every pull request sub event into `X-Gitea-Event: pull_request`
 * and keeps the specific one in `X-Gitea-Event-Type` (`pull_request_sync`,
 * `pull_request_label`, ...), so the generic header alone covers every pull
 * request sub event. Forgejo mirrors both into `X-Forgejo-*`. Both also
 * populate the GitHub compatibility headers, which are deliberately ignored
 * here so that GitHub deliveries keep taking the existing code path.
 *
 * Comments on a pull request arrive as `issue_comment` with the event *type*
 * `pull_request_comment` — Dokploy posts preview status comments itself, so
 * those deliveries come straight back to this webhook and must not be treated
 * as pull request events. The exact match on the generic event name rejects
 * them; a prefix match on the event type would not.
 *
 * @link https://github.com/go-gitea/gitea/blob/main/services/webhook/deliver.go
 */
const GITEA_PULL_REQUEST_EVENT_TYPES = [
	"pull_request",
	"pull_request_sync",
	"pull_request_label",
	"pull_request_assign",
	"pull_request_milestone",
	"pull_request_review_request",
];

export const isGiteaPullRequestEvent = (headers: any): boolean => {
	const event = headers?.["x-gitea-event"] ?? headers?.["x-forgejo-event"];

	if (event) {
		return event === "pull_request";
	}

	// Only reached when the generic header was stripped on the way in.
	const eventType =
		headers?.["x-gitea-event-type"] ?? headers?.["x-forgejo-event-type"];

	return GITEA_PULL_REQUEST_EVENT_TYPES.includes(eventType);
};

/**
 * The per-resource pieces the shared pull request flow needs, so applications
 * and compose services can share every check while keeping their own storage
 * and deployment job shapes.
 */
interface PreviewResourceAdapter<T extends PreviewResource> {
	resource: T;
	/** `applicationId` / `composeId`, used to scope the `closed` cleanup. */
	ownsPreviewDeployment: (previewDeployment: {
		applicationId: string | null;
		composeId: string | null;
	}) => boolean;
	findExistingPreview: (
		pullRequestId: string,
	) => Promise<{ previewDeploymentId: string } | undefined>;
	createPreview: (input: {
		branch: string;
		pullRequestId: string;
		pullRequestNumber: string;
		pullRequestTitle: string;
		pullRequestURL: string;
	}) => Promise<{ previewDeploymentId: string }>;
	buildJob: (args: {
		previewDeploymentId: string;
		descriptionLog: string;
	}) => DeploymentJob;
}

const queueDeployment = async (
	resource: PreviewResource,
	jobData: DeploymentJob,
): Promise<HandlerResult> => {
	if (IS_CLOUD && resource.serverId) {
		jobData.serverId = resource.serverId;
		deploy(jobData).catch((error) => {
			console.error("Background deployment failed:", error);
		});
		return { status: 200, message: "Preview Deployment queued" };
	}

	await myQueue.add(
		"deployments",
		{ ...jobData },
		{
			removeOnComplete: true,
			removeOnFail: true,
		},
	);

	return { status: 200, message: "Preview Deployment queued" };
};

/**
 * Handle a Gitea/Forgejo `pull_request` webhook event for a single application
 * or compose service.
 *
 * Unlike GitHub — where one app installation webhook serves every repository —
 * the Gitea webhook is created per service (the URL carries the service's
 * refresh token), so the event is always scoped to `adapter.resource`.
 */
const handleGiteaPullRequest = async <T extends PreviewResource>(
	adapter: PreviewResourceAdapter<T>,
	body: any,
): Promise<HandlerResult> => {
	const resource = adapter.resource;
	const action = body?.action;
	const pullRequest = body?.pull_request;
	const pullRequestId = pullRequest?.id;

	if (!pullRequestId) {
		return {
			status: 400,
			message: "Pull request id missing in webhook payload",
		};
	}

	// The webhook URL identifies the service, not the repository, so the payload
	// has to be checked against the repository the service is configured for.
	// Without this, a webhook on any repository could deploy an arbitrary branch
	// of the configured one.
	const payloadRepository = body?.repository?.name;
	const payloadOwner = getPayloadOwner(body?.repository);

	if (
		!sameHandle(payloadRepository, resource.giteaRepository) ||
		!sameHandle(payloadOwner, resource.giteaOwner)
	) {
		return {
			status: 400,
			message:
				"Pull request repository does not match the repository configured for this service",
		};
	}

	if (action === "closed") {
		const previewDeploymentResult = await findPreviewDeploymentsByPullRequestId(
			`${pullRequestId}`,
		);

		let removed = 0;
		for (const previewDeployment of previewDeploymentResult) {
			// Pull request ids are only unique per Gitea instance, so never touch
			// previews that belong to another service.
			if (!adapter.ownsPreviewDeployment(previewDeployment)) {
				continue;
			}
			try {
				await removePreviewDeployment(previewDeployment.previewDeploymentId);
				removed++;
			} catch (error) {
				console.error("Error removing preview deployment:", error);
			}
		}

		return {
			status: 200,
			message: `Preview Deployment Closed (${removed} removed)`,
		};
	}

	if (!resource.isPreviewDeploymentsActive) {
		return {
			status: 200,
			message: "Preview deployments are disabled for this service",
		};
	}

	if (!HANDLED_ACTIONS.includes(action)) {
		return {
			status: 200,
			message: `Pull request action '${action}' does not trigger preview deployments`,
		};
	}

	const baseBranch = pullRequest?.base?.ref;
	if (!baseBranch || baseBranch !== resource.giteaBranch) {
		return {
			status: 200,
			message: "Pull request does not target the configured branch",
		};
	}

	const prAuthor = pullRequest?.user?.login ?? pullRequest?.user?.username;
	if (!prAuthor) {
		console.warn(
			"⚠️ SECURITY: PR author information missing in webhook payload",
		);
		return { status: 400, message: "PR author information missing" };
	}

	const commentContext = getPreviewCommentContext(resource);
	if (!commentContext) {
		return {
			status: 400,
			message:
				"Preview deployments require a Gitea provider with a repository and owner configured",
		};
	}

	const prNumber = pullRequest?.number;
	const repositorySlug = `${resource.giteaOwner}/${resource.giteaRepository}`;

	// `cloneGiteaRepository` always clones the configured repository, so a branch
	// that only exists in a fork can never be checked out. Bail out with a clear
	// message instead of producing a failing build.
	const headRepository = pullRequest?.head?.repo;
	if (
		headRepository &&
		(!sameHandle(headRepository?.name, resource.giteaRepository) ||
			!sameHandle(getPayloadOwner(headRepository), resource.giteaOwner))
	) {
		return {
			status: 200,
			message:
				"Preview deployments are not supported for pull requests from forks",
		};
	}

	// SECURITY: preview deployments build and run pull request code on the
	// Dokploy host, so only *authors* with write access may trigger them — the
	// author, never the webhook actor, exactly like the GitHub and GitLab
	// handlers. Fails closed: anything unverifiable skips the deployment.
	if (resource.previewRequireCollaboratorPermissions !== false) {
		// The repository owner always has admin access, and Gitea only answers
		// the permission endpoint for repository admins, so short circuit here.
		const isRepositoryOwner = sameHandle(prAuthor, resource.giteaOwner);

		if (!isRepositoryOwner) {
			try {
				const { hasWriteAccess, permission, verified } =
					await checkPreviewAuthorPermissions(commentContext, prAuthor);

				if (!verified) {
					// Gitea refused to answer — this is a Dokploy side
					// misconfiguration, so do not blame the pull request author.
					console.error(
						`🚨 SECURITY: Could not verify permissions of ${prAuthor} on ${repositorySlug}; the Gitea account connected to Dokploy needs admin access on the repository. Skipping preview deployment for ${resource.name}.`,
					);
					return {
						status: 200,
						message:
							"Preview deployment skipped: the Gitea account connected to Dokploy cannot read collaborator permissions for this repository",
					};
				}

				if (!hasWriteAccess) {
					console.warn(
						`🚨 SECURITY: Blocked preview deployment for ${resource.name} from unauthorized user ${prAuthor} on ${repositorySlug}. Permission: ${permission || "none"}`,
					);
					await createPreviewSecurityBlockedComment(commentContext, {
						prNumber: Number.parseInt(`${prNumber}`),
						prAuthor,
						permission,
					});
					return {
						status: 200,
						message: "Preview deployment blocked: author lacks write access",
					};
				}

				console.log(
					`✅ SECURITY: Preview deployment authorized for ${resource.name} from user ${prAuthor} on ${repositorySlug}. Permission: ${permission}`,
				);
			} catch (error) {
				console.error(
					`Error validating PR author permissions for ${resource.name}:`,
					error,
				);
				return {
					status: 200,
					message:
						"Preview deployment blocked: author permissions unverifiable",
				};
			}
		}
	} else {
		console.warn(
			`⚠️  SECURITY: Preview deployment for ${resource.name} allows deployment from any PR author (security check disabled)`,
		);
	}

	if (resource.previewLabels && resource.previewLabels.length > 0) {
		const labels: { name?: string }[] = pullRequest?.labels ?? [];
		const hasLabel = labels.some(
			(label) => label?.name && resource.previewLabels?.includes(label.name),
		);

		if (!hasLabel) {
			return {
				status: 200,
				message: "Pull request does not carry any of the configured labels",
			};
		}
	}

	const existingPreview = await adapter.findExistingPreview(`${pullRequestId}`);

	let previewDeploymentId = existingPreview?.previewDeploymentId ?? "";
	let createdPreviewDeployment = false;

	if (!existingPreview) {
		if (!CREATE_ACTIONS.includes(action)) {
			return {
				status: 200,
				message: "No existing preview deployment to redeploy",
			};
		}

		// The limit only applies to new previews, existing ones must still be
		// redeployed when the pull request is updated.
		const previewLimit = resource.previewLimit ?? 3;
		if ((resource.previewDeployments?.length ?? 0) >= previewLimit) {
			console.warn(
				`⚠️ Preview deployment limit (${previewLimit}) reached for ${resource.name}, skipping preview for pull request #${prNumber}`,
			);
			return {
				status: 200,
				message: `Preview deployment limit (${previewLimit}) reached`,
			};
		}

		const previewDeployment = await adapter.createPreview({
			branch: pullRequest?.head?.ref,
			pullRequestId: `${pullRequestId}`,
			pullRequestNumber: `${prNumber}`,
			pullRequestTitle: pullRequest?.title,
			pullRequestURL: pullRequest?.html_url,
		});

		previewDeploymentId = previewDeployment.previewDeploymentId;
		createdPreviewDeployment = true;
	}

	if (!previewDeploymentId) {
		return { status: 200, message: "No preview deployment to deploy" };
	}

	if (!shouldDeployGiteaPreview({ action, createdPreviewDeployment })) {
		return {
			status: 200,
			message: `Pull request action '${action}' does not redeploy an existing preview`,
		};
	}

	return await queueDeployment(
		resource,
		adapter.buildJob({
			previewDeploymentId,
			descriptionLog: `Hash: ${pullRequest?.head?.sha ?? ""}`,
		}),
	);
};

export const handleGiteaApplicationPullRequestEvent = async ({
	application,
	body,
}: {
	application: PreviewApplication;
	body: any;
}): Promise<HandlerResult> =>
	await handleGiteaPullRequest(
		{
			resource: application,
			ownsPreviewDeployment: (previewDeployment) =>
				previewDeployment.applicationId === application.applicationId,
			findExistingPreview: (pullRequestId) =>
				findPreviewDeploymentByApplicationId(
					application.applicationId,
					pullRequestId,
				),
			createPreview: (input) =>
				createPreviewDeployment({
					applicationId: application.applicationId,
					...input,
				}),
			buildJob: ({ previewDeploymentId, descriptionLog }) => ({
				applicationId: application.applicationId,
				titleLog: "Preview Deployment",
				descriptionLog,
				type: "deploy",
				applicationType: "application-preview",
				server: !!application.serverId,
				previewDeploymentId,
			}),
		},
		body,
	);

export const handleGiteaComposePullRequestEvent = async ({
	compose,
	body,
}: {
	compose: PreviewCompose;
	body: any;
}): Promise<HandlerResult> =>
	await handleGiteaPullRequest(
		{
			resource: compose,
			ownsPreviewDeployment: (previewDeployment) =>
				previewDeployment.composeId === compose.composeId,
			findExistingPreview: (pullRequestId) =>
				findPreviewDeploymentByComposeId(compose.composeId, pullRequestId),
			createPreview: (input) =>
				createComposePreview({
					composeId: compose.composeId,
					...input,
				}),
			buildJob: ({ previewDeploymentId, descriptionLog }) => ({
				composeId: compose.composeId,
				titleLog: "Preview Deployment",
				descriptionLog,
				type: "deploy",
				applicationType: "compose-preview",
				server: !!compose.serverId,
				previewDeploymentId,
			}),
		},
		body,
	);
