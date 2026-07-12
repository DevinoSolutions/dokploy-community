import {
	findRegistryByIdWithCredentials,
	safeDockerLoginCommand,
} from "@dokploy/server/services/registry";
import type { ApplicationNested } from "../builders";

export const buildRemoteDocker = async (application: ApplicationNested) => {
	const { registry, registryUrl, dockerImage, username, password } =
		application;

	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}

		let loginUsername = username;
		let loginPassword = password;
		let loginRegistryUrl = registryUrl;
		if (registry) {
			const r = await findRegistryByIdWithCredentials(registry.registryId);
			loginUsername = r.username;
			loginPassword = r.password;
			loginRegistryUrl = r.registryUrl;
		}

		let command = `
echo "Pulling ${dockerImage}";
		`;

		if (loginUsername && loginPassword) {
			command += `
if ! ${safeDockerLoginCommand(loginRegistryUrl || "", loginUsername, loginPassword)} 2>&1; then
	echo "❌ Login failed";
	exit 1;
fi
`;
		}

		command += `
docker pull ${dockerImage} 2>&1 || { 
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
