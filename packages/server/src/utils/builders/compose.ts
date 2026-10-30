import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Patch } from "@dokploy/server/services/patch";
import type { InferResultType } from "@dokploy/server/types/with";
import boxen from "boxen";
import { parse } from "dotenv";
import { quote } from "shell-quote";
import {
	ATOMIC_PUT_FUNCTION,
	COMPOSE_FILE_LINK_MESSAGE,
	getComposeCodeDirectory,
	getRestoreWriteCheckCommand,
} from "../compose-file-guard";
import { addDomainToCompose, writeDomainsToCompose } from "../docker/domain";
import {
	ENV_VARIABLE_NAME,
	formatNameList,
	getDroppedDotenvNotice,
	isComposeDotenvName,
	isStackEnvName,
	NEUTRALISED_CLI_ENV,
	NEUTRALISED_CLI_ENV_NAMES,
	singleQuote,
} from "../docker/env-file";
import {
	getInstallStagedFileCommand,
	getStagedFilePath,
	removeStagedFiles,
	type StageOptions,
	stageFiles,
} from "../docker/staging";
import {
	getEnvironmentVariablesObject,
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
	prepareEnvironmentVariablesForFile,
} from "../docker/utils";
import { getPathResolverLines } from "../path-containment";
import { withResolvedVaultRefs } from "../vault";
import {
	DOCKER_EVENTS_FLUSH_COMMAND,
	getDockerEventsStartScript,
	getHealthCheckScript,
	getPhaseEndCommand,
	getPhaseHelpersScript,
	getPhaseStartCommand,
	getStallSnapshotStartScript,
	HEALTH_CHECK_STACK_SKIPPED_MESSAGE,
	resolveDeployGuardrails,
	STALL_SNAPSHOT_CLEANUP_COMMAND,
} from "./compose-guardrails";
import {
	type ComposeVariableLookup,
	createComposeVariableLookup,
	UNKNOWN_VALUE,
} from "./compose-interpolate";
import {
	describeRollingBlockers,
	getRollingDrainWarnings,
	getRollingNoticeCommand,
	getRollingReplaceScript,
	getRollingRestoreGuard,
	interpolateRollingSpec,
	planRollingServices,
	type RollingSpec,
	resolveComposeRolling,
} from "./compose-rolling";

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
	/** Set when the images are built on a build server (see compose-remote-build). */
	buildServerId?: string | null;
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

/**
 * Name of the generated compose override that points every service built on a
 * build server at the image that was pushed for it.
 */
export const COMPOSE_BUILD_OVERRIDE_FILE = "docker-compose.dokploy-build.yml";

/**
 * Absolute path of the build override on the serving host. It lives next to
 * `code/` (not inside it) so a `git clone` of the code directory can never
 * delete the file the running release was started with.
 */
export const getComposeBuildOverridePath = (compose: ComposePathLike) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	return join(COMPOSE_PATH, compose.appName, COMPOSE_BUILD_OVERRIDE_FILE);
};

/** Snapshot of the release that was on disk when this deploy started. */
export const PRE_DEPLOY_COMPOSE_BAK = "docker-compose.yml.bak";
export const PRE_DEPLOY_ENV_BAK = "env.bak";
export const PRE_DEPLOY_OVERRIDE_BAK = `${COMPOSE_BUILD_OVERRIDE_FILE}.bak`;
/** Snapshot of the last release that actually deployed successfully. */
export const LAST_GOOD_COMPOSE_BAK = "last-good-docker-compose.yml.bak";
export const LAST_GOOD_ENV_BAK = "last-good-env.bak";
export const LAST_GOOD_OVERRIDE_BAK = `last-good-${COMPOSE_BUILD_OVERRIDE_FILE}.bak`;

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
const SNAPSHOT_UNCHECKED_NOTICE = quote([
	"Warning: ⚠️ This host has neither realpath -m nor readlink -f, so the files of the previous release cannot be checked; the previous snapshot is kept.",
]);

export const getBackupCurrentDeploymentCommand = (compose: ComposePathLike) => {
	const backupDir = getComposeBackupDir(compose);
	const qBackupDir = quote([backupDir]);
	const qComposeFile = quote([getComposeFilePath(compose)]);
	const qEnvFile = quote([getComposeEnvFilePath(compose)]);
	const qComposeBak = quote([join(backupDir, PRE_DEPLOY_COMPOSE_BAK)]);
	const qEnvBak = quote([join(backupDir, PRE_DEPLOY_ENV_BAK)]);

	// A release deployed through a build server is only restorable together with
	// the override that pins its images, so that file is part of the snapshot.
	let overrideSnapshot = "";
	if (compose.buildServerId) {
		const qOverrideFile = quote([getComposeBuildOverridePath(compose)]);
		const qOverrideBak = quote([join(backupDir, PRE_DEPLOY_OVERRIDE_BAK)]);
		overrideSnapshot = `if [ -f ${qOverrideFile} ]; then cp ${qOverrideFile} ${qOverrideBak} || exit 1; else rm -f ${qOverrideBak}; fi
`;
	}

	// A file that leads out of the checkout (a link in the previous release,
	// T-7857) is not part of the release and is not copied: a restore would put
	// its content back into the compose. On a host that cannot resolve links
	// nothing can be checked: the snapshot is skipped and the previous one kept.
	const qCodeDirectory = quote([getComposeCodeDirectory(compose)]);
	const snapshot = (file: string, bak: string, label: string) =>
		`if [ -f ${file} ]; then if __dokploy_inside ${qCodeDirectory} ${file}; then cp ${file} ${bak} || exit 1; elif [ "$__dokploy_no_resolve" = "1" ]; then echo ${SNAPSHOT_UNCHECKED_NOTICE}; else echo "No previous ${label} found"; rm -f ${bak}; fi; else echo "No previous ${label} found"; rm -f ${bak}; fi`;
	return `
__dokploy_no_resolve=0
${getPathResolverLines("__dokploy_no_resolve=1; __dokploy_resolve() { return 1; }").join("\n")}
mkdir -p ${qBackupDir} 2>/dev/null || exit 1;
${snapshot(qComposeFile, qComposeBak, "compose file")}
${snapshot(qEnvFile, qEnvBak, "env file")}
${overrideSnapshot}	`;
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
	/**
	 * Result of building the images on the compose's build server. Required when
	 * `compose.buildServerId` is set: the serving host then only logs in, pulls
	 * and runs (`up --no-build`), and refuses to build on its own.
	 */
	remoteBuild?: RemoteBuildDeployInfo;
	/**
	 * The patch rows the deploy already read and checked. The compose file the
	 * command stages is rendered from them, not from a second read (T-8260).
	 */
	patches?: Patch[];
}

/** One service whose image was built on the build server and pushed. */
export interface RemoteBuildImage {
	service: string;
	/** Registry reference the serving host pulls and runs. */
	image: string;
}

export interface RemoteBuildDeployInfo {
	images: RemoteBuildImage[];
	/** Human readable name of the serving host, for the deployment log. */
	servingHostLabel: string;
}

/** Name of the compose's build server for user-facing messages. */
const getBuildServerLabel = (compose: ComposeNested) => {
	const name = (compose as { buildServer?: { name?: string | null } | null })
		.buildServer?.name;
	return name ? `build server ${name}` : "the build server";
};

/**
 * Shell snippet that restores the compose file, the `.env` and (for a compose
 * deployed through a build server) the build override from the snapshots, then
 * re-runs the previous release. Empty when the deploy is not transactional.
 *
 * Shared by the deploy script (docker command failed) and by the caller that
 * fails before the deploy script even starts (the build server stage), so both
 * leave the serving host in exactly the same state.
 */
const getRestoreCommands = (
	compose: ComposeNested,
	{
		command,
		deploymentId,
		isTransactional,
		projectPath,
	}: {
		command: string;
		deploymentId?: string;
		isTransactional: boolean;
		projectPath: string;
	},
) => {
	// Only `docker compose` deploys are transactional, never a stack, so the
	// restore has no stack env to load.
	if (!isTransactional) return "";
	const backupDir = getComposeBackupDir(compose);
	const qComposeFile = quote([getComposeFilePath(compose)]);
	const qEnvFile = quote([getComposeEnvFilePath(compose)]);
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
	const stripFlags = (value: string) =>
		value.replace(/ --build\b/g, "").replace(/ --pull always\b/g, "");
	const restoreCommand = stripFlags(command);

	// When the service generates its own `.env`, a restore that could not put
	// the previous `.env` back is not a real rollback — the restored compose
	// file would run against the new (possibly broken) environment.
	const isEnvRequired = compose.createEnvFile ? "1" : "0";

	// `failureMessage` is only ever overridden by the build-server branch; the
	// default stays the literal string every other compose has always logged.
	const runRestore = (restoreArgs: string, failureMessage?: string) =>
		`${withCleanEnvironment(restoreArgs, getCleanEnvPrefix(), Boolean(compose.command))} 2>&1 && echo ${qRollbackMarker} || echo ${failureMessage ? quote([failureMessage]) : '"Warning: ⚠️ Automatic restore failed, manual intervention may be required"'};`;

	let upRestore = runRestore(restoreCommand);
	let overrideRestore = "";
	if (compose.buildServerId) {
		// No override could be put back: the previous release predates the build
		// server, or it had no `build:` services (so no override was ever written).
		// It still must not be rebuilt here: a plain `up` builds any service whose
		// image was pruned since, which a unit with a build server promises never
		// to do on its serving host. `--no-build` brings it back from the images
		// still on this host (or pulls them). If that fails the cause is unknown
		// (pruned images, registry outage, port conflict...), so the message below
		// stays neutral instead of blaming a missing image.
		const qOverrideFile = quote([getComposeBuildOverridePath(compose)]);
		const qPreOverride = quote([join(backupDir, PRE_DEPLOY_OVERRIDE_BAK)]);
		const qLastGoodOverride = quote([join(backupDir, LAST_GOOD_OVERRIDE_BAK)]);
		const plainCommand = `${stripFlags(
			createCommand({ ...compose, buildServerId: null }, projectPath),
		)} --no-build`;
		const buildServerLabel = getBuildServerLabel(compose);
		const noBuildRestoreFailure = `Warning: ⚠️ Automatic restore failed. The serving host never builds images (${buildServerLabel}). If this release's images were pruned, redeploy to rebuild them on ${buildServerLabel}; otherwise manual intervention may be required. Some services may already be restarted.`;
		overrideRestore = `
		OVERRIDE_RESTORED=1;
		cp ${qLastGoodOverride} ${qOverrideFile} 2>/dev/null || cp ${qPreOverride} ${qOverrideFile} 2>/dev/null || { OVERRIDE_RESTORED=0; rm -f ${qOverrideFile}; };`;
		upRestore = `if [ "$OVERRIDE_RESTORED" = "1" ]; then
				${runRestore(restoreCommand)}
			else
				${runRestore(plainCommand, noBuildRestoreFailure)}
			fi`;
	}

	// A `.env` that is a symlink (the repository can bring one, pointing at
	// another compose's `.env`, when "Create env file" is off) is removed before
	// the restore writes it, so the copy never goes through the link (T-7135).
	// The compose file likewise (T-7857), and neither is written when the
	// directory they are in leads out of the checkout.
	const restoreWriteCheck = getRestoreWriteCheckCommand({
		codeDirectory: getComposeCodeDirectory(compose),
		file: getComposeFilePath(compose),
	});
	const qLinkNotice = quote([`Warning: ⚠️ ${COMPOSE_FILE_LINK_MESSAGE}`]);
	// Written as a renamed temporary file, never in place (see __dokploy_put).
	const qCodeDirectory = quote([getComposeCodeDirectory(compose)]);
	const put = (source: string, destination: string) =>
		`__dokploy_put ${source} ${destination} ${qCodeDirectory}`;
	return `
		echo "Restoring previous working deployment... ⏪";
		${ATOMIC_PUT_FUNCTION}
		${restoreWriteCheck}
		RESTORE_FILES_OK=1;
		if [ "$__dokploy_write_ok" = "1" ]; then
			${put(qLastGoodCompose, qComposeFile)} 2>/dev/null || ${put(qPreCompose, qComposeFile)} 2>/dev/null || RESTORE_FILES_OK=0;
		else
			RESTORE_FILES_OK=0; echo ${qLinkNotice};
		fi
		RESTORE_ENV_OK=1;
		if [ "$__dokploy_write_ok" = "1" ]; then
			${put(qLastGoodEnv, qEnvFile)} 2>/dev/null || ${put(qPreEnv, qEnvFile)} 2>/dev/null || RESTORE_ENV_OK=0;
		else
			RESTORE_ENV_OK=0;
		fi;${overrideRestore}
		if [ "$RESTORE_ENV_OK" = "0" ] && { [ "${isEnvRequired}" = "1" ] || [ -f ${qLastGoodEnv} ] || [ -f ${qPreEnv} ]; }; then RESTORE_FILES_OK=0; echo "Warning: ⚠️ Previous .env could not be restored"; fi
		if [ "$RESTORE_FILES_OK" = "1" ]; then
			${upRestore}
		else
			echo "Warning: ⚠️ No previous release to restore, leaving the stack as-is";
		fi
		`;
};

// Whether the compose volume check accepts the compose with its custom
// command. Imported when needed: the check imports the builders.
const isCustomCommandAllowed = async (compose: ComposeNested) => {
	try {
		const { assertComposeVolumesBound } = await import(
			"@dokploy/server/services/compose-volume-binding"
		);
		await assertComposeVolumesBound(compose);
		return true;
	} catch {
		return false;
	}
};

/**
 * Restore script for a deploy that failed *before* the deploy script ran (the
 * build on the build server; for a rolling compose without one, a cancel
 * during the fetch or the patches). The running containers were never touched, but
 * the clone already replaced the compose file and `.env`, so put the previous
 * release's files back and confirm it is still serving. Same markers as a
 * failed `docker compose up`, so `didRollbackSucceed` treats it identically.
 */
export const getRestoreAfterFailedBuildCommand = async (
	rawCompose: ComposeNested,
	options: { deploymentId?: string; freshVolumes?: boolean } = {},
) => {
	const resolved = await withResolvedVaultRefs(rawCompose);
	// This restore runs after a refused compose volume (T-6822, T-7055) and on
	// a cancel that can come before the check has run, and it re-runs the
	// custom command. A command the volume check refuses must never be run
	// here, so it is left out: the restore brings the previous release's files
	// up with the default command instead.
	const commandDropped =
		Boolean(resolved.command) && !(await isCustomCommandAllowed(rawCompose));
	const compose = commandDropped ? { ...resolved, command: "" } : resolved;
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const isTransactional =
		compose.composeType === "docker-compose" && !options.freshVolumes;
	const effectiveProjectPath = compose.mounts.length > 0 ? projectPath : "";
	const restore = getRestoreCommands(compose, {
		// A compose without a build server (cancelled before its release step)
		// has no override file to merge, and its own command builds.
		command: createCommand(
			compose,
			effectiveProjectPath || undefined,
			compose.buildServerId
				? { overridePath: getComposeBuildOverridePath(compose) }
				: undefined,
		),
		deploymentId: options.deploymentId,
		isTransactional,
		projectPath: effectiveProjectPath,
	});
	if (!restore) return restore;
	// The deploy script runs from the code directory (it `cd`s there before the
	// docker command) and the restored `-f` / `--env-file` paths are relative to
	// it. This script runs as a step of its own, so it has to change there too.
	// The check decides on the whole compose (its files and the command's
	// effect on them cannot be told apart), so a refused compose file also
	// drops a command that was fine: say so in the log.
	const droppedNotice = commandDropped
		? `echo ${quote(["custom command dropped for the restore: it failed the volume check"])};`
		: "";
	return `${droppedNotice}cd ${quote([projectPath])} 2>/dev/null || true;${restore}`;
};

interface RollingDeployPlan {
	script: ReturnType<typeof getRollingReplaceScript> | null;
	rolled: string[];
	/** Lines for the deploy log: why a selected service is not rolled. */
	notices: string[];
}

/**
 * Decides, for this deploy, which selected services are rolled. Never throws
 * and never fails a deploy: a setting that no longer fits the compose (drift)
 * degrades to the normal recreate for that service, with a notice in the log.
 */
const getRollingDeployPlan = async ({
	compose,
	freshVolumes,
	remoteBuild,
	invocation,
	patches,
}: {
	compose: ComposeNested;
	freshVolumes: boolean;
	remoteBuild: boolean;
	invocation: string;
	patches?: Patch[];
}): Promise<RollingDeployPlan> => {
	const off: RollingDeployPlan = { script: null, rolled: [], notices: [] };
	const settings = resolveComposeRolling(compose.rollingReplace);
	if (!settings) return off;
	const skipped = (reason: string): RollingDeployPlan => ({
		...off,
		notices: [
			`Rolling replace is off for this deploy: ${reason} Deploying normally.`,
		],
	});

	if (compose.composeType !== "docker-compose") {
		return skipped("it only applies to Docker Compose services, not stacks.");
	}
	if (compose.command) {
		return skipped("the compose has a custom command.");
	}
	if (freshVolumes) {
		return skipped("this deploy recreates the volumes.");
	}

	let rawSpec: RollingSpec | null = null;
	try {
		rawSpec = (await addDomainToCompose(compose, compose.domains, {
			patches,
		})) as unknown as RollingSpec | null;
	} catch {
		rawSpec = null;
	}
	if (!rawSpec?.services) {
		return skipped("the compose file could not be read.");
	}

	// Judged on the values Compose will use (`deploy.replicas: ${N:-1}`); the
	// compose file that is written is the raw one, untouched.
	const interpolated = interpolateRollingSpec(rawSpec, settings.services, () =>
		getComposeInterpolationLookup(compose),
	);
	const spec = interpolated.spec;

	const plan = planRollingServices({
		settings,
		spec,
		composeType: compose.composeType,
		hasCustomCommand: false,
		freshVolumes,
	});
	const notices = [
		...interpolated.notices.map(({ message }) => message),
		...plan.fallbacks.map(
			({ service, blockers }) =>
				`Rolling replace: "${service}" is recreated normally this time. ${describeRollingBlockers(blockers)}`,
		),
	];
	if (plan.rolled.length === 0) return { ...off, notices };
	if (plan.healthTimeoutSeconds !== settings.healthTimeoutSeconds) {
		notices.push(
			`Rolling replace: the health wait is raised from ${settings.healthTimeoutSeconds}s to ${plan.healthTimeoutSeconds}s to cover the healthchecks.`,
		);
	}

	for (const service of plan.rolled) {
		const count = plan.replicas[service] ?? 1;
		if (count > 1) {
			notices.push(
				`Rolling replace: "${service}" runs ${count} replicas. ${count} new replicas start next to them, and the old ones are taken out of rotation and removed only once every new one is healthy.`,
			);
		}
	}

	// A rolled service whose healthcheck cannot honour the drain marker still
	// rolls; only the take-out before the stop is missing.
	for (const warning of getRollingDrainWarnings(spec, plan.rolled)) {
		notices.push(`Rolling replace: ${warning.message}`);
	}

	const definitions = spec.services ?? {};
	const hasBuild = (service: string) =>
		Boolean((definitions[service] as { build?: unknown } | null)?.build);
	const script = getRollingReplaceScript({
		appName: compose.appName,
		invocation,
		services: plan.rolled,
		replicas: plan.replicas,
		// A build server pulled the images before this script runs.
		buildServices: remoteBuild ? [] : plan.rolled.filter(hasBuild),
		pullServices:
			remoteBuild || !compose.pullImagesOnDeploy
				? []
				: plan.rolled.filter((service) => !hasBuild(service)),
		remoteBuild,
		pullAlways: Boolean(compose.pullImagesOnDeploy),
		healthTimeoutSeconds: plan.healthTimeoutSeconds,
		drainSeconds: settings.drainSeconds,
	});
	return { script, rolled: plan.rolled, notices };
};

export const getBuildComposeCommand = async (
	rawCompose: ComposeNested,
	options: BuildComposeCommandOptions = {},
) => {
	const { deploymentId, freshVolumes = false, remoteBuild, patches } = options;
	const compose = await withResolvedVaultRefs(rawCompose);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { sourceType, appName, mounts, composeType, domains } = compose;
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	// Opt-in deploy guardrails (null = all off). Every piece below is an empty
	// string when its flag is off, so a compose that did not opt in gets the
	// same script as before.
	const guardrails = resolveDeployGuardrails(compose.deployGuardrails);
	const phaseTimestamps = guardrails?.phaseTimestamps === true;
	if (compose.buildServerId && !remoteBuild) {
		// Fail closed: a compose that opted into a build server must never fall
		// back to building on the serving host.
		throw new Error(
			"This compose builds on a build server, but no remote build result was provided; refusing to build on the serving host.",
		);
	}
	const remoteOptions: CreateCommandRemoteOptions | undefined = remoteBuild
		? {
				overridePath:
					remoteBuild.images.length > 0
						? getComposeBuildOverridePath(compose)
						: undefined,
			}
		: undefined;
	const command = createCommand(
		compose,
		mounts.length > 0 ? projectPath : undefined,
		remoteOptions,
	);

	// Opt-in rolling replace (null = off, which is every existing row). It takes
	// the place of the single `up` below for the selected services; when it
	// cannot apply, the deploy is the plain one and the log says why. Decided
	// before the compose is staged: the healthcheck of a rolled service is
	// written into it (see `rollingDrainServices`).
	const rolling = await getRollingDeployPlan({
		compose,
		freshVolumes,
		remoteBuild: Boolean(remoteBuild),
		invocation: getComposeUpPrefix(
			compose,
			mounts.length > 0 ? projectPath : undefined,
			remoteOptions,
		),
		patches,
	});

	// The stack env, the env file and the compose are staged on the host before
	// the script runs; if a later one cannot be, the earlier ones are not left
	// behind.
	const staged: string[] = [];
	const stageOptions = {
		deploymentId,
		onStaged: (stagedPaths: string[]) => staged.push(...stagedPaths),
	};
	let stackEnvFile: string | undefined;
	let envCommand = "";
	let newCompose = "";
	try {
		stackEnvFile = await stageStackEnvFile(compose, stageOptions);
		envCommand = compose.createEnvFile
			? await getCreateEnvFileCommand(compose, {
					...stageOptions,
					alsoRemove: [...staged],
				})
			: "";
		// The staged envs go with the compose step if that one stops the script.
		newCompose = await writeDomainsToCompose(compose, domains, {
			...stageOptions,
			alsoRemove: [...staged],
			patches,
			// Only a deploy that rolls changes the healthchecks it writes.
			...(rolling.rolled.length > 0
				? { rollingDrainServices: rolling.rolled }
				: {}),
		});
	} catch (error) {
		await removeStagedFiles(compose.serverId, staged);
		throw error;
	}
	// A stack says why a name is missing from its docker environment (what
	// `docker stack deploy` interpolates from) and, with Create env file, why
	// it is missing from the .env: the two reasons differ. The .env notice is
	// left to the build server when there is one (T-10377).
	const droppedDotenvLine = remoteBuild ? "" : getDroppedDotenvLogLine(compose);
	const ignoredEnvNotice =
		getIgnoredEnvNotice(getIgnoredEnvNames(compose)) +
		(droppedDotenvLine ? ` echo ${quote([droppedDotenvLine])};` : "");
	const rollingLogLine = rolling.script
		? `\nRolling replace: ${rolling.rolled.join(", ")} 🔁`
		: "";

	const logContent = `
App Name: ${appName}
Build Compose 🐳
Detected: ${mounts.length} mounts 📂
Command: docker ${command}
Source Type: docker ${sourceType} ✅
Compose Type: ${composeType} ✅${rollingLogLine}`;

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
	const qLastGoodCompose = quote([join(backupDir, LAST_GOOD_COMPOSE_BAK)]);
	const qLastGoodEnv = quote([join(backupDir, LAST_GOOD_ENV_BAK)]);

	const restoreCommands = getRestoreCommands(compose, {
		command,
		deploymentId,
		isTransactional,
		projectPath: mounts.length > 0 ? projectPath : "",
	});

	// Refresh the known-good snapshot after a successful deploy. Wrapped so it
	// can never turn a successful deploy into a failed one, and so a partial
	// refresh drops the snapshot entirely instead of leaving a compose file
	// paired with a stale `.env`.
	let persistLastGood = "";
	if (isTransactional) {
		let overrideSnapshot = "";
		let overrideCleanup = "";
		if (compose.buildServerId) {
			const qOverrideFile = quote([getComposeBuildOverridePath(compose)]);
			const qLastGoodOverride = quote([
				join(backupDir, LAST_GOOD_OVERRIDE_BAK),
			]);
			overrideSnapshot = ` && { { [ -f ${qOverrideFile} ] && cp ${qOverrideFile} ${qLastGoodOverride}; } || rm -f ${qLastGoodOverride}; }`;
			overrideCleanup = ` ${qLastGoodOverride}`;
		}
		// The `.env` is copied only when it resolves inside the checkout (T-7857);
		// on a host that cannot resolve links the previous copy is left alone.
		const qCodeDirectory = quote([getComposeCodeDirectory(compose)]);
		persistLastGood = `
		__dokploy_no_resolve=0
		${getPathResolverLines("__dokploy_no_resolve=1; __dokploy_resolve() { return 1; }").join("\n")}
		{ mkdir -p ${qBackupDir} && cp ${qComposeFile} ${qLastGoodCompose} && { { [ -f ${qEnvFile} ] && __dokploy_inside ${qCodeDirectory} ${qEnvFile} && cp ${qEnvFile} ${qLastGoodEnv}; } || [ "$__dokploy_no_resolve" = "1" ] || rm -f ${qLastGoodEnv}; }${overrideSnapshot}; } 2>/dev/null || { rm -f ${qLastGoodCompose} ${qLastGoodEnv}${overrideCleanup} 2>/dev/null; echo "Warning: ⚠️ Could not refresh the last-good snapshot"; true; }
		`;
	}

	// Serving side of a build-server deploy: pull exactly the images the
	// build server pushed (already logged in, see prepareComposeBuildServerDeploy),
	// then `up --no-build`. Inside the guarded line below, so a failed pull restores
	// the previous release like a failed `up`.
	let remotePullBlock = "";
	if (remoteBuild && remoteBuild.images.length > 0) {
		// Services that share one image share one reference: pull it once.
		const refs = [...new Set(remoteBuild.images.map((image) => image.image))];
		const pulls = refs.map((ref) => `docker pull ${quote([ref])}`).join(" && ");
		const pullPhaseStart = phaseTimestamps
			? `\n\t\t${getPhaseStartCommand("Pull images")}`
			: "";
		const pullPhaseEnd = phaseTimestamps
			? `\n\t\tif [ "$PULL_OK" = "1" ]; then ${getPhaseEndCommand("finished")} else ${getPhaseEndCommand("failed")} fi`
			: "";
		remotePullBlock = `
		PULL_OK=1;
		echo ${quote([`Pulling images on ${remoteBuild.servingHostLabel} (${refs.length} built on the build server)`])};${pullPhaseStart}
		if [ "$PULL_OK" = "1" ]; then { ${pulls}; } 2>&1 || PULL_OK=0; fi${pullPhaseEnd}`;
	}
	const cleanEnvPrefix = getCleanEnvPrefix(stackEnvFile);
	// The rolling replace is one shell function that takes the place of the
	// docker line; without it this is the single docker line it always was.
	const upCommand = rolling.script
		? rolling.script.call
		: `${withCleanEnvironment(command.split(" ").join(" "), cleanEnvPrefix, Boolean(compose.command))} 2>&1`;
	const upLine = remotePullBlock
		? `if [ "$PULL_OK" = "1" ]; then ${upCommand}; else false; fi`
		: upCommand;
	// The staged stack env is removed once `up` is done with it: before the
	// script stops on the failure branch, right after `up` on the success one.
	const stackEnvCleanup = stackEnvFile ? `rm -f ${quote([stackEnvFile])};` : "";

	// Guardrails around the docker line: the phase helpers go first, the docker
	// events capture and the stall snapshots start right before `up`, and all
	// are closed right after it returns (on the failure branch as well, before the restore runs).
	const upPhaseName = rolling.script
		? "Rolling replace (compose up)"
		: remotePullBlock
			? "Start containers (compose up)"
			: composeType === "stack"
				? "Deploy stack (docker stack deploy)"
				: "Build and start containers (compose up)";
	const helpersBlock = phaseTimestamps
		? `${getPhaseHelpersScript()}\n\t\t`
		: "";
	// Notices (why a service is not rolled) and the rolling functions: empty
	// strings unless the compose opted in.
	const rollingBlock = [
		...rolling.notices.map(getRollingNoticeCommand),
		rolling.script?.definitions ?? "",
	]
		.filter(Boolean)
		.map((part) => `${part}\n\t\t`)
		.join("");
	// A failed rolling deploy restores the previous release only while nothing
	// has been promoted yet (see getRollingRestoreGuard).
	const failureRestore = rolling.script
		? getRollingRestoreGuard(restoreCommands)
		: restoreCommands;
	const preUp = [
		phaseTimestamps ? getPhaseStartCommand(upPhaseName) : "",
		guardrails?.dockerEvents
			? getDockerEventsStartScript(composeType, appName)
			: "",
		// After the events capture: both share the EXIT trap (see the generator).
		guardrails?.stallSnapshot
			? getStallSnapshotStartScript(
					composeType,
					appName,
					guardrails.stallSnapshot,
				)
			: "",
	]
		.filter(Boolean)
		.map((part) => `${part}\n\t\t`)
		.join("");
	const upFailureGuardrails = `${guardrails?.stallSnapshot ? `${STALL_SNAPSHOT_CLEANUP_COMMAND} ` : ""}${guardrails?.dockerEvents ? `${DOCKER_EVENTS_FLUSH_COMMAND} ` : ""}${phaseTimestamps ? `${getPhaseEndCommand("failed")} ` : ""}`;
	const upSuccessBlock = [
		stackEnvCleanup,
		guardrails?.stallSnapshot ? STALL_SNAPSHOT_CLEANUP_COMMAND : "",
		guardrails?.dockerEvents ? DOCKER_EVENTS_FLUSH_COMMAND : "",
		phaseTimestamps ? getPhaseEndCommand("finished") : "",
	]
		.filter(Boolean)
		.map((part) => `${part}\n\t\t`)
		.join("");
	// `docker stack deploy` returns before any task runs, so the check would pass
	// vacuously: say so in the log instead of pretending to gate the release.
	const healthCheckSection = guardrails?.healthCheck
		? composeType === "stack"
			? `echo ${quote([HEALTH_CHECK_STACK_SKIPPED_MESSAGE])};\n\t\t`
			: getHealthCheckScript(guardrails.healthCheck, { phaseTimestamps })
		: "";

	// Without a build server this is the single docker line it always was.
	const upSection = remotePullBlock
		? `${remotePullBlock}\n\t\t${preUp}${upLine}`
		: `${preUp}${upLine}`;

	const bashCommand = `
	set -e
	{
		echo "${logBox}";${ignoredEnvNotice}

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
		${rollingBlock}${helpersBlock}${upSection} || { ${upFailureGuardrails}echo "Error: ❌ Docker command failed"; ${failureRestore} ${stackEnvCleanup ? `${stackEnvCleanup} ` : ""}exit 1; }
		${upSuccessBlock}${compose.isolatedDeployment ? `docker network connect ${compose.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1` : ""}
		${healthCheckSection}${persistLastGood}

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

/** The `-f` / `-c` argument shared by every command that reads the compose file. */
const getComposeFileArg = (compose: ComposeNested) => {
	const path =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	return quote([path]);
};

/**
 * `compose -p <app> [--project-directory ..] [--env-file ..] -f <file>`: the
 * invocation prefix every `docker compose` command for this service shares, so
 * the build on a build server resolves the project exactly like the deploy.
 */
export const getComposeBaseArgs = (
	compose: ComposeNested,
	projectPath?: string,
) => {
	const projectDirectoryFlag = projectPath
		? `--project-directory ${quote([projectPath])} `
		: "";
	const envFileFlag = compose.createEnvFile
		? `--env-file ${quote([join(dirname(compose.composePath || "docker-compose.yml"), ".env")])} `
		: "";
	return `compose -p ${quote([compose.appName])} ${projectDirectoryFlag}${envFileFlag}-f ${getComposeFileArg(compose)}`;
};

export interface CreateCommandRemoteOptions {
	/**
	 * Absolute path of the build override to merge on top of the compose file.
	 * Omitted when no service of the compose has a `build:` section.
	 */
	overridePath?: string;
}

/**
 * `compose -p <app> ... -f <file> [-f <build override>]`: the invocation
 * prefix of the deploy's own `up`. The rolling replace runs its other
 * subcommands (config, build, pull, up per service) with the very same prefix.
 */
export const getComposeUpPrefix = (
	compose: ComposeNested,
	projectPath?: string,
	remote?: CreateCommandRemoteOptions,
) => {
	const overrideFlag = remote?.overridePath
		? ` -f ${quote([remote.overridePath])}`
		: "";
	return `${getComposeBaseArgs(compose, projectPath)}${overrideFlag}`;
};

export const createCommand = (
	compose: ComposeNested,
	projectPath?: string,
	remote?: CreateCommandRemoteOptions,
) => {
	const { composeType, appName } = compose;
	if (compose.buildServerId) {
		if (compose.command) {
			throw new Error(
				"A custom compose command cannot be combined with a build server.",
			);
		}
		if (!remote) {
			throw new Error(
				"This compose builds on a build server; the serving host never builds.",
			);
		}
	}
	if (compose.command) {
		return `${sanitizeCommand(compose.command)}`;
	}

	let command = "";

	if (composeType === "docker-compose") {
		// When enabled, force-pull the latest images before (re)deploying so a
		// redeploy picks up updated tags instead of reusing the local cache.
		// (`stack deploy` already resolves+pulls, so this only applies here.)
		const pullFlag = compose.pullImagesOnDeploy ? " --pull always" : "";
		// With a build server the images already exist in the registry, so the
		// serving host must never build: `--no-build` turns a missing image into a
		// pull (or an error) instead of a local build.
		const buildFlag = remote ? " --no-build" : " --build";
		command = `${getComposeUpPrefix(compose, projectPath, remote)} up -d${pullFlag}${buildFlag} --remove-orphans`;
	} else if (composeType === "stack") {
		// `stack deploy` ignores `build:`; the override swaps in the pushed images.
		const overrideFlag = remote?.overridePath
			? ` -c ${quote([remote.overridePath])}`
			: "";
		command = `stack deploy -c ${getComposeFileArg(compose)}${overrideFlag} ${quote([appName])} --prune --with-registry-auth`;
	}

	return command;
};

/**
 * The variables of the compose `.env` before they are resolved and quoted
 * (`getCreateEnvFileCommand` writes them; the rolling replace reads them to
 * interpolate the spec it judges).
 */
const getComposeEnvFileSource = (
	compose: Pick<ComposeNested, "env" | "appName" | "randomize" | "suffix">,
) => {
	const { env, appName } = compose;
	let envContent = `APP_NAME=${appName}\n`;
	envContent += `COMPOSE_PROJECT_NAME=${appName}\n`;
	envContent += env || "";
	if (!envContent.includes("DOCKER_CONFIG")) {
		envContent += "\nDOCKER_CONFIG=/root/.docker";
	}

	if (compose.randomize) {
		envContent += `\nCOMPOSE_PREFIX=${compose.suffix}`;
	}
	return envContent;
};

/**
 * The variables `docker compose` interpolates the compose file with on this
 * deploy, as far as Dokploy can know them: the docker process runs under
 * `env -i` with PATH, HOME (both unknown here) and the neutralised CLI
 * settings (empty), which take precedence over the `.env` Dokploy writes. A
 * `.env` value that holds `${` is expanded by compose's own dotenv parser, so
 * it counts as unknown. Without `createEnvFile` compose reads whatever `.env`
 * the repository has: every other name is unknown.
 *
 * Throws when the variables cannot be prepared (an unresolved vault reference,
 * an invalid `${{...}}` reference): the caller keeps the raw spec.
 */
export const getComposeInterpolationLookup = (
	compose: Pick<
		ComposeNested,
		"env" | "appName" | "randomize" | "suffix" | "createEnvFile"
	> & {
		environment: {
			env: string | null;
			project: { env: string | null };
		};
	},
): ComposeVariableLookup => {
	const values = new Map<string, string>();
	const unknown = new Set<string>(["PATH", "HOME"]);
	if (compose.createEnvFile) {
		const pairs = prepareEnvironmentVariables(
			getComposeEnvFileSource(compose),
			compose.environment.project.env,
			compose.environment.env,
		);
		for (const pair of pairs) {
			const [name, value] = parseEnvironmentKeyValuePair(pair);
			if (name === "COMPOSE_PROJECT_NAME") {
				values.set(name, compose.appName);
				continue;
			}
			if (!isComposeDotenvName(name)) continue;
			if (value.includes("${")) {
				unknown.add(name);
				values.delete(name);
				continue;
			}
			unknown.delete(name);
			values.set(name, value);
		}
	}
	for (const name of NEUTRALISED_CLI_ENV_NAMES) {
		unknown.delete(name);
		values.set(name, "");
	}
	// The docker process always has its own PATH and HOME, whatever the `.env` says.
	unknown.add("PATH");
	unknown.add("HOME");
	values.delete("PATH");
	values.delete("HOME");
	const lookup = createComposeVariableLookup(values, unknown);
	if (compose.createEnvFile) return lookup;
	return (name) => (values.has(name) ? lookup(name) : UNKNOWN_VALUE);
};

/**
 * Shell snippet that writes the compose `.env`. The content (it holds the
 * service's secrets) is staged out of band, 0600, instead of being embedded in
 * the script: a large env counts toward the 128 KB limit on a single shell
 * argument, and an embedded value would show in the host's process list.
 */
export const getCreateEnvFileCommand = async (
	compose: ComposeNested,
	options: StageOptions & {
		/** Other files staged for the same script, removed if this step stops it. */
		alsoRemove?: string[];
	} = {},
) => {
	const { appName } = compose;
	const envFilePath = getComposeEnvFilePath(compose);

	const envContent = getComposeEnvFileSource(compose);

	const prepare = (content: string) => {
		const quoted = prepareEnvironmentVariablesForFile(
			content,
			compose.environment.project.env,
			compose.environment.env,
		);
		if (compose.composeType !== "stack") return quoted;
		// A stack's file is written unquoted (its services read it as an
		// `env_file`, where quotes are literal), but a value with a line break
		// would put its next lines in the file as variables of their own, so
		// compose would read a `COMPOSE_FILE=` the filter below never saw. Those
		// are written quoted, like a compose's. Both lists are in the same order.
		return prepareEnvironmentVariables(
			content,
			compose.environment.project.env,
			compose.environment.env,
		).map((pair, index) =>
			/[\r\n]/.test(pair) ? (quoted[index] ?? pair) : pair,
		);
	};
	// Compose reads the `COMPOSE_*` settings of this file as if they were in its
	// environment (see isComposeDotenvName), so a user's are left out, and the
	// project name is always Dokploy's own, whatever the Environment holds.
	const projectNameLine = prepare(`COMPOSE_PROJECT_NAME=${appName}`).join("");
	const envFileContent = prepare(envContent)
		.flatMap((pair) => {
			const name = getPairName(pair);
			if (name === "COMPOSE_PROJECT_NAME") return [projectNameLine];
			return isComposeDotenvName(name) ? [pair] : [];
		})
		.join("\n");

	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const stageDirectory = join(COMPOSE_PATH, appName);
	const stagedPath = getStagedFilePath({
		directory: stageDirectory,
		kind: "env",
		deploymentId: options.deploymentId,
	});
	await stageFiles({
		serverId: compose.serverId,
		directory: stageDirectory,
		files: [{ path: stagedPath, content: envFileContent }],
	});
	options.onStaged?.([stagedPath]);

	// The new `.env` takes the mode and owner of the one it replaces. A `.env`
	// that is a symlink (the repository can bring one, pointing at another
	// compose's `.env`) is replaced by a regular file, never written through
	// (T-7135, T-7857).
	return `
${getInstallStagedFileCommand({
	staged: stagedPath,
	destination: envFilePath,
	failureMessage: "❌ Error: Could not write the environment file",
	alsoRemove: options.alsoRemove,
	// Replaced by a renamed temporary file, in the directory of the compose
	// file and only when that is inside the checkout (T-7857).
	atomicIn: getComposeCodeDirectory(compose),
})}
	`;
};

const getPairName = (pair: string) => pair.slice(0, pair.indexOf("="));

// Added by getComposeEnvFileSource; the user's only if their Environment has a key of the same name.
const DOKPLOY_ENV_NAMES = new Set([
	"COMPOSE_PREFIX",
	"COMPOSE_PROJECT_NAME",
	"DOCKER_CONFIG",
]);

/**
 * Names of the variables the `.env` writer sees (the Environment plus the ones
 * Dokploy adds), or none when they cannot be prepared: these feed log lines,
 * and a log line must never fail a deploy. The names Dokploy adds on its own
 * are left out; a user's variable of the same name is kept.
 */
const getEnvFileNames = (compose: ComposeNested) => {
	try {
		// The user's keys are read as the writer reads them, but not resolved:
		// a `${{APP_NAME}}` only resolves against the source with Dokploy's own.
		const userNames = new Set(Object.keys(parse(compose.env ?? "")));
		return prepareEnvironmentVariables(
			getComposeEnvFileSource(compose),
			compose.environment.project.env,
			compose.environment.env,
		)
			.map(getPairName)
			.filter((name) => !DOKPLOY_ENV_NAMES.has(name) || userNames.has(name));
	} catch {
		return [];
	}
};

/**
 * Names in the Environment that a stack keeps out of the environment of its
 * docker process because docker would read them as its own settings. Sorted,
 * empty for a compose. Only names, never values.
 */
export const getIgnoredEnvNames = (compose: ComposeNested) => {
	if (compose.composeType !== "stack") return [];
	return [
		...new Set(
			getEnvFileNames(compose).filter(
				(name) => ENV_VARIABLE_NAME.test(name) && !isStackEnvName(name),
			),
		),
	].sort();
};

/**
 * Names in the Environment whose values `getCreateEnvFileCommand` leaves out of
 * the `.env` because compose or the shell would read them as their own
 * settings. A name Dokploy writes itself (COMPOSE_PROJECT_NAME) is listed when
 * the user set it: the user's value is dropped and Dokploy's replaces it.
 * Sorted, empty without `createEnvFile`. Only names, never values.
 */
export const getDroppedDotenvNames = (compose: ComposeNested) => {
	if (!compose.createEnvFile) return [];
	return [
		...new Set(getEnvFileNames(compose).filter((n) => !isComposeDotenvName(n))),
	].sort();
};

/** The deploy log text for the names `getCreateEnvFileCommand` left out, or "". */
export const getDroppedDotenvLogLine = (compose: ComposeNested) =>
	getDroppedDotenvNotice(getDroppedDotenvNames(compose));

/** The deploy log line for `getIgnoredEnvNames`, or "" when there are none. */
const getIgnoredEnvNotice = (names: string[]) => {
	if (names.length === 0) return "";
	return ` echo ${quote([`Warning: ⚠️ Not passed to docker, because docker and compose read them as their own settings: ${formatNameList(names)}`])};`;
};

/**
 * Content of the file that carries a stack's environment: one `KEY='value'`
 * per line, sourced under `set -a` by the loader `getCleanEnvPrefix` emits.
 * A name that is not a valid shell identifier is left out: `docker stack
 * deploy` can only interpolate identifiers, and any other name would not
 * survive being sourced. So is a name docker or compose reads as a setting of
 * its own (`DOCKER_HOST`, `DOCKER_CONFIG`, `COMPOSE_FILE`, `PATH`, ...; see
 * `isStackEnvName`): the file is the whole environment of the docker process,
 * and with one of those a stack could aim the CLI at another daemon or make it
 * run a host binary.
 */
export const buildStackEnvFileContent = (envVars: Record<string, string>) =>
	Object.entries(envVars)
		.filter(([key]) => isStackEnvName(key))
		.map(([key, value]) => `${key}=${singleQuote(value)}\n`)
		.join("");

/** Empty when the compose is not a stack or has no variables. */
export const getStackEnvFileContent = (compose: ComposeNested) => {
	if (compose.composeType !== "stack") return "";

	return buildStackEnvFileContent(
		getEnvironmentVariablesObject(
			compose.env,
			compose.environment.project.env,
			compose.environment.env,
		),
	);
};

/**
 * Stages a stack's environment as a 0600 file next to the compose directory
 * and returns its path (`undefined` when there is nothing to stage). Embedding
 * the variables in the deploy script put them in the host's process list and
 * counted them, up to three times, toward the 128 KB limit on one shell
 * argument. The script that uses the file removes it.
 */
export const stageStackEnvFile = async (
	compose: ComposeNested,
	options: StageOptions = {},
) => {
	const content = getStackEnvFileContent(compose);
	if (!content) return undefined;

	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const directory = join(COMPOSE_PATH, compose.appName);
	const stagedPath = getStagedFilePath({
		directory,
		kind: "stack-env",
		deploymentId: options.deploymentId,
	});
	await stageFiles({
		serverId: compose.serverId,
		directory,
		files: [{ path: stagedPath, content }],
	});
	options.onStaged?.([stagedPath]);
	return stagedPath;
};

/**
 * Words that load the staged stack env into the command that follows them:
 * `sh` sources the file with every assignment exported, then `exec`s the
 * command. Only the file's path is on the command line, never a value.
 *
 * `|| exit 1` keeps a missing or unreadable file fatal on every `sh`, not only
 * on those where a failed `.` already ends the shell, so docker never runs
 * without the stack's variables. A variable the target `sh` keeps read-only
 * (`UID`, `PPID` when `sh` is bash) fails the deploy as well; `env KEY=value`
 * used to pass those through.
 */
const getStackEnvLoader = (stagedPath: string) =>
	`sh -c 'set -a; . "$1" || exit 1; set +a; shift; exec "$@"' sh ${quote([stagedPath])}`;

/**
 * `env -i` prefix every docker invocation of a deploy runs under: the host's
 * environment is dropped except PATH and HOME (docker needs HOME for its
 * registry credentials), and a stack gets its own variables from the staged
 * env file. The settings docker and its children read from the environment
 * (`DOCKER_HOST`, `LD_PRELOAD`, ...) are set empty, so a `.env` that compose
 * before v2.39.3 copies into its own environment cannot supply them (see
 * `NEUTRALISED_CLI_ENV`). `docker ...` follows it.
 */
/**
 * `<prefix> docker <command>`, with the prefix before EVERY docker command
 * when `chained`: a custom command may chain `docker compose` commands with
 * `&&` (see sanitizeCommand, which allows nothing else), and a command after
 * the first that did not get the prefix would run with the whole environment
 * of the Dokploy process or of the ssh session, and read the project `.env`
 * without a stack's staged variables. Only a custom command is split: the
 * generated ones can hold an `&&` inside a quoted path.
 */
export const withCleanEnvironment = (
	command: string,
	prefix: string,
	chained: boolean,
) =>
	(chained ? command.split("&&").map((segment) => segment.trim()) : [command])
		.map(
			(segment, index) =>
				`${prefix} ${index === 0 ? "docker " : ""}${segment}`,
		)
		.join(" && ");

export const getCleanEnvPrefix = (stackEnvFile?: string) =>
	`env -i PATH="$PATH" HOME="$HOME" ${NEUTRALISED_CLI_ENV} ${stackEnvFile ? getStackEnvLoader(stackEnvFile) : ""}`;
