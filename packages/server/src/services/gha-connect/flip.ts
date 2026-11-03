import { deploySourceTypeOf } from "./deploy-source";

/**
 * The flip: the one change a connection makes to a service, at the moment its
 * first release arrives (never at Connect). Pure planning; the poller applies
 * the result inside the transaction that starts the deploy.
 *
 * Application: git source -> Docker image source at the release digest. The
 * old git settings are kept whole in `previousSource` so "Take over locally"
 * can restore them, and git autodeploy is turned off so only one deployer can
 * fire. A service that already deploys an image is not flipped.
 *
 * Compose: only a compose whose file is stored in Dokploy (raw) is connected
 * in phase 1; there is nothing to flip.
 */

/** Everything that describes where an application's code comes from. */
export const APPLICATION_SOURCE_FIELDS = [
	"sourceType",
	"autoDeploy",
	"triggerType",
	"repository",
	"branch",
	"owner",
	"buildPath",
	"githubId",
	"gitlabRepository",
	"gitlabOwner",
	"gitlabBranch",
	"gitlabBuildPath",
	"gitlabId",
	"gitlabProjectId",
	"gitlabPathNamespace",
	"bitbucketRepository",
	"bitbucketOwner",
	"bitbucketBranch",
	"bitbucketBuildPath",
	"bitbucketId",
	"giteaRepository",
	"giteaOwner",
	"giteaBranch",
	"giteaBuildPath",
	"giteaId",
	"customGitBranch",
	"customGitBuildPath",
	"customGitUrl",
	"customGitSSHKeyId",
	"watchPaths",
	"enableSubmodules",
	"dockerImage",
	"registryId",
	"username",
	"password",
	"registryUrl",
] as const;
export type ApplicationSourceField = (typeof APPLICATION_SOURCE_FIELDS)[number];

/** What `disconnectGitProvider` writes, minus the source type (the flip sets its own). */
export const APPLICATION_GIT_RESET = {
	repository: null,
	branch: null,
	owner: null,
	buildPath: "/",
	githubId: null,
	triggerType: "push",
	gitlabRepository: null,
	gitlabOwner: null,
	gitlabBranch: null,
	gitlabBuildPath: null,
	gitlabId: null,
	gitlabProjectId: null,
	gitlabPathNamespace: null,
	bitbucketRepository: null,
	bitbucketOwner: null,
	bitbucketBranch: null,
	bitbucketBuildPath: null,
	bitbucketId: null,
	giteaRepository: null,
	giteaOwner: null,
	giteaBranch: null,
	giteaBuildPath: null,
	giteaId: null,
	customGitBranch: null,
	customGitBuildPath: null,
	customGitUrl: null,
	customGitSSHKeyId: null,
	watchPaths: null,
	enableSubmodules: false,
} as const;

export type PreviousSource = Partial<Record<ApplicationSourceField, unknown>>;

/**
 * A copy of the source settings. The registry password is not kept: the flip
 * does not touch registry credentials, so there is nothing to restore.
 */
export const snapshotPreviousSource = (
	application: Partial<Record<ApplicationSourceField, unknown>>,
): PreviousSource => {
	const snapshot: PreviousSource = {};
	for (const field of APPLICATION_SOURCE_FIELDS) {
		if (field === "password") continue;
		if (application[field] !== undefined) snapshot[field] = application[field];
	}
	return snapshot;
};

export type FlipPlan =
	| { flip: false }
	| {
			flip: true;
			previousSource: PreviousSource;
			update: Record<string, unknown>;
	  };

export const planApplicationFlip = (
	application: Partial<Record<ApplicationSourceField, unknown>>,
	dockerImage: string,
): FlipPlan => {
	// A service already on an image (or on the GitHub Actions provider, which deploys as one) is not flipped.
	if (deploySourceTypeOf(application, "application") === "docker") {
		return { flip: false };
	}
	return {
		flip: true,
		previousSource: snapshotPreviousSource(application),
		update: {
			...APPLICATION_GIT_RESET,
			sourceType: "docker",
			dockerImage,
			autoDeploy: false,
			isPreviewDeploymentsActive: false,
		},
	};
};
