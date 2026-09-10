import {
	// build-policy hook: enqueue-time gate and deploy-hook image body.
	buildPolicyDeployGate,
	deployHookBodyHasImage,
	IS_CLOUD,
	normalizeChangedFilesFromCommits,
	shouldDeploy,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { compose } from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	coalesceQueuedComposeDeploys,
	myQueue,
} from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import {
	handleGiteaComposePullRequestEvent,
	isGiteaPullRequestEvent,
} from "@/server/utils/gitea-preview";
import {
	extractBranchName,
	extractCommitMessage,
	extractCommittedPaths,
	extractHash,
	extractTagName,
	getProviderByHeader,
	logWebhookError,
} from "../[refreshToken]";

function isGitProviderWebhook(headers: NextApiRequest["headers"]): boolean {
	return (
		!!headers["x-github-event"] ||
		!!headers["x-gitlab-event"] ||
		!!headers["x-gitea-event"] ||
		!!headers["x-event-key"] // Bitbucket
	);
}

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { refreshToken } = req.query;
	try {
		if (req.headers["x-github-event"] === "ping") {
			res.status(200).json({ message: "Ping received, webhook is active" });
			return;
		}
		const composeResult = await db.query.compose.findFirst({
			where: eq(compose.refreshToken, refreshToken as string),
			with: {
				environment: {
					with: {
						project: true,
					},
				},
				bitbucket: true,
				previewDeployments: true,
			},
		});

		if (!composeResult) {
			res.status(404).json({ message: "Compose Not Found" });
			return;
		}

		// Preview deployments are driven by pull request events and are a separate
		// feature from push auto deployments, so they are handled before the
		// `autoDeploy` gate below.
		if (isGiteaPullRequestEvent(req.headers)) {
			if (composeResult.sourceType !== "gitea") {
				res.status(400).json({
					message:
						"Preview deployments require the Gitea source type, a custom Git URL cannot be used",
				});
				return;
			}

			const result = await handleGiteaComposePullRequestEvent({
				compose: composeResult,
				body: req.body,
			});
			res.status(result.status).json({ message: result.message });
			return;
		}

		const fromGitProvider = isGitProviderWebhook(req.headers);

		if (fromGitProvider && !composeResult?.autoDeploy) {
			res.status(400).json({
				message: "Automatic deployments are disabled for this compose",
			});
			return;
		}

		let deploymentTitle = extractCommitMessage(req.headers, req.body);
		const deploymentHash = extractHash(req.headers, req.body);
		const sourceType = composeResult.sourceType;

		if (sourceType === "github") {
			const tagName = extractTagName(req.headers, req.body);
			const isTagEvent = !!tagName;

			if (composeResult.triggerType === "tag") {
				if (!isTagEvent) {
					res.status(301).json({
						message: "Trigger type is 'tag'; ignoring non-tag push",
					});
					return;
				}
				// Tag event: deploy without branch/watchPaths checks (tags are not
				// branch-scoped and the UI hides watchPaths for the tag trigger).
				deploymentTitle = `Tag created: ${tagName}`;
			} else {
				if (isTagEvent) {
					res.status(301).json({
						message: "Trigger type is 'push'; ignoring tag event",
					});
					return;
				}

				const branchName = extractBranchName(req.headers, req.body);
				const normalizedCommits = normalizeChangedFilesFromCommits(
					req.body?.commits,
				);

				const shouldDeployPaths = shouldDeploy(
					composeResult.watchPaths,
					normalizedCommits,
				);

				if (!shouldDeployPaths) {
					res.status(301).json({ message: "Watch Paths Not Match" });
					return;
				}

				if (!branchName || branchName !== composeResult.branch) {
					res.status(301).json({ message: "Branch Not Match" });
					return;
				}
			}
		} else if (sourceType === "gitlab") {
			const branchName = extractBranchName(req.headers, req.body);
			const normalizedCommits = normalizeChangedFilesFromCommits(
				req.body?.commits,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
			if (!branchName || branchName !== composeResult.gitlabBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		} else if (sourceType === "bitbucket") {
			const branchName = extractBranchName(req.headers, req.body);
			if (!branchName || branchName !== composeResult.bitbucketBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}

			const committedPaths = await extractCommittedPaths(
				req.body,
				composeResult.bitbucket,
				composeResult.bitbucketRepositorySlug ||
					composeResult.bitbucketRepository ||
					"",
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				committedPaths,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
		} else if (sourceType === "git") {
			const branchName = extractBranchName(req.headers, req.body);
			if (!branchName || branchName !== composeResult.customGitBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
			const provider = getProviderByHeader(req.headers);
			let normalizedCommits: string[] = [];

			if (provider === "github") {
				normalizedCommits = normalizeChangedFilesFromCommits(req.body?.commits);
			} else if (provider === "gitlab") {
				normalizedCommits = normalizeChangedFilesFromCommits(req.body?.commits);
			} else if (provider === "gitea") {
				normalizedCommits = normalizeChangedFilesFromCommits(req.body?.commits);
			}

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
		} else if (sourceType === "gitea") {
			const branchName = extractBranchName(req.headers, req.body);

			const normalizedCommits = normalizeChangedFilesFromCommits(
				req.body?.commits,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}

			if (!branchName || branchName !== composeResult.giteaBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		}

		// >>> build-policy hook: `[skip deploy]`, derived watchPaths and queue
		// coalescing. A compose unit cannot deploy a supplied image by digest
		// yet (see README.md § Known gap), so such a body is rejected rather
		// than silently ignored.
		const gate = await buildPolicyDeployGate({
			unitType: "compose",
			unit: {
				unitId: composeResult.composeId,
				unitName: composeResult.name,
				environmentId: composeResult.environmentId,
				watchPaths: composeResult.watchPaths,
				composePath: composeResult.composePath,
			},
			commitMessage: deploymentTitle,
			removeWaiting: () =>
				coalesceQueuedComposeDeploys(composeResult.composeId),
		});
		if (!gate.deploy) {
			res.status(301).json({ message: gate.message });
			return;
		}
		if (deployHookBodyHasImage(req.body)) {
			res.status(400).json({
				message:
					"Deploying a supplied image by digest is not supported for compose units.",
			});
			return;
		}
		// <<< build-policy hook

		try {
			const jobData: DeploymentJob = {
				composeId: composeResult.composeId as string,
				titleLog: deploymentTitle,
				type: "deploy",
				applicationType: "compose",
				descriptionLog: `Hash: ${deploymentHash}`,
				server: !!composeResult.serverId,
			};

			if (IS_CLOUD && composeResult.serverId) {
				jobData.serverId = composeResult.serverId;
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
			} else {
				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
					},
				);
			}
		} catch (error) {
			logWebhookError("Error deploying Compose:", error);
			res.status(400).json({ message: "Error deploying Compose" });
			return;
		}

		res.status(200).json({ message: "Compose deployed successfully" });
	} catch (error) {
		logWebhookError("Error deploying Compose:", error);
		res.status(400).json({ message: "Error deploying Compose" });
	}
}
