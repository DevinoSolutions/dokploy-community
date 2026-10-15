import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Compose } from "@dokploy/server/services/compose";
import { quote } from "shell-quote";
import {
	getInstallStagedFileCommand,
	getStagedFilePath,
	type StageOptions,
	stageFiles,
} from "../docker/staging";

/**
 * Shell snippet that writes a raw compose's source into `code/`. The source is
 * staged out of band (see `utils/docker/staging`): embedded in the script it
 * failed with "Argument list too long" past ~96 KB. The staged file sits next
 * to `code/`, which the snippet wipes first.
 */
export const getCreateComposeFileCommand = async (
	compose: Compose,
	options: StageOptions = {},
) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName, composeFile } = compose;
	const appPath = join(COMPOSE_PATH, appName);
	const outputPath = join(appPath, "code");
	const filePath = join(outputPath, "docker-compose.yml");

	const stagedPath = getStagedFilePath({
		directory: appPath,
		kind: "raw",
		deploymentId: options.deploymentId,
	});
	await stageFiles({
		serverId: compose.serverId,
		directory: appPath,
		files: [{ path: stagedPath, content: composeFile }],
	});
	options.onStaged?.([stagedPath]);

	return `
		${getInstallStagedFileCommand({
			staged: stagedPath,
			destination: filePath,
			failureMessage: "❌ Error: Could not write the compose file",
			prepare: `rm -rf ${quote([outputPath])} && mkdir -p ${quote([outputPath])}`,
		})}
		echo "File 'docker-compose.yml' created: ✅";
	`;
};
