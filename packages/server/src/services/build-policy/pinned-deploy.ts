import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import {
	encodeBase64,
	waitForSwarmServiceStable,
} from "@dokploy/server/utils/docker/utils";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getDokployUrl } from "../admin";
import { findApplicationById, updateApplicationStatus } from "../application";
import {
	createDeployment,
	updateDeployment,
	updateDeploymentStatus,
} from "../deployment";
import { findAllRegistryByOrganizationId } from "../registry";
import { registryForAuth } from "./apply";
import { recordBuildPolicyAudit } from "./audit";
import { waitForUnitRequiredChecks } from "./github-checks";
import type { DeployHookImage } from "./hook-body";
import { registryHostOf } from "./image";
import { findBuildPolicySettings, requiredChecksTimeoutMs } from "./settings";

/**
 * Deploy an image supplied in a deploy-hook body (spec 5.2.9), with no build.
 *
 * This is a whole deploy of its own rather than a branch inside
 * `deployApplication`, so the upstream deploy path keeps one added line and an
 * upstream merge has nothing to reconcile here.
 */
export const deployPinnedApplicationImage = async ({
	applicationId,
	pinnedImage,
	titleLog = "Deploy hook image",
	descriptionLog = "",
	skipRequiredChecks = false,
	introLog = "Deploy hook supplied an image; skipping the build.",
}: {
	applicationId: string;
	pinnedImage: { ref: string; tag: string | null; digest: string };
	titleLog?: string;
	descriptionLog?: string;
	/**
	 * A rollback restores an image that already shipped, so it must not be held
	 * behind CI: waiting on checks is the one thing a rollback cannot afford.
	 */
	skipRequiredChecks?: boolean;
	/** First line of the deployment log, saying why there is no build. */
	introLog?: string;
}) => {
	const application = await findApplicationById(applicationId);
	const organizationId = application.environment.project.organizationId;
	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;

	const deployment = await createDeployment({
		applicationId,
		title: titleLog,
		description: descriptionLog,
	});

	const log = async (message: string) => {
		const command = `echo "${encodeBase64(message)}" | base64 -d >> "${deployment.logPath}";`;
		if (application.serverId) {
			await execAsyncRemote(application.serverId, command);
		} else {
			await execAsync(command);
		}
	};

	try {
		await log(
			`📦 [build-policy] ${introLog}\n` +
				`   image:  ${pinnedImage.tag ?? pinnedImage.ref}\n` +
				`   digest: ${pinnedImage.digest}\n`,
		);

		if (!skipRequiredChecks) {
			await waitForUnitRequiredChecks({
				unit: {
					unitType: "application",
					unitId: application.applicationId,
					unitName: application.name,
					organizationId,
					requiredChecks: application.requiredChecks,
					sourceType: application.sourceType,
					githubId: application.githubId,
					owner: application.owner,
					repository: application.repository,
					customGitUrl: application.customGitUrl,
				},
				sha: pinnedImage.tag,
				timeoutMs: requiredChecksTimeoutMs(
					await findBuildPolicySettings(organizationId),
				),
			});
		}

		await updateDeployment(deployment.deploymentId, {
			imageTag: pinnedImage.tag,
			imageDigest: pinnedImage.digest,
		});

		// Finding D: the registry the digest actually lives on is authoritative
		// for this deploy, so `registry` is nulled rather than left to win the
		// `else if` chain in `getAuthConfig`. See `authForPublishedRegistry`.
		const pullRegistry = await findRegistryForHost(
			organizationId,
			pinnedImage.ref,
		);
		await mechanizeDockerContainer({
			...application,
			buildPolicyImage: pinnedImage.ref,
			...(pullRegistry
				? { registry: null, buildRegistry: pullRegistry }
				: { buildRegistry: application.buildRegistry ?? null }),
		});

		const stability = await waitForSwarmServiceStable(application.appName, {
			serverId: application.serverId,
		});
		if (!stability.stable) {
			throw new Error(
				`Container did not stay running after deployment: ${stability.reason}`,
			);
		}

		await recordBuildPolicyAudit({
			organizationId,
			action: "deploy_by_digest",
			applicationId,
			reason: "deploy hook supplied the image",
			metadata: {
				unitName: application.name,
				imageTag: pinnedImage.tag,
				imageDigest: pinnedImage.digest,
			},
		});

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");
		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await log(`\n❌ [build-policy] ${message}\n`).catch(() => {});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");
		await sendBuildErrorNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			errorMessage: message,
			buildLink,
			organizationId,
		}).catch(() => {});
		throw error;
	}

	return true;
};

/**
 * The deploy host needs credentials to pull the digest. Match the image's host
 * against the organization's registries.
 */
const findRegistryForHost = async (organizationId: string, ref: string) => {
	const host = registryHostOf(ref);
	if (!host) return null;
	const registries = await findAllRegistryByOrganizationId(organizationId);
	const match = registries.find((r) => r.registryUrl === host);
	return match ? await registryForAuth(match.registryId) : null;
};

/** Narrow a validated hook body to the shape the queue job carries. */
export const toPinnedImageJob = (parsed: DeployHookImage) =>
	parsed.kind === "image"
		? { ref: parsed.ref, tag: parsed.tag, digest: parsed.digest }
		: undefined;
