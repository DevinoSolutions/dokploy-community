import {
	getEnvironmentVariablesObject,
	prepareEnvironmentVariables,
} from "@dokploy/server/utils/docker/utils";
import { quote } from "shell-quote";
import { buildEnvFileContent, isEnvFileName } from "../docker/env-file";
import {
	getBuildAppDirectory,
	getDockerContextPath,
} from "../filesystem/directory";
import type { ApplicationNested } from ".";
import {
	type BuildStageOptions,
	createEnvFileCommand,
	getAppEnvFileContent,
	getBuildEnvFile,
	getCommitInfoBuildArgs,
	getGitCommitInfoCommands,
	splitEnvironmentPair,
	stageBuildFiles,
} from "./utils";

export const getDockerCommand = async (
	application: ApplicationNested,
	stageOptions: BuildStageOptions = {},
) => {
	const {
		appName,
		env,
		publishDirectory,
		buildArgs,
		buildSecrets,
		dockerBuildStage,
		cleanCache,
		createEnvFile,
	} = application;
	const dockerFilePath = getBuildAppDirectory(application);

	try {
		const image = `${appName}`;

		const defaultContextPath =
			dockerFilePath.substring(0, dockerFilePath.lastIndexOf("/") + 1) || ".";

		const dockerContextPath =
			getDockerContextPath(application) || defaultContextPath;

		const commandArgs = [
			"build",
			"-t",
			image,
			"-f",
			dockerFilePath,
			dockerContextPath,
		];

		if (dockerBuildStage) {
			commandArgs.push("--target", dockerBuildStage);
		}

		if (cleanCache) {
			commandArgs.push("--no-cache");
		}

		const secrets = getEnvironmentVariablesObject(
			buildSecrets,
			application.environment.project.env,
			application.environment.env,
		);

		/*
			Build args and secrets reach docker through its environment: the values
			sit in a staged 0600 file that a loader sources, and the command line
			only names them (`--build-arg KEY`). A name the file cannot carry (see
			`isEnvFileName`), an empty value, or a build arg that clashes with a
			secret of the same name keeps the form it always had.
		*/
		const fileVariables = new Map<string, string>();
		const inlineSecrets: string[] = [];
		for (const [key, value] of Object.entries(secrets)) {
			if (isEnvFileName(key)) {
				fileVariables.set(key, value);
			} else {
				inlineSecrets.push(`${key}=${quote([value])}`);
			}
		}

		const args = prepareEnvironmentVariables(
			buildArgs,
			application.environment.project.env,
			application.environment.env,
		);
		for (const arg of args) {
			const [key, value] = splitEnvironmentPair(arg);
			const clashes =
				fileVariables.has(key) && fileVariables.get(key) !== value;
			if (value !== "" && isEnvFileName(key) && !clashes) {
				fileVariables.set(key, value);
				commandArgs.push("--build-arg", quote([key]));
			} else {
				commandArgs.push("--build-arg", quote([arg]));
			}
		}

		for (const key in secrets) {
			// Although buildx is smart enough to know we may be referring to an environment variable name,
			// we still make sure it doesn't fall back to `type=file`.
			// See: https://docs.docker.com/reference/cli/docker/buildx/build/#secret
			commandArgs.push("--secret", `type=env,id=${key}`);
		}

		/*
			Do not generate an environment file when publishDirectory is specified,
			as it could be publicly exposed.
			Also respect the createEnvFile flag.
		*/
		const appEnvContent =
			!publishDirectory && createEnvFile
				? getAppEnvFileContent(
						env,
						application.environment.project.env,
						application.environment.env,
					)
				: undefined;

		const files = [];
		if (fileVariables.size > 0) {
			files.push({
				kind: "docker-build-env",
				content: buildEnvFileContent(fileVariables),
			});
		}
		if (appEnvContent) {
			files.push({ kind: "app-env", content: appEnvContent });
		}
		const staged = await stageBuildFiles(appName, files, stageOptions);
		const buildEnvFile = getBuildEnvFile(
			fileVariables.size > 0 ? staged[0] : undefined,
		);
		const appEnvStaged = appEnvContent ? staged[staged.length - 1] : undefined;

		let command = "";
		if (appEnvContent !== undefined) {
			command += createEnvFileCommand(
				dockerFilePath,
				appEnvStaged,
				buildEnvFile.path ? [buildEnvFile.path] : [],
			);
		}

		const inlineSecretsPrefix = inlineSecrets.map((s) => `${s} `).join("");

		command += `
echo ${quote([`Building ${appName}`])} ;
cd ${quote([dockerContextPath])} || {
  ${buildEnvFile.cleanup}
  echo ${quote([`❌ The path ${dockerContextPath} does not exist`])} ;
  exit 1;
}

${getGitCommitInfoCommands()}

${inlineSecretsPrefix}${buildEnvFile.loader}docker ${commandArgs.join(" ")} ${getCommitInfoBuildArgs()} || {
  ${buildEnvFile.cleanup}
  echo "❌ Docker build failed" ;
  exit 1;
}
${buildEnvFile.cleanup}
echo "✅ Docker build completed." ;
		`;

		return command;
	} catch (error) {
		throw error;
	}
};
