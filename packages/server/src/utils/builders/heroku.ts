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

export const getHerokuCommand = async (
	application: ApplicationNested,
	stageOptions: BuildStageOptions = {},
) => {
	const { env, appName, cleanCache } = application;

	const buildAppDirectory = getBuildAppDirectory(application);
	const envVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	);

	const args = [
		"build",
		appName,
		"--path",
		buildAppDirectory,
		"--builder",
		`heroku/builder:${application.herokuVersion || "24"}`,
	];

	if (cleanCache) {
		args.push("--clear-cache");
	}

	// The values go to `pack` through its environment (a staged 0600 file), not
	// through its command line: `--env KEY` takes the value from there.
	const staged = await stageBuildVariables(appName, envVariables, stageOptions);
	args.push(...getEnvFlagArgs("--env", staged));

	const command = `pack ${args.join(" ")}`;
	const bashCommand = `
${getGitCommitInfoCommands()}
echo "Starting heroku build..." ;
${staged.envFile.loader}${command} ${getCommitInfoEnvArgs()} || {
  ${staged.envFile.cleanup}
  echo "❌ Heroku build failed" ;
  exit 1;
}
${staged.envFile.cleanup}
echo "✅ Heroku build completed." ;
		`;

	return bashCommand;
};
