import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { quote } from "shell-quote";
import {
	buildEnvFileContent,
	getEnvFileLoader,
	isEnvFileName,
} from "../docker/env-file";
import {
	getInstallStagedFileCommand,
	getStagedFilePath,
	type StageOptions,
	stageFiles,
} from "../docker/staging";
import { prepareEnvironmentVariables } from "../docker/utils";

export interface BuildStageOptions extends StageOptions {
	/**
	 * The server that runs the build script (the build server when there is
	 * one); unset when the build runs on this machine. Staged files must be
	 * written where the script reads them.
	 */
	serverId?: string | null;
}

export interface BuildFileToStage {
	/** Names the staged file (`.dokploy-stage-<kind>-<deployment>`). */
	kind: string;
	content: string;
}

/**
 * Stages `files` next to the application's `code/` directory (which a clone
 * wipes) on the host that runs the build script, 0600, and returns their paths
 * in the same order. The script that consumes them removes them. Nothing is
 * written when `files` is empty.
 */
export const stageBuildFiles = async (
	appName: string,
	files: BuildFileToStage[],
	options: BuildStageOptions = {},
): Promise<string[]> => {
	if (files.length === 0) return [];

	const { APPLICATIONS_PATH } = paths(!!options.serverId);
	const directory = join(APPLICATIONS_PATH, appName);
	const stagedPaths = files.map((file) =>
		getStagedFilePath({
			directory,
			kind: file.kind,
			deploymentId: options.deploymentId,
		}),
	);
	await stageFiles({
		serverId: options.serverId,
		directory,
		files: files.map((file, index) => ({
			path: stagedPaths[index] as string,
			content: file.content,
		})),
	});
	options.onStaged?.(stagedPaths);
	return stagedPaths;
};

/** `KEY=VALUE` -> `[KEY, VALUE]`; the value may itself contain `=`. */
export const splitEnvironmentPair = (pair: string): [string, string] => {
	const separator = pair.indexOf("=");
	return separator === -1
		? [pair, ""]
		: [pair.slice(0, separator), pair.slice(separator + 1)];
};

/**
 * Whether a build variable can travel in the staged env file, to be passed to
 * the build tool by name (`--env KEY`, `--build-arg KEY`). An empty value has
 * nothing to hide, and a name that would change how the tool itself runs, or
 * that a shell cannot source, keeps its `KEY=value` form on the command line.
 */
export const isStageableBuildVariable = (key: string, value: string) =>
	value !== "" && isEnvFileName(key);

/**
 * A staged env file for a build command: `loader` goes in front of the build
 * tool so it runs with the file's variables in its environment, `cleanup`
 * removes the file once the tool is done with it (or failed). Both are empty
 * when nothing was staged, which leaves the command exactly as it was.
 */
export interface BuildEnvFile {
	path?: string;
	loader: string;
	cleanup: string;
}

/**
 * Consumes the file by default: a caller that reads it twice must pass
 * `singleUse: false`.
 *
 * `singleUse`: the builder runs the loader once, so the loader deletes the file
 * as soon as it has read it. Railpack runs it twice (prepare, then build) and
 * leaves the file to `cleanup`.
 */
export const getBuildEnvFile = (
	path?: string,
	{ singleUse = true }: { singleUse?: boolean } = {},
): BuildEnvFile =>
	path
		? {
				path,
				loader: `${getEnvFileLoader(path, { consume: singleUse })} `,
				cleanup: `rm -f ${quote([path])};`,
			}
		: { loader: "", cleanup: "" };

/**
 * Splits a builder's variables between a staged env file and the command line,
 * and stages the file. `passByName` is for the stageable ones: the build tool
 * gets `--env KEY` (or `--build-arg KEY`) and reads the value from its
 * environment. `inline` keeps the form `KEY=value`, already shell-quoted.
 */
export const stageBuildVariables = async (
	appName: string,
	variables: string[],
	options: BuildStageOptions = {},
	envFileOptions?: { singleUse?: boolean },
) => {
	const passByName: string[] = [];
	const inline: string[] = [];
	const fileEntries: [string, string][] = [];
	for (const variable of variables) {
		const [key, value] = splitEnvironmentPair(variable);
		if (isStageableBuildVariable(key, value)) {
			passByName.push(key);
			fileEntries.push([key, value]);
		} else {
			inline.push(quote([variable]));
		}
	}

	const [path] = await stageBuildFiles(
		appName,
		fileEntries.length > 0
			? [{ kind: "build-env", content: buildEnvFileContent(fileEntries) }]
			: [],
		options,
	);
	return { passByName, inline, envFile: getBuildEnvFile(path, envFileOptions) };
};

/** `--env`, one flag per variable: stageable ones by name, the rest as `KEY=value`. */
export const getEnvFlagArgs = (
	flag: string,
	{ passByName, inline }: { passByName: string[]; inline: string[] },
) => {
	const args: string[] = [];
	for (const key of passByName) args.push(flag, quote([key]));
	for (const variable of inline) args.push(flag, variable);
	return args;
};

/**
 * The application's own `.env` (`createEnvFile`), read by the app's build
 * tooling. Staged and copied into place instead of embedded in the script:
 * embedded as base64 it put every value in the host's process list and counted
 * toward the 128 KB limit on one shell argument.
 */
export const getAppEnvFileContent = (
	env: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) =>
	prepareEnvironmentVariables(env, projectEnv, environmentEnv).join("\n");

/**
 * Shell commands that write `content` to the `.env` next to `directory` (the
 * Dockerfile path). `stagedPath` is the file staged with that content (none
 * when it is empty). `alsoRemove` are the other staged files of the same
 * script, removed if this step stops it.
 */
export const createEnvFileCommand = (
	directory: string,
	stagedPath: string | undefined,
	alsoRemove: string[] = [],
) => {
	const envFilePath = join(dirname(directory), ".env");
	if (!stagedPath) return `: > ${quote([envFilePath])};`;

	return getInstallStagedFileCommand({
		staged: stagedPath,
		destination: envFilePath,
		failureMessage: "❌ Error: Could not write the environment file",
		alsoRemove,
	});
};

/**
 * Returns shell commands to extract git commit hash and message
 * into DOKPLOY_COMMIT_HASH, DOKPLOY_COMMIT_SHORT, and DOKPLOY_COMMIT_MESSAGE shell variables.
 */
export const getGitCommitInfoCommands = () => {
	return `DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s 2>/dev/null || echo "unknown")`;
};

/**
 * Returns docker --build-arg flags for commit info.
 */
export const getCommitInfoBuildArgs = () => {
	return '--build-arg DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH" --build-arg DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT" --build-arg DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"';
};

/**
 * Returns --env flags for commit info (for pack/nixpacks builders).
 */
export const getCommitInfoEnvArgs = () => {
	return '--env DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH" --env DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT" --env DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"';
};
