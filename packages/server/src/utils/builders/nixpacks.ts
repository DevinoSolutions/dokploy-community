import path from "node:path";
import { getStaticCommand } from "@dokploy/server/utils/builders/static";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import { prepareEnvironmentVariables } from "../docker/utils";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";
import {
	type BuildStageOptions,
	getCommitInfoEnvArgs,
	getEnvFlagArgs,
	getGitCommitInfoCommands,
	stageBuildVariables,
} from "./utils";

export const getNixpacksCommand = async (
	application: ApplicationNested,
	stageOptions: BuildStageOptions = {},
) => {
	const { env, appName, publishDirectory, cleanCache } = application;

	const buildAppDirectory = getBuildAppDirectory(application);
	const buildContainerId = `${appName}-${nanoid(10)}`;
	const envVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	);

	const args = ["build", buildAppDirectory, "--name", appName];

	if (cleanCache) {
		args.push("--no-cache");
	}

	// The values go to nixpacks through its environment (a staged 0600 file), not
	// through its command line: `--env KEY` takes the value from there.
	const staged = await stageBuildVariables(appName, envVariables, stageOptions);
	args.push(...getEnvFlagArgs("--env", staged));

	if (publishDirectory) {
		/* No need for any start command, since we'll use nginx later on */
		args.push("--no-error-without-start");
	}
	const command = `nixpacks ${args.join(" ")}`;

	// The static stage stages its own docker env file. It is created up front, so
	// the failure branches below have to remove it as well.
	const extraStaged: string[] = [];
	const staticCommand = publishDirectory
		? await getStaticCommand(application, {
				...stageOptions,
				onStaged: (paths) => {
					extraStaged.push(...paths);
					stageOptions.onStaged?.(paths);
				},
			})
		: "";
	const removeExtra = extraStaged.length
		? `rm -f ${quote(extraStaged)};`
		: "";

	let bashCommand = `
		${getGitCommitInfoCommands()}
		echo "Starting nixpacks build..." ;
		${staged.envFile.loader}${command} ${getCommitInfoEnvArgs()} || {
			${staged.envFile.cleanup}
			${removeExtra}
			echo "❌ Nixpacks build failed" ;
			exit 1;
		}
		${staged.envFile.cleanup}
		echo "✅ Nixpacks build completed." ;
		`;

	/*
		Run the container with the image created by nixpacks,
		and copy the artifacts on the host filesystem.
		Then, remove the container and create a static build.
	 */
	if (publishDirectory) {
		const localPath = path.join(buildAppDirectory, publishDirectory);
		const isDirectory =
			publishDirectory.endsWith("/") || !path.extname(publishDirectory);

		bashCommand += `
	docker create --name ${buildContainerId} ${appName}
	mkdir -p ${quote([localPath])}
	docker cp ${quote([`${buildContainerId}:/app/${publishDirectory}${isDirectory ? "/." : ""}`])} ${quote([localPath])} || {
		docker rm ${buildContainerId}
		${removeExtra}
		echo ${quote([`❌ Copying ${publishDirectory} to ${localPath} failed`])} ;
		exit 1;
	}
	docker rm ${buildContainerId}
	${staticCommand}
				`;
	}

	return bashCommand;
};
