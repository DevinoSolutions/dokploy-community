import { findRegistryByIdWithCredentials } from "@dokploy/server/services/registry";
import { quote } from "shell-quote";
import { getECRAuthToken } from "../aws/ecr";
import type { ApplicationNested } from "../builders";
import {
	dockerWithConfig,
	getRegistryConfigDir,
} from "../process/dockerConfig";
import { runDockerLogin } from "../process/dockerLogin";

export const buildRemoteDocker = async (
	application: ApplicationNested,
	serverId: string | null | undefined,
) => {
	const { registryUrl, dockerImage, username, password, registry } =
		application;

	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}
		let command = `
echo ${quote([`Pulling ${dockerImage}`])};
		`;

		// An attached registry logs in to its own docker config, so another
		// registry on the same URL cannot replace the login before the pull. The
		// service itself is created with the registry's authconfig, not this login.
		let configDir: string | undefined;

		// Handle ECR authentication
		if (registry?.registryType === "awsEcr") {
			const { password: ecrPassword } = await getECRAuthToken({
				awsAccessKeyId: registry.awsAccessKeyId || "",
				awsSecretAccessKey: registry.awsSecretAccessKey || "",
				awsRegion: registry.awsRegion || "",
			});
			// Logged in ahead of the script, on the host that will run it: the
			// token travels on stdin, never in the script's command line.
			configDir = getRegistryConfigDir(registry.registryId, !!serverId);
			await runDockerLogin(
				{
					registryType: "awsEcr",
					registryUrl: registry.registryUrl,
					ecrAuthPassword: ecrPassword,
					configDir,
				},
				serverId,
			);
		} else if (registry) {
			// Standard registry attached to the application: pull with its
			// stored credentials (loaded on demand because the fork excludes
			// registry passwords from relational queries).
			const r = await findRegistryByIdWithCredentials(registry.registryId);
			if (r.username && r.password) {
				configDir = getRegistryConfigDir(registry.registryId, !!serverId);
				await runDockerLogin(
					{
						configDir,
						registryType: registry.registryType ?? "cloud",
						registryUrl: r.registryUrl,
						username: r.username,
						password: r.password,
					},
					serverId,
				);
			}
		} else if (username && password) {
			await runDockerLogin(
				{ registryType: "cloud", registryUrl, username, password },
				serverId,
			);
		}

		command += `
${dockerWithConfig(configDir)} pull ${quote([dockerImage])} 2>&1 || {
  echo "❌ Pulling image failed";
  exit 1;
}

echo "✅ Pulling image completed.";
`;
		return command;
	} catch (error) {
		throw error;
	}
};
