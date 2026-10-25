import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import {
	ENV_VARIABLE_NAME,
	getBuildSecretAlias,
	isEnvFileName,
} from "../docker/env-file";
import {
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "../docker/utils";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";
import {
	type BuildStageOptions,
	getCommitInfoBuildArgs,
	getEnvFlagArgs,
	getGitCommitInfoCommands,
	stageBuildVariables,
} from "./utils";

const calculateSecretsHash = (envVariables: string[]): string => {
	const hash = createHash("sha256");
	for (const env of envVariables.sort()) {
		hash.update(env);
	}
	return hash.digest("hex");
};

export const getRailpackCommand = async (
	application: ApplicationNested,
	stageOptions: BuildStageOptions = {},
) => {
	const { env, appName, cleanCache } = application;
	const buildAppDirectory = getBuildAppDirectory(application);
	// Use prepareEnvironmentVariables (without ForShell) to get raw values for parsing
	const rawEnvVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	);
	// The hash input is the shell-quoted form, so the layer cache key does not
	// change with how the variables reach railpack.
	const envVariables = rawEnvVariables.map((variable) => quote([variable]));

	// Every variable is also a buildx secret. A name the env file cannot carry
	// (`isEnvFileName`) gets its value from an internal name in the file
	// (`getBuildSecretAlias`): nothing is exported by the script, so no
	// variable changes how the shell or docker runs. A name no shell variable
	// can have gets no secret; `railpack prepare` still gets it (T-8282).
	const secretArgs: string[] = [];
	const secretAliases: [string, string][] = [];
	for (const pair of rawEnvVariables) {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		if (!key || !value) continue;
		if (isEnvFileName(key)) {
			secretArgs.push("--secret", `id=${key},env=${key}`);
		} else if (ENV_VARIABLE_NAME.test(key)) {
			const alias = getBuildSecretAlias(secretAliases.length);
			secretAliases.push([alias, value]);
			secretArgs.push("--secret", `id=${key},env=${alias}`);
		}
	}

	// The values reach `railpack prepare` and the buildx secrets through their
	// environment (a staged 0600 file), not through the command line or the
	// script: `--env KEY` takes the value from there. The loader runs twice
	// (prepare, then build), so the file cannot be consumed by the first run:
	// it stays until the script's cleanup.
	const staged = await stageBuildVariables(
		application.appName,
		rawEnvVariables,
		stageOptions,
		{ singleUse: false },
		secretAliases,
	);

	// Prepare command. The build directory (from the build path) and the
	// Railpack version are application settings: each is passed as a single
	// argument.
	const prepareArgs = [
		"prepare",
		quote([buildAppDirectory]),
		"--plan-out",
		quote([`${buildAppDirectory}/railpack-plan.json`]),
		"--info-out",
		quote([`${buildAppDirectory}/railpack-info.json`]),
	];

	prepareArgs.push(...getEnvFlagArgs("--env", staged));

	// Calculate secrets hash for layer invalidation
	const secretsHash = calculateSecretsHash(envVariables);

	const cacheKey = cleanCache ? nanoid(10) : undefined;
	// Build command.
	// Use a unique builder name per build so concurrent deployments don't race
	// on a shared "builder-containerd" instance (create/use/rm collisions).
	const builderName = `railpack-${appName}-${nanoid(6)}`;
	const buildArgs = [
		"buildx",
		"build",
		"--builder",
		builderName,
		"--build-arg",
		`secrets-hash=${secretsHash}`,
		...(cacheKey ? ["--build-arg", `cache-key=${cacheKey}`] : []),
		"--build-arg",
		quote([
			`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${application.railpackVersion}`,
		]),
		"-f",
		quote([`${buildAppDirectory}/railpack-plan.json`]),
		"--output",
		quote([`type=docker,name=${appName}`]),
	];

	// The secrets are in docker's environment when the loader runs it.
	buildArgs.push(...secretArgs);

	buildArgs.push(quote([buildAppDirectory]));

	const bashCommand = `

# Ensure we have a builder with containerd (isolated per build)

export RAILPACK_VERSION=${quote([String(application.railpackVersion)])}
# use sudo for non-root so the install can write to /usr/local/bin
if [ "$(id -u)" -eq 0 ]; then
	SUDO_CMD=""
elif sudo -n true 2>/dev/null; then
	SUDO_CMD="sudo"
else
	SUDO_CMD=""
fi
$SUDO_CMD bash -c "$(curl -fsSL https://railpack.com/install.sh)"
docker buildx create --name ${builderName} --driver docker-container || true

echo "Preparing Railpack build plan..." ;
${staged.envFile.loader}railpack ${prepareArgs.join(" ")} || {
	${staged.envFile.cleanup}
	echo "❌ Railpack prepare failed" ;
	docker buildx rm ${builderName} || true
	exit 1;
}
echo "✅ Railpack prepare completed." ;

echo "Building with Railpack frontend..." ;
${getGitCommitInfoCommands()}
${staged.envFile.loader}docker ${buildArgs.join(" ")} ${getCommitInfoBuildArgs()} || {
	${staged.envFile.cleanup}
	echo "❌ Railpack build failed" ;
	docker buildx rm ${builderName} || true
	exit 1;
}
${staged.envFile.cleanup}
echo "✅ Railpack build completed." ;
docker buildx rm ${builderName} || true
`;

	return bashCommand;
};
