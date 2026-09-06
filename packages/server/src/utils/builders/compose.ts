import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { InferResultType } from "@dokploy/server/types/with";
import boxen from "boxen";
import { quote } from "shell-quote";
import { writeDomainsToCompose } from "../docker/domain";
import {
	encodeBase64,
	getEnvironmentVariablesObject,
	prepareEnvironmentVariables,
	prepareEnvironmentVariablesForFile,
} from "../docker/utils";
import { withResolvedVaultRefs } from "../vault";

export type ComposeNested = InferResultType<
	"compose",
	{ environment: { with: { project: true } }; mounts: true; domains: true }
>;

/**
 * Emitted by the generated deploy script on the line right after a failed
 * `docker compose up` was rolled back to the previous release *and* the
 * on-disk compose/env files were restored. `didRollbackSucceed` greps the
 * deployment log for this marker to decide whether the service is still live.
 * The deployment id is appended so a marker left behind by an older deployment
 * in a reused log file can never be mistaken for the current one.
 */
export const ROLLBACK_OK_MARKER = "__DOKPLOY_ROLLBACK_OK__";

/**
 * Minimal shape needed to resolve the on-disk paths of a compose service.
 * Accepts both `Compose` rows and the nested/overridden entities used by
 * previews (whose `appName` is swapped for the isolated preview app name).
 */
export type ComposePathLike = {
	appName: string;
	sourceType: string;
	composePath: string;
	serverId?: string | null;
};

/**
 * Absolute path of the compose file the deploy actually runs (`-f`).
 * Mirrors `getComposePath` in utils/docker/domain: raw services always write
 * their compose file to `<code>/docker-compose.yml`, whatever `composePath`
 * says. Duplicated here (instead of imported) to keep this module free of a
 * dependency on the domain helpers, which several tests stub out wholesale.
 */
export const getComposeFilePath = (compose: ComposePathLike) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const path =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	return join(COMPOSE_PATH, compose.appName, "code", path);
};

/**
 * Absolute path of the generated `.env`. Deliberately derived from
 * `composePath` (not from `getComposeFilePath`) because that is what both
 * `getCreateEnvFileCommand` writes and `createCommand`'s `--env-file` points
 * at; the two only differ for raw services with a nested `composePath`.
 */
export const getComposeEnvFilePath = (compose: ComposePathLike) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const composeFilePath = join(
		COMPOSE_PATH,
		compose.appName,
		"code",
		compose.composePath || "docker-compose.yml",
	);
	return join(dirname(composeFilePath), ".env");
};

/**
 * Directory holding the transactional-deploy snapshots. It lives next to
 * `code/` (not inside it) so a `git clone` / raw-file rewrite of the code
 * directory never wipes the snapshot we are about to roll back to.
 */
export const getComposeBackupDir = (compose: ComposePathLike) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	return join(COMPOSE_PATH, compose.appName, ".deploy-backup");
};

/** Snapshot of the release that was on disk when this deploy started. */
export const PRE_DEPLOY_COMPOSE_BAK = "docker-compose.yml.bak";
export const PRE_DEPLOY_ENV_BAK = "env.bak";
/** Snapshot of the last release that actually deployed successfully. */
export const LAST_GOOD_COMPOSE_BAK = "last-good-docker-compose.yml.bak";
export const LAST_GOOD_ENV_BAK = "last-good-env.bak";

/**
 * Shell snippet that snapshots the release currently on disk (compose file and
 * `.env`) into the backup directory. Must run *before* anything rewrites the
 * code directory, otherwise there is nothing left to roll back to.
 *
 * `|| exit 1` on purpose: a deploy that could not take its snapshot must abort
 * rather than mutate the code directory untransactionally. Stale snapshots are
 * removed when the corresponding file is absent so a rollback can never mix a
 * fresh compose file with an old `.env`.
 *
 * Every interpolated path goes through shell-quote: `composePath` and `appName`
 * are user-controlled fields.
 */
export const getBackupCurrentDeploymentCommand = (
	compose: ComposePathLike,
) => {
	const backupDir = getComposeBackupDir(compose);
	const qBackupDir = quote([backupDir]);
	const qComposeFile = quote([getComposeFilePath(compose)]);
	const qEnvFile = quote([getComposeEnvFilePath(compose)]);
	const qComposeBak = quote([join(backupDir, PRE_DEPLOY_COMPOSE_BAK)]);
	const qEnvBak = quote([join(backupDir, PRE_DEPLOY_ENV_BAK)]);

	return `
mkdir -p ${qBackupDir} 2>/dev/null || exit 1;
if [ -f ${qComposeFile} ]; then cp ${qComposeFile} ${qComposeBak} || exit 1; else echo "No previous compose file found"; rm -f ${qComposeBak}; fi
if [ -f ${qEnvFile} ]; then cp ${qEnvFile} ${qEnvBak} || exit 1; else echo "No previous env file found"; rm -f ${qEnvBak}; fi
	`;
};

/**
 * Shell snippet that looks for one specific deployment's rollback marker in
 * its own log file. Anchored (`^...$`) and bound to the deployment id so a
 * marker left by an earlier deployment can never be mistaken for this one's.
 */
export const getRollbackMarkerProbeCommand = (
	logPath: string,
	deploymentId: string,
) =>
	`if grep -q ${quote([`^${ROLLBACK_OK_MARKER}:${deploymentId}$`])} ${quote([logPath])} 2>/dev/null; then echo "LIVE_OK"; else echo "LIVE_FAILED"; fi`;

export interface BuildComposeCommandOptions {
	/**
	 * Deployment the command belongs to. Required for the rollback marker to be
	 * attributable; when omitted the transactional wrapper is still emitted but
	 * the marker carries no id and `didRollbackSucceed` will not match it.
	 */
	deploymentId?: string;
	/**
	 * Set when the caller already ran `docker compose down --volumes` before
	 * this build. A fresh-volumes deploy is intentionally destructive and has
	 * no restorable pre-state, so the transactional wrapper is switched off.
	 */
	freshVolumes?: boolean;
}

export const getBuildComposeCommand = async (
	rawCompose: ComposeNested,
	options: BuildComposeCommandOptions = {},
) => {
	const { deploymentId, freshVolumes = false } = options;
	const compose = await withResolvedVaultRefs(rawCompose);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { sourceType, appName, mounts, composeType, domains } = compose;
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const command = createCommand(
		compose,
		mounts.length > 0 ? projectPath : undefined,
	);
	const envCommand = compose.createEnvFile
		? getCreateEnvFileCommand(compose)
		: "";
	const exportEnvCommand = getExportEnvCommand(compose);

	const newCompose = await writeDomainsToCompose(compose, domains);
	const logContent = `
App Name: ${appName}
Build Compose 🐳
Detected: ${mounts.length} mounts 📂
Command: docker ${command}
Source Type: docker ${sourceType} ✅
Compose Type: ${composeType} ✅`;

	const logBox = boxen(logContent, {
		padding: {
			left: 1,
			right: 1,
			bottom: 1,
		},
		width: 80,
		borderStyle: "double",
	});

	// Transactional deploys only make sense for `docker compose`: `stack deploy`
	// is already declarative and converges on its own, and a fresh-volumes
	// deploy has deliberately destroyed the state we would roll back to.
	const isTransactional = composeType === "docker-compose" && !freshVolumes;

	const backupDir = getComposeBackupDir(compose);
	const composeFilePath = getComposeFilePath(compose);
	const envFilePath = getComposeEnvFilePath(compose);

	// Every path below reaches the shell through shell-quote. `composePath` and
	// `appName` are user-controlled, so interpolating them bare into the script
	// (as `"${path}"`) would be a command-injection vector.
	const qBackupDir = quote([backupDir]);
	const qComposeFile = quote([composeFilePath]);
	const qEnvFile = quote([envFilePath]);
	const qPreCompose = quote([join(backupDir, PRE_DEPLOY_COMPOSE_BAK)]);
	const qPreEnv = quote([join(backupDir, PRE_DEPLOY_ENV_BAK)]);
	const qLastGoodCompose = quote([join(backupDir, LAST_GOOD_COMPOSE_BAK)]);
	const qLastGoodEnv = quote([join(backupDir, LAST_GOOD_ENV_BAK)]);
	const qRollbackMarker = quote([
		deploymentId ? `${ROLLBACK_OK_MARKER}:${deploymentId}` : ROLLBACK_OK_MARKER,
	]);

	// The restore re-runs the very command that deploys, minus the flags that
	// would rebuild or re-pull: the restored release is a known-good artifact,
	// and `--pull always` is frequently the thing that broke the deploy in the
	// first place.
	const restoreCommand = command
		.replace(/ --build\b/g, "")
		.replace(/ --pull always\b/g, "");

	// When the service generates its own `.env`, a restore that could not put
	// the previous `.env` back is not a real rollback — the restored compose
	// file would run against the new (possibly broken) environment.
	const isEnvRequired = compose.createEnvFile ? "1" : "0";

	const restoreCommands = isTransactional
		? `
		echo "Restoring previous working deployment... ⏪";
		RESTORE_FILES_OK=1;
		cp ${qLastGoodCompose} ${qComposeFile} 2>/dev/null || cp ${qPreCompose} ${qComposeFile} 2>/dev/null || RESTORE_FILES_OK=0;
		RESTORE_ENV_OK=1;
		cp ${qLastGoodEnv} ${qEnvFile} 2>/dev/null || cp ${qPreEnv} ${qEnvFile} 2>/dev/null || RESTORE_ENV_OK=0;
		if [ "$RESTORE_ENV_OK" = "0" ] && { [ "${isEnvRequired}" = "1" ] || [ -f ${qLastGoodEnv} ] || [ -f ${qPreEnv} ]; }; then RESTORE_FILES_OK=0; echo "Warning: ⚠️ Previous .env could not be restored"; fi
		if [ "$RESTORE_FILES_OK" = "1" ]; then
			env -i PATH="$PATH" HOME="$HOME" ${exportEnvCommand} docker ${restoreCommand} 2>&1 && echo ${qRollbackMarker} || echo "Warning: ⚠️ Automatic restore failed, manual intervention may be required";
		else
			echo "Warning: ⚠️ No previous release to restore, leaving the stack as-is";
		fi
		`
		: "";

	// Refresh the known-good snapshot after a successful deploy. Wrapped so it
	// can never turn a successful deploy into a failed one, and so a partial
	// refresh drops the snapshot entirely instead of leaving a compose file
	// paired with a stale `.env`.
	const persistLastGood = isTransactional
		? `
		{ mkdir -p ${qBackupDir} && cp ${qComposeFile} ${qLastGoodCompose} && { { [ -f ${qEnvFile} ] && cp ${qEnvFile} ${qLastGoodEnv}; } || rm -f ${qLastGoodEnv}; }; } 2>/dev/null || { rm -f ${qLastGoodCompose} ${qLastGoodEnv} 2>/dev/null; echo "Warning: ⚠️ Could not refresh the last-good snapshot"; true; }
		`
		: "";

	const bashCommand = `
	set -e
	{
		echo "${logBox}";

		${newCompose}

		${envCommand}

		cd "${projectPath}";

		${
			compose.isolatedDeployment
				? `
			if docker network inspect ${compose.appName} >/dev/null 2>&1; then
				${compose.composeType !== "stack" && compose.isolatedNetworkMtu ? `CURRENT_MTU=$(docker network inspect ${compose.appName} --format '{{index .Options "com.docker.network.driver.mtu"}}'); if [ "$CURRENT_MTU" != "${compose.isolatedNetworkMtu}" ]; then echo "Info: Network ${compose.appName} has MTU $CURRENT_MTU but configured MTU is ${compose.isolatedNetworkMtu}. The network must be recreated for the new MTU to take effect."; fi` : "true"}
			else
				docker network create ${compose.composeType === "stack" ? "--driver overlay" : ""} --attachable ${compose.composeType !== "stack" && compose.isolatedNetworkMtu ? `--opt com.docker.network.driver.mtu=${compose.isolatedNetworkMtu}` : ""} ${compose.appName}
			fi`
				: ""
		}
		env -i PATH="$PATH" HOME="$HOME" ${exportEnvCommand} docker ${command.split(" ").join(" ")} 2>&1 || { echo "Error: ❌ Docker command failed"; ${restoreCommands} exit 1; }
		${compose.isolatedDeployment ? `docker network connect ${compose.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1` : ""}
		${persistLastGood}

		echo "Docker Compose Deployed: ✅";
	} || {
		echo "Error: ❌ Script execution failed";
		exit 1
	}
	`;

	return bashCommand;
};

// Shell control characters that must never appear in a user-provided compose
// command: they would let it break out of the `docker ${command}` invocation
// into arbitrary host commands. A normal docker compose CLI line never needs them.
// Removed '&' from the blocklist to allow '&&' chaining
const UNSAFE_COMPOSE_COMMAND = /[;|`$(){}<>\n\\]/;

const sanitizeCommand = (command: string) => {
	const sanitizedCommand = command.trim();

	if (UNSAFE_COMPOSE_COMMAND.test(sanitizedCommand)) {
		throw new Error(
			"Invalid characters in compose command: shell control characters are not allowed",
		);
	}

	if (sanitizedCommand.includes("&")) {
		// Block single '&' (e.g., backgrounding tasks) or malformed chains like '&&&'
		if (
			/(?<!&)&(?!&)/.test(sanitizedCommand) ||
			sanitizedCommand.includes("&&&")
		) {
			throw new Error("Single '&' is not allowed. Use '&&' for chaining.");
		}

		// Split by '&&' and check that every chained command (skipping the first one) is safe
		const chains = sanitizedCommand.split("&&").map((cmd) => cmd.trim());
		const isSafeChain = chains
			.slice(1)
			.every(
				(cmd) =>
					cmd.startsWith("docker compose ") ||
					cmd.startsWith("docker-compose "),
			);

		if (!isSafeChain) {
			throw new Error(
				"Chained commands must strictly start with 'docker compose '",
			);
		}
	}

	const parts = sanitizedCommand.split(/\s+/);
	const restCommand = parts.map((arg) => arg.replace(/^"(.*)"$/, "$1"));

	return restCommand.join(" ");
};

export const createCommand = (compose: ComposeNested, projectPath?: string) => {
	const { composeType, appName, sourceType } = compose;
	if (compose.command) {
		return `${sanitizeCommand(compose.command)}`;
	}

	const path =
		sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	let command = "";

	if (composeType === "docker-compose") {
		// When enabled, force-pull the latest images before (re)deploying so a
		// redeploy picks up updated tags instead of reusing the local cache.
		// (`stack deploy` already resolves+pulls, so this only applies here.)
		const pullFlag = compose.pullImagesOnDeploy ? " --pull always" : "";
		const projectDirectoryFlag = projectPath
			? `--project-directory ${quote([projectPath])} `
			: "";
		const envFileFlag = compose.createEnvFile
			? `--env-file ${quote([join(dirname(compose.composePath || "docker-compose.yml"), ".env")])} `
			: "";
		command = `compose -p ${quote([appName])} ${projectDirectoryFlag}${envFileFlag}-f ${quote([path])} up -d${pullFlag} --build --remove-orphans`;
	} else if (composeType === "stack") {
		command = `stack deploy -c ${quote([path])} ${quote([appName])} --prune --with-registry-auth`;
	}

	return command;
};

export const getCreateEnvFileCommand = (compose: ComposeNested) => {
	const { env, appName } = compose;
	const envFilePath = getComposeEnvFilePath(compose);

	let envContent = `APP_NAME=${appName}\n`;
	envContent += `COMPOSE_PROJECT_NAME=${appName}\n`;
	envContent += env || "";
	if (!envContent.includes("DOCKER_CONFIG")) {
		envContent += "\nDOCKER_CONFIG=/root/.docker";
	}

	if (compose.randomize) {
		envContent += `\nCOMPOSE_PREFIX=${compose.suffix}`;
	}

	const envFileContent = (
		compose.composeType === "stack"
			? prepareEnvironmentVariables(
					envContent,
					compose.environment.project.env,
					compose.environment.env,
				)
			: prepareEnvironmentVariablesForFile(
					envContent,
					compose.environment.project.env,
					compose.environment.env,
				)
	).join("\n");

	const encodedContent = encodeBase64(envFileContent);
	return `
touch ${quote([envFilePath])};
echo "${encodedContent}" | base64 -d > ${quote([envFilePath])};
	`;
};

const getExportEnvCommand = (compose: ComposeNested) => {
	if (compose.composeType !== "stack") return "";

	const envVars = getEnvironmentVariablesObject(
		compose.env,
		compose.environment.project.env,
		compose.environment.env,
	);
	const exports = Object.entries(envVars)
		.map(([key, value]) => `${key}=${quote([value])}`)
		.join(" ");

	return exports ? `${exports}` : "";
};
