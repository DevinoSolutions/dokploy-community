import { posix } from "node:path";
import { paths } from "@dokploy/server/constants";
import { getSafeRegistryLoginCommand } from "@dokploy/server/db/schema";
import { getECRAuthToken } from "@dokploy/server/utils/aws/ecr";
import { getRegistryTag } from "@dokploy/server/utils/cluster/upload";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getGitCommitInfo } from "@dokploy/server/utils/providers/git";
import { quote } from "shell-quote";
import { updateDeployment } from "../deployment";
import { findRegistryByIdWithCredentials } from "../registry";
import { recordBuildPolicyAudit } from "./audit";
import { BuildPolicyError } from "./errors";
import { waitForUnitRequiredChecks } from "./github-checks";
import {
	DIGEST_MARKER,
	buildDigestRef,
	parseImageDigestFromLog,
	parseImageTagFromLog,
} from "./image";
import type { BuildPolicyDecision } from "./policy";
import { assertBuildPolicyOk, resolveBuildPolicy } from "./resolve";
import { findBuildPolicySettings, requiredChecksTimeoutMs } from "./settings";

/**
 * The deploy-path entry point for applications.
 *
 * `planApplicationBuild` is called once at the top of a deploy; everything the
 * deploy path needs afterwards is on the returned plan, so the upstream hook
 * points stay one or two lines each.
 */
export interface BuildPolicyPlan {
	/** Whether this deploy is pinned to the org build server. */
	enforced: boolean;
	/** Why not, when it is not enforced. Useful in logs and tests. */
	reason?: string;
	/** Build server to run the build on, or null to leave upstream alone. */
	buildServerId: string | null;
	/** Registry the image is pushed to and pulled from, when enforced. */
	registryId: string | null;
	/** Full repository reference (`host/prefix/app`) the sha tag hangs off. */
	repository: string | null;
}

interface PlanUnit {
	unitId: string;
	unitName: string;
	appName: string;
	organizationId: string;
	sourceType: string;
	customGitUrl?: string | null;
	buildServerId?: string | null;
	buildRegistryId?: string | null;
}

/**
 * The registry object `getAuthConfig` expects on `application.buildRegistry`:
 * every column except the password, which it re-reads itself. ECR needs
 * `awsSecretAccessKey` present, so `findRegistryById` is not enough.
 */
export const registryForAuth = async (registryId: string) => {
	const { password, ...rest } =
		await findRegistryByIdWithCredentials(registryId);
	return rest;
};

const LOCAL_PLAN = (reason: string): BuildPolicyPlan => ({
	enforced: false,
	reason,
	buildServerId: null,
	registryId: null,
	repository: null,
});

/**
 * Adapter from a loaded application row to the policy input, so the upstream
 * call sites never have to know which fields the policy reads.
 */
export const toBuildPolicyUnit = (application: {
	applicationId: string;
	appName: string;
	name: string;
	sourceType: string;
	customGitUrl?: string | null;
	buildServerId?: string | null;
	buildRegistryId?: string | null;
	environment: { project: { organizationId: string } };
}): PlanUnit => ({
	unitId: application.applicationId,
	unitName: application.name,
	appName: application.appName,
	organizationId: application.environment.project.organizationId,
	sourceType: application.sourceType,
	customGitUrl: application.customGitUrl,
	buildServerId: application.buildServerId,
	buildRegistryId: application.buildRegistryId,
});

export const planApplicationBuild = async (
	unit: PlanUnit,
): Promise<BuildPolicyPlan> => {
	const { decision } = await resolveBuildPolicy({
		unitType: "application",
		unitId: unit.unitId,
		unitName: unit.unitName,
		organizationId: unit.organizationId,
		sourceType: unit.sourceType,
		customGitUrl: unit.customGitUrl,
		buildServerId: unit.buildServerId,
		buildRegistryId: unit.buildRegistryId,
	});

	const ok = assertBuildPolicyOk(decision) as Exclude<
		BuildPolicyDecision,
		{ mode: "error" }
	>;

	if (ok.mode === "local") {
		return LOCAL_PLAN(ok.reason);
	}

	const registry = await findRegistryByIdWithCredentials(ok.registryId);
	return {
		enforced: true,
		buildServerId: ok.buildServerId,
		registryId: ok.registryId,
		repository: getRegistryTag(registry, unit.appName),
	};
};

/**
 * Shell appended to the build command, on the build server, after the image has
 * been built. Tags `<repository>:<sha>`, pushes, and echoes the resulting
 * digest so the deploy step can pin it.
 *
 * The sha is resolved in the shell (`git rev-parse HEAD`) rather than passed
 * in, because a manual redeploy has no webhook payload to read it from.
 */
export const getBuildPolicyPushCommand = async (
	plan: BuildPolicyPlan,
	{ appName, serverId }: { appName: string; serverId: string | null },
): Promise<string> => {
	if (!plan.enforced || !plan.registryId || !plan.repository) return "";

	const registry = await findRegistryByIdWithCredentials(plan.registryId);
	let ecrAuthPassword: string | undefined;
	if (registry.registryType === "awsEcr") {
		const token = await getECRAuthToken({
			awsAccessKeyId: registry.awsAccessKeyId || "",
			awsSecretAccessKey: registry.awsSecretAccessKey || "",
			awsRegion: registry.awsRegion || "",
		});
		ecrAuthPassword = token.password;
	}
	const loginCommand = getSafeRegistryLoginCommand({
		registryType: registry.registryType,
		registryUrl: registry.registryUrl,
		username: registry.username,
		password: registry.password,
		ecrAuthPassword,
	});

	const { APPLICATIONS_PATH } = paths(!!serverId);
	// posix.join: the shell always runs on the Linux build host, so the path
	// must use forward slashes even when Dokploy itself runs on Windows.
	const codeDir = posix.join(APPLICATIONS_PATH, appName, "code");
	const repository = plan.repository;

	return `
echo ${quote([`🏷️  [build-policy] Publishing ${repository}:<sha> to the organization registry`])} ;
DOKPLOY_BP_SHA=$(git -C ${quote([codeDir])} rev-parse HEAD 2>/dev/null || echo "") ;
if [ -z "$DOKPLOY_BP_SHA" ]; then
	echo "❌ [build-policy] Could not resolve the commit sha, so the image cannot be tagged by sha" ;
	exit 1;
fi
DOKPLOY_BP_TAG=${quote([repository])}:"$DOKPLOY_BP_SHA" ;
${loginCommand} || {
	echo "❌ [build-policy] Registry login failed" ;
	exit 1;
}
docker tag ${quote([`${appName}:latest`])} "$DOKPLOY_BP_TAG" || {
	echo "❌ [build-policy] Tagging the image by sha failed" ;
	exit 1;
}
docker push "$DOKPLOY_BP_TAG" || {
	echo "❌ [build-policy] Pushing the image to the organization registry failed" ;
	exit 1;
}
DOKPLOY_BP_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$DOKPLOY_BP_TAG" | grep -F ${quote([`${repository}@`])} | head -n1 | cut -d@ -f2) ;
if [ -z "$DOKPLOY_BP_DIGEST" ]; then
	echo "❌ [build-policy] Could not read the digest of the pushed image" ;
	exit 1;
fi
echo "${DIGEST_MARKER} $DOKPLOY_BP_TAG $DOKPLOY_BP_DIGEST" ;
echo "✅ [build-policy] Pushed $DOKPLOY_BP_TAG@$DOKPLOY_BP_DIGEST" ;
`;
};

export interface PublishedImage {
	tag: string;
	digest: string;
	/** `repository@sha256:…` — what the swarm service is pinned to. */
	ref: string;
}

/**
 * Reads back the digest the build shell echoed. The build runs detached on the
 * build server, so the deployment log is the only channel it has.
 */
export const readPublishedImage = async ({
	logPath,
	serverId,
}: {
	logPath: string;
	serverId: string | null;
}): Promise<PublishedImage | null> => {
	const command = `grep -F ${quote([DIGEST_MARKER])} ${quote([logPath])} | tail -n 1`;
	let stdout = "";
	try {
		const result = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		stdout = result.stdout ?? "";
	} catch (error) {
		// `grep` exits 1 when it matches nothing; that is "no digest", not a crash.
		console.error("[build-policy] could not read the published digest", error);
		return null;
	}

	const tag = parseImageTagFromLog(stdout);
	const digest = parseImageDigestFromLog(stdout);
	if (!tag || !digest) return null;
	return { tag, digest, ref: buildDigestRef(tag, digest) };
};

/**
 * The whole post-build half of an enforced deploy: read the digest, refuse to
 * continue without one, and audit the pin.
 */
export const requirePublishedImage = async ({
	plan,
	logPath,
	serverId,
	organizationId,
	applicationId,
	unitName,
}: {
	plan: BuildPolicyPlan;
	logPath: string;
	serverId: string | null;
	organizationId: string;
	applicationId: string;
	unitName: string;
}): Promise<PublishedImage> => {
	const published = await readPublishedImage({ logPath, serverId });
	if (!published) {
		throw new BuildPolicyError(
			"DIGEST_NOT_PUBLISHED",
			"The remote build finished but published no image digest, so the deploy " +
				"cannot be pinned. Check the build log for the registry push step.",
			{ applicationId, repository: plan.repository },
		);
	}

	await recordBuildPolicyAudit({
		organizationId,
		action: "deploy_by_digest",
		applicationId,
		metadata: {
			unitName,
			imageTag: published.tag,
			imageDigest: published.digest,
		},
	});

	return published;
};

/**
 * Everything an enforced deploy does between "the build finished" and "update
 * the swarm service": gate on required checks, read the published digest, store
 * it on the deployment record, and hand back the application object the deploy
 * step should use.
 *
 * Returns the application unchanged when the policy is not enforcing, so the
 * upstream call site is a single assignment either way.
 */
export const prepareBuildPolicyDeploy = async <
	T extends {
		applicationId: string;
		appName: string;
		name: string;
		sourceType: string;
		owner?: string | null;
		repository?: string | null;
		customGitUrl?: string | null;
		githubId?: string | null;
		requiredChecks?: string[] | null;
		buildRegistry?: unknown;
		environment: { project: { organizationId: string } };
	},
>({
	application,
	plan,
	deployment,
	serverId,
}: {
	application: T;
	plan: BuildPolicyPlan;
	deployment: { deploymentId: string; logPath: string };
	serverId: string | null;
}): Promise<T & { buildPolicyImage?: string | null }> => {
	const organizationId = application.environment.project.organizationId;

	const published = plan.enforced
		? await requirePublishedImage({
				plan,
				logPath: deployment.logPath,
				serverId,
				organizationId,
				applicationId: application.applicationId,
				unitName: application.name,
			})
		: null;

	// Gate on required checks before the deploy step. The sha comes from the tag
	// the build just published when there is one, otherwise from the checkout.
	const sha =
		published?.tag.split(":").pop() ??
		(
			await getGitCommitInfo({
				appName: application.appName,
				type: "application",
				serverId,
			})
		)?.hash ??
		null;

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
		sha,
		timeoutMs: requiredChecksTimeoutMs(
			await findBuildPolicySettings(organizationId),
		),
	});

	if (!published) return application;

	await updateDeployment(deployment.deploymentId, {
		imageTag: published.tag,
		imageDigest: published.digest,
	});

	return {
		...application,
		buildPolicyImage: published.ref,
		// The deploy host has to authenticate to pull the digest. When the unit
		// itself has no registry configured, borrow the org one for auth only.
		buildRegistry:
			application.buildRegistry ??
			(plan.registryId ? await registryForAuth(plan.registryId) : null),
	};
};
