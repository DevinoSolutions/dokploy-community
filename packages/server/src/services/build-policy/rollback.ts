import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { recordBuildPolicyAudit } from "./audit";
import { BuildPolicyError } from "./errors";
import {
	assertSafeImageReference,
	buildDigestRef,
	isValidDigest,
} from "./image";
import { deployPinnedApplicationImage } from "./pinned-deploy";

/**
 * Rollback by stored digest (spec 5.2.4).
 *
 * Every enforced deploy writes `imageTag` and `imageDigest` onto its deployment
 * row, so any past deployment can be put back with a pull and a service update
 * and no build at all.
 *
 * This is deliberately separate from upstream's rollback
 * (`services/rollbacks.ts`), which replays a snapshot of `<appName>:latest`
 * pushed to a dedicated rollback registry and only exists for units that have
 * `rollbackActive`. A unit with enforcement on has a usable digest on every
 * deployment row whether or not it has a rollback registry, and this path uses
 * that. Neither path touches the other.
 *
 * Required checks are not re-run: the commit being restored already shipped,
 * and a rollback is the one moment a team cannot afford to wait on CI.
 */
export interface RollbackTarget {
	deploymentId: string;
	applicationId: string;
	imageTag: string | null;
	imageDigest: string | null;
}

/** The digest reference a deployment row can be restored to, or an error. */
export const digestRefForRollback = (
	deployment: RollbackTarget,
): { ref: string; tag: string | null; digest: string } => {
	if (!deployment.imageDigest || !isValidDigest(deployment.imageDigest)) {
		throw new BuildPolicyError(
			"DIGEST_NOT_PUBLISHED",
			"That deployment stored no image digest, so there is nothing to roll " +
				"back to. Only deploys made while the build policy was enforcing " +
				"store one.",
			{ deploymentId: deployment.deploymentId },
		);
	}
	if (!deployment.imageTag) {
		throw new BuildPolicyError(
			"DIGEST_NOT_PUBLISHED",
			"That deployment stored a digest but no image tag, so the repository to " +
				"pull it from is unknown.",
			{ deploymentId: deployment.deploymentId },
		);
	}
	assertSafeImageReference(deployment.imageTag);
	return {
		ref: buildDigestRef(deployment.imageTag, deployment.imageDigest),
		tag: deployment.imageTag,
		digest: deployment.imageDigest,
	};
};

export const findRollbackTarget = async (
	deploymentId: string,
): Promise<RollbackTarget> => {
	const deployment = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, deploymentId),
		columns: {
			deploymentId: true,
			applicationId: true,
			imageTag: true,
			imageDigest: true,
		},
	});
	if (!deployment?.applicationId) {
		throw new BuildPolicyError(
			"DIGEST_NOT_PUBLISHED",
			"No application deployment with that id.",
			{ deploymentId },
		);
	}
	return deployment as RollbackTarget;
};

export const rollbackToDeploymentDigest = async ({
	deploymentId,
	organizationId,
}: {
	deploymentId: string;
	organizationId: string;
}) => {
	const target = await findRollbackTarget(deploymentId);
	const pinnedImage = digestRefForRollback(target);

	await recordBuildPolicyAudit({
		organizationId,
		action: "deploy_by_digest",
		applicationId: target.applicationId,
		reason: `rollback to deployment ${deploymentId}`,
		metadata: {
			rolledBackToDeploymentId: deploymentId,
			imageTag: pinnedImage.tag,
			imageDigest: pinnedImage.digest,
		},
	});

	return deployPinnedApplicationImage({
		applicationId: target.applicationId,
		pinnedImage,
		titleLog: "Rollback to a stored digest",
		descriptionLog: `Restoring the image deployment ${deploymentId} published.`,
		skipRequiredChecks: true,
		introLog: "Rolling back to a stored digest; there is no build.",
	});
};
