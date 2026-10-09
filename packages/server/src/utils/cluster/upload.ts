import { findAllDeploymentsByApplicationId } from "@dokploy/server/services/deployment";
import {
	findRegistryByIdWithCredentials,
	type Registry,
} from "@dokploy/server/services/registry";
import { createRollback } from "@dokploy/server/services/rollbacks";
import {
	dockerWithConfig,
	getRegistryConfigDir,
} from "@dokploy/server/utils/process/dockerConfig";
import {
	type LoginCancelable,
	runDockerLogin,
} from "@dokploy/server/utils/process/dockerLogin";
import { quote } from "shell-quote";
import { getECRAuthToken } from "../aws/ecr";
import type { ApplicationNested } from "../builders";

export const uploadImageRemoteCommand = async (
	application: ApplicationNested,
	serverId: string | null | undefined,
) => {
	const registry = application.registry;
	const buildRegistry = application.buildRegistry;
	const rollbackRegistry = application.rollbackRegistry;

	if (!registry && !buildRegistry && !rollbackRegistry) {
		throw new Error("No registry found");
	}

	const { appName } = application;
	const imageName =
		application.sourceType === "docker"
			? application.dockerImage || ""
			: `${appName}:latest`;

	const commands: string[] = [];
	if (registry) {
		const r = await findRegistryByIdWithCredentials(registry.registryId);
		const registryTag = getRegistryTag(r, imageName);
		if (registryTag) {
			commands.push(`echo "📦 [Enabled Registry Swarm]"`);
			commands.push(
				await getRegistryCommands(r, imageName, registryTag, serverId, false),
			);
		}
	}
	if (buildRegistry) {
		const r = await findRegistryByIdWithCredentials(buildRegistry.registryId);
		const buildRegistryTag = getRegistryTag(r, imageName);
		if (buildRegistryTag) {
			commands.push(`echo "🔑 [Enabled Build Registry]"`);
			commands.push(
				await getRegistryCommands(
					r,
					imageName,
					buildRegistryTag,
					serverId,
					true,
				),
			);
			commands.push(
				`echo "⚠️ INFO: After the build is finished, you need to wait a few seconds for the server to download the image and run the container."`,
			);
			commands.push(
				`echo "📊 Check the Logs tab to see when the container starts running."`,
			);
		}
	}

	if (rollbackRegistry && application.rollbackActive) {
		const deployment = await findAllDeploymentsByApplicationId(
			application.applicationId,
		);
		if (!deployment || !deployment[0]) {
			throw new Error("Deployment not found");
		}
		const deploymentId = deployment[0].deploymentId;
		const rollback = await createRollback({
			appName: appName,
			deploymentId: deploymentId,
		});

		const r = await findRegistryByIdWithCredentials(
			rollbackRegistry.registryId,
		);
		const rollbackRegistryTag = getRegistryTag(r, rollback?.image || "");
		if (rollbackRegistryTag) {
			commands.push(`echo "🔄 [Enabled Rollback Registry]"`);
			commands.push(
				await getRegistryCommands(
					r,
					imageName,
					rollbackRegistryTag,
					serverId,
					true,
				),
			);
		}
	}
	try {
		return commands.join("\n");
	} catch (error) {
		throw error;
	}
};

/**
 * Extract the repository name from imageName by taking the last part after '/'
 * Examples:
 * - "nginx" -> "nginx"
 * - "nginx:latest" -> "nginx:latest"
 * - "myuser/myrepo" -> "myrepo"
 * - "myuser/myrepo:tag" -> "myrepo:tag"
 * - "docker.io/myuser/myrepo" -> "myrepo"
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");

	// If no '/', return the imageName as is
	if (lastSlashIndex === -1) {
		return imageName;
	}

	// Extract everything after the last '/'
	return imageName.substring(lastSlashIndex + 1);
};

export const getRegistryTag = (registry: Registry, imageName: string) => {
	const { registryUrl, imagePrefix, username, registryType } = registry;
	const finalRegistry = registryUrl || "";

	if (registryType === "awsEcr" && finalRegistry) {
		// For ECR, preserve the full repo path (e.g. "myorg/backend:latest").
		// Strip only the registry hostname prefix if already present; otherwise
		// keep the entire imageName so multi-segment paths are not truncated.
		const withoutHost = imageName.startsWith(`${finalRegistry}/`)
			? imageName.slice(finalRegistry.length + 1)
			: imageName;
		return `${finalRegistry}/${withoutHost}`;
	}

	// For non-ECR registries, keep the fork's layout: lowercased username/prefix
	// and a trailing slash preserved for empty image names.
	const repositoryName = extractRepositoryName(imageName);
	const targetPrefix = (imagePrefix || username).toLowerCase();
	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}`
		: `${targetPrefix}/${repositoryName}`;
};

/**
 * Logs docker in to `registry` on `serverId` (this host without one), fetching
 * a fresh auth token for ECR. It runs as its own command, ahead of the script
 * that pushes or pulls, so the password travels on stdin and never lands in a
 * command line.
 *
 * With `isolated` the login goes to the registry's own docker config directory
 * and that directory is returned: the script must then run `docker --config
 * <dir>` (see dockerWithConfig). Registries on one URL with different accounts
 * then no longer replace each other's login. Without it the login goes to the
 * host's default config, which is what `stack deploy --with-registry-auth` and
 * `service update --with-registry-auth` read.
 * Shared by the application upload and the compose build server flow.
 */
export const loginDockerRegistry = async (
	registry: Registry,
	serverId: string | null | undefined,
	options?: { isolated?: boolean; cancelable?: LoginCancelable },
): Promise<string | undefined> => {
	let ecrAuthPassword: string | undefined;
	if (registry.registryType === "awsEcr") {
		const token = await getECRAuthToken({
			awsAccessKeyId: registry.awsAccessKeyId || "",
			awsSecretAccessKey: registry.awsSecretAccessKey || "",
			awsRegion: registry.awsRegion || "",
		});
		ecrAuthPassword = token.password;
	}

	const configDir = options?.isolated
		? getRegistryConfigDir(registry.registryId, !!serverId)
		: undefined;
	await runDockerLogin(
		{
			registryType: registry.registryType,
			registryUrl: registry.registryUrl,
			username: registry.username,
			password: registry.password,
			ecrAuthPassword,
			configDir,
		},
		serverId,
		{ cancelable: options?.cancelable },
	);
	return configDir;
};

/**
 * The deploy registry logs in to the host's default config, which the swarm
 * deploy reads; the build and rollback registries get their own config, so
 * they cannot replace its login (or each other's) when they share a URL.
 */
const getRegistryCommands = async (
	registry: Registry,
	imageName: string,
	registryTag: string,
	serverId: string | null | undefined,
	isolated: boolean,
): Promise<string> => {
	const configDir = await loginDockerRegistry(registry, serverId, { isolated });

	return `
echo ${quote([`📦 [Enabled Registry] Uploading image to '${registry.registryType}' | '${registryTag}'`])} ;
echo "✅ Registry Login Success" ;
docker tag ${quote([imageName])} ${quote([registryTag])} || {
	echo "❌ Error tagging image" ;
	exit 1;
}
echo "✅ Image Tagged" ;
${dockerWithConfig(configDir)} push ${quote([registryTag])} || {
	echo "❌ Error pushing image" ;
	exit 1;
}
	echo "✅ Image Pushed" ;
`;
};
