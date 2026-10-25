import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	type ComposeNested,
	getComposeBuildOverridePath,
	getCreateEnvFileCommand,
	getRestoreAfterFailedBuildCommand,
	type RemoteBuildDeployInfo,
	stageStackEnvFile,
} from "@dokploy/server/utils/builders/compose";
import {
	buildComposeOverrideYaml,
	type ComposePushedImage,
	getBuiltImageRepoName,
	getBuiltImageTag,
	getCloneCompleteCommand,
	getComposeBuildCommand,
	getComposeBuildServiceCommand,
	getComposeBuildSettingsError,
	getComposeConfigJsonCommand,
	getReusableCloneProbeCommand,
	getTagAndPushCommand,
	getWriteFileCommand,
	parseBuiltServices,
	REUSABLE_CLONE_ANSWER,
} from "@dokploy/server/utils/builders/compose-remote-build";
import { getRemoteBuildCancelTarget } from "@dokploy/server/utils/builders/remote-build-cancel";
import {
	getRegistryTag,
	loginDockerRegistry,
} from "@dokploy/server/utils/cluster/upload";
import { writeDomainsToCompose } from "@dokploy/server/utils/docker/domain";
import {
	removeStagedFiles,
	type StageOptions,
} from "@dokploy/server/utils/docker/staging";
import {
	encodeBase64,
	getCreateFilesCommand,
} from "@dokploy/server/utils/docker/utils";
import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { redactSecrets } from "@dokploy/server/utils/process/redactSecrets";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import {
	COMMIT_READ_FAILED,
	describeUnreadableCommit,
	getCheckedOutCommitCommand,
	parseCheckedOutCommit,
} from "@dokploy/server/utils/providers/pin-commit";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";
import { withResolvedVaultRefs } from "@dokploy/server/utils/vault";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { assertComposeVolumesBound } from "./compose-volume-binding";
import {
	assertDeploymentNotCancelled,
	isDeploymentCancelledError,
	toCancelledErrorIfCancelled,
} from "./deployment-cancel";
import { generateApplyPatchesCommand, type Patch } from "./patch";
import { findRegistryByIdWithCredentials } from "./registry";
import { findServerById } from "./server";

/**
 * Build-server flow for compose services.
 *
 * `docker compose up --build` normally builds on the serving host. A compose
 * that sets `buildServerId` + `buildRegistryId` instead:
 *
 *   1. clones the source on the build server (same provider code, run remotely),
 *      pinned to the commit the serving host fetched and checked,
 *   2. runs `docker compose build` there,
 *   3. tags and pushes every built service to the build registry as
 *      `<registry>/<appName>-<service>:dpl-<deploymentId>` (and `:latest`),
 *   4. writes `docker-compose.dokploy-build.yml` on the serving host, an
 *      override that pins each built service to the pushed image,
 *
 * after which the serving host only logs in, pulls and runs `up --no-build`
 * (see `getBuildComposeCommand`). The commands themselves are built by
 * `utils/builders/compose-remote-build.ts`; this file decides which host runs
 * which one and streams their output into the deployment log.
 */

/** The minimal compose shape the build-server settings are validated on. */
export interface ComposeBuildSettingsInput {
	buildServerId?: string | null;
	buildRegistryId?: string | null;
	command?: string | null;
}

/**
 * Validates a compose's build-server settings against the database: both or
 * neither of server and registry, the server must be of type `build`, the
 * registry must exist, and (when given) both must belong to `organizationId`.
 * Throws a BAD_REQUEST TRPCError with a message the UI can show verbatim.
 */
export const assertComposeBuildSettings = async (
	settings: ComposeBuildSettingsInput,
	organizationId?: string,
) => {
	const { buildServerId, buildRegistryId } = settings;
	let server: Awaited<ReturnType<typeof findServerById>> | null = null;
	let registry: Awaited<
		ReturnType<typeof findRegistryByIdWithCredentials>
	> | null = null;
	if (buildServerId) {
		server = await findServerById(buildServerId).catch(() => null);
	}
	if (buildRegistryId) {
		registry = await findRegistryByIdWithCredentials(buildRegistryId).catch(
			() => null,
		);
	}

	const message = getComposeBuildSettingsError({
		...settings,
		server,
		registry,
	});
	if (message) {
		throw new TRPCError({ code: "BAD_REQUEST", message });
	}
	if (
		organizationId &&
		((server && server.organizationId !== organizationId) ||
			(registry && registry.organizationId !== organizationId))
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "The build server and registry must belong to your organization",
		});
	}
};

const CONFIG_STDERR_MAX_LINES = 10;
const CONFIG_STDERR_MAX_LINE_LENGTH = 300;
// `NAME=value`, `NAME: value` or JSON-style `"NAME":"value"` where NAME is `KEY`,
// `*_KEY`, `*APIKEY` or `KEY*` (case-insensitive), with the value quoted or
// running to the line end. Dot-prefixed names (`services.web.environment.NAME`)
// are redacted like any other.
const KEY_ASSIGNMENT =
	/\b((?:[A-Za-z0-9_]*(?:_|API))?KEY[A-Za-z0-9_]*)(["']?)\s*[=:]\s*("[^"]*"|'[^']*'|.*)/gi;

// Compose's own "required variable NAME is missing a value" message follows a
// `NAME:` and carries no value, so it stays readable.
const scrubKeyAssignments = (line: string) =>
	line.replace(KEY_ASSIGNMENT, (match, name, quote, value) =>
		/^required variable/i.test(value) ? match : `${name}${quote}=[REDACTED]`,
	);

/**
 * What the deployment log says when `docker compose config` fails on the build
 * server. Its stderr can quote the environment: dotenv parse errors repeat the
 * offending line (`... near "<line>"`) and validation errors repeat resolved
 * values. So the lines naming a quoted source line are dropped, the rest is cut
 * to the first few lines, run through the shared redaction and an
 * `*KEY=value` scrub. With nothing left to show, only the exit code is logged.
 */
export const describeConfigFailure = (serverName: string, error: ExecError) => {
	const lines = (error.stderr ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.includes('near "'))
		.slice(0, CONFIG_STDERR_MAX_LINES)
		.map((line) =>
			scrubKeyAssignments(
				redactSecrets(line.slice(0, CONFIG_STDERR_MAX_LINE_LENGTH)),
			),
		);
	const head = `docker compose config failed on ${serverName}`;
	if (lines.length === 0) {
		if (error.exitCode === undefined) {
			return `${head}: the build server could not run docker compose config`;
		}
		// Say which it was: nothing printed, or something that was held back.
		return error.stderr?.trim()
			? `${head} (exit code ${error.exitCode}); error output withheld`
			: `${head} (exit code ${error.exitCode}) without any error output`;
	}
	return `${head}:\n${lines.join("\n")}`;
};

const MAX_LOG_CHUNK = 24 * 1024;
const LOG_FLUSH_MS = 1500;

/**
 * Appends build-server output to the deployment log, which lives on the
 * *serving* host (that is where the deployment record points), batching so a
 * chatty build does not open one SSH connection per output line.
 */
export const createDeploymentLogWriter = (
	serverId: string | null,
	logPath: string,
) => {
	let buffer = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let chain: Promise<void> = Promise.resolve();

	const write = async (text: string) => {
		if (!serverId) {
			await appendFile(logPath, text);
			return;
		}
		for (let i = 0; i < text.length; i += MAX_LOG_CHUNK) {
			const part = text.slice(i, i + MAX_LOG_CHUNK);
			await execAsyncRemote(
				serverId,
				`echo "${encodeBase64(part)}" | base64 -d >> ${quote([logPath])}`,
			);
		}
	};

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		const text = buffer;
		buffer = "";
		if (!text) return chain;
		chain = chain
			.then(() => write(text))
			.catch((error) => {
				// A log line must never fail the deploy it describes.
				console.error("Could not append to the deployment log", error);
			});
		return chain;
	};

	return {
		push: (data: string) => {
			buffer += data;
			if (buffer.length >= MAX_LOG_CHUNK) {
				void flush();
			} else if (!timer) {
				timer = setTimeout(() => void flush(), LOG_FLUSH_MS);
			}
		},
		line: (text: string) => {
			buffer += `${text}\n`;
			if (!timer) timer = setTimeout(() => void flush(), LOG_FLUSH_MS);
		},
		close: () => flush(),
	};
};

type ComposeBuildEntity = ComposeNested & {
	appName: string;
	composeId: string;
	buildServerId: string | null;
	buildRegistryId: string | null;
	server?: { name: string } | null;
};

const getCloneCommand = async (
	entity: ComposeNested,
	stageOptions: StageOptions,
	pinCommit: string | null,
) => {
	switch (entity.sourceType) {
		case "github":
			return cloneGithubRepository({ ...entity, type: "compose", pinCommit });
		case "gitlab":
			return cloneGitlabRepository({ ...entity, type: "compose", pinCommit });
		case "bitbucket":
			return cloneBitbucketRepository({
				...entity,
				type: "compose",
				pinCommit,
			});
		case "git":
			return cloneGitRepository({ ...entity, type: "compose", pinCommit });
		case "gitea":
			return cloneGiteaRepository({ ...entity, type: "compose", pinCommit });
		case "raw":
			return getCreateComposeFileCommand(entity, stageOptions);
		default:
			return "";
	}
};

/**
 * What `getCheckedOutCommitCommand` prints for the serving host's copy of the
 * compose. The deploy path reads it right after the fetch and a rebuild at
 * its start (see `runComposeBuild`); a read never fails the deploy here, an
 * empty answer is refused by `prepareComposeBuildServerDeploy`.
 * A read that could not run at all (an SSH failure) answers
 * `COMMIT_READ_FAILED`, so the refusal says so.
 */
export const readServingHostCommitOutput = async (entity: {
	appName: string;
	serverId: string | null;
}) => {
	const { COMPOSE_PATH } = paths(!!entity.serverId);
	const command = getCheckedOutCommitCommand(
		join(COMPOSE_PATH, entity.appName, "code"),
	);
	try {
		const result = entity.serverId
			? await execAsyncRemote(entity.serverId, command)
			: await execAsync(command);
		return result?.stdout ?? "";
	} catch {
		return COMMIT_READ_FAILED;
	}
};

/**
 * The commit checked out in the serving host's copy of the compose: the copy
 * the compose guards (`assertComposeVolumesBound` and the rest) checked. The
 * build server builds exactly this commit (T-7282). Throws when there is none:
 * building the branch tip instead would build unchecked code. The caller
 * reads it right after the fetch; a read made here, later, is not the same
 * thing, so a missing read is refused too.
 */
const resolveServingHostCommit = (stdout: string | undefined) => {
	if (stdout === undefined) {
		throw new Error(
			"The commit of the serving host was not read right after its fetch, so the build server cannot be pinned to it. Nothing was built.",
		);
	}
	const commit = parseCheckedOutCommit(stdout);
	if (!commit) {
		throw new Error(
			`Could not read the commit checked out on the serving host (${describeUnreadableCommit(stdout)}), so the build server cannot build the code that was checked there. Nothing was built; deploy again.`,
		);
	}
	return commit;
};

/**
 * Stage 1: everything that happens on the build server. Returns the images that
 * were pushed (empty when no service has a `build:` section).
 */
const buildImagesOnBuildServer = async (
	entity: ComposeBuildEntity,
	deployment: { logPath: string; deploymentId?: string },
	applyPatches: boolean,
	cancellable: boolean,
	reuseClone: boolean,
	pinned: { servingCommitOutput?: string; patches?: Patch[] },
): Promise<{ images: ComposePushedImage[] }> => {
	const { buildServerId, buildRegistryId } = entity;
	if (!buildServerId || !buildRegistryId) {
		throw new Error("Build Server and Build Registry must be set together.");
	}

	const buildServer = await findServerById(buildServerId);
	if (buildServer.serverType !== "build") {
		throw new Error(
			`Server "${buildServer.name}" is not a build server (type "${buildServer.serverType}").`,
		);
	}
	const registry = await findRegistryByIdWithCredentials(buildRegistryId);

	// Everything below runs against the build server's filesystem, so the paths
	// helpers must resolve to the remote layout.
	const resolved = await withResolvedVaultRefs(entity);
	const buildEntity = { ...resolved, serverId: buildServerId };
	const { COMPOSE_PATH } = paths(true);
	const codePath = join(COMPOSE_PATH, entity.appName, "code");
	const projectPath = resolved.mounts.length > 0 ? codePath : undefined;

	const log = createDeploymentLogWriter(entity.serverId, deployment.logPath);
	// Content that may be large or secret (a raw compose, patches, the .env, file
	// mounts) is staged on the build server instead of being embedded in a
	// command. Whatever a failed or cancelled build leaves staged is removed.
	const staged: string[] = [];
	const stackEnvStaged: string[] = [];
	const stageOptions: StageOptions = {
		deploymentId: deployment.deploymentId,
		onStaged: (paths) => staged.push(...paths),
	};
	// Every command runs in its own session with a pid file keyed by the
	// deployment id, so a cancel can stop exactly this deployment's build. The
	// cancel flag is checked before each step: a cancel between two steps (no
	// process to kill) must still stop the next one from starting.
	const cancelable =
		cancellable && deployment.deploymentId
			? getRemoteBuildCancelTarget(deployment.deploymentId)
			: undefined;
	const checkpoint = () =>
		cancellable
			? assertDeploymentNotCancelled(deployment.deploymentId)
			: Promise.resolve();
	const execOnBuildServer = async (
		command: string,
		onData?: (data: string) => void,
	) => {
		// Not cancelable (a preview): exactly the call it always was.
		if (!cancelable) {
			return onData
				? execAsyncRemote(buildServerId, command, onData)
				: execAsyncRemote(buildServerId, command);
		}
		try {
			return await execAsyncRemote(buildServerId, command, onData, {
				cancelable,
			});
		} catch (error) {
			// A cancel kills the step (or drops its connection): that failure is
			// the cancellation, not a build error.
			throw await toCancelledErrorIfCancelled(deployment.deploymentId, error);
		}
	};
	const run = async (command: string) => {
		await checkpoint();
		return execOnBuildServer(command, log.push);
	};
	// A failed login explains itself nowhere else: nothing has run that would
	// have written it to the log.
	const login = async (
		targetServerId: string | null,
		isolated: boolean,
		cancelTarget: typeof cancelable,
	) => {
		await checkpoint();
		try {
			return await loginDockerRegistry(registry, targetServerId, {
				isolated,
				cancelable: cancelTarget,
			});
		} catch (error) {
			const settled = await toCancelledErrorIfCancelled(
				deployment.deploymentId,
				error,
			);
			if (settled === error) {
				log.line(error instanceof Error ? error.message : String(error));
			}
			throw settled;
		}
	};
	// Raw composes have no checkout (the clone step only writes the file), so
	// they always take the normal path. Any probe failure falls back to cloning,
	// as a deploy does; only a cancel is let through. Only a checkout of the
	// serving host's commit is reused: an older one (a deploy that failed on
	// the build server, a compose that built on its serving host before) is
	// cloned again, pinned to that commit.
	const hasUsableCheckout = async (path: string, commit: string) => {
		if (entity.sourceType === "raw") return false;
		try {
			await checkpoint();
			const { stdout } = await execOnBuildServer(
				getReusableCloneProbeCommand(path, commit),
			);
			return stdout.includes(REUSABLE_CLONE_ANSWER);
		} catch (error) {
			if (isDeploymentCancelledError(error)) throw error;
			return false;
		}
	};

	try {
		log.line(
			`Building on build server ${buildServer.name} (${buildServer.ipAddress})`,
		);

		// The serving host fetched the source and checked its compose file;
		// the build server fetches it again. A push in between must not reach
		// the build, so the build server's checkout is pinned to the commit the
		// serving host holds. A raw compose has no checkout: both hosts write
		// the same file from the same row.
		let servingCommit: string | null = null;
		if (entity.sourceType !== "raw") {
			await checkpoint();
			servingCommit = resolveServingHostCommit(pinned.servingCommitOutput);
			log.line(
				`Building commit ${servingCommit}, the one checked on the serving host`,
			);
		}
		// The patch rows the serving host applied and checked, never a second
		// read: refused before anything runs on the build server.
		if (applyPatches && entity.sourceType !== "raw" && !pinned.patches) {
			throw new Error(
				"The patches the serving host applied were not passed to the build server, so it cannot apply the same ones. Nothing was built.",
			);
		}

		// A rebuild means "build the code already on disk", and the serving host
		// does not re-clone on one. Re-cloning here would build commits newer
		// than the serving host's bind mounts and config files, so reuse the
		// checkout from the last deploy when it is usable.
		const reusing =
			reuseClone &&
			servingCommit !== null &&
			(await hasUsableCheckout(codePath, servingCommit));
		if (reusing) {
			log.line(`Rebuilding from the existing clone on ${buildServer.name}`);
		} else {
			if (reuseClone) {
				log.line(`No reusable clone on ${buildServer.name}, cloning`);
			}
			// A cancel has to land before anything is staged, not after.
			await checkpoint();
			await run(
				`set -e;${await getCloneCommand(buildEntity, stageOptions, servingCommit)}`,
			);
		}

		if (applyPatches && entity.sourceType !== "raw") {
			await checkpoint();
			const patches = await generateApplyPatchesCommand(
				{
					id: entity.composeId,
					type: "compose",
					serverId: buildServerId,
					// The rows the serving host applied, not a second read.
					patches: pinned.patches,
				},
				stageOptions,
			);
			if (patches) await run(`set -e;${patches}`);
		}

		// Only now is the checkout complete; see getCloneCompleteCommand.
		if (!reusing && entity.sourceType !== "raw") {
			await run(`set -e;${getCloneCompleteCommand(codePath)}`);
		}

		// The clone script already refuses to end on another commit; this is
		// the check that holds whatever the clone command was, and for a reused
		// checkout. The checkout must still be the pinned commit here.
		if (servingCommit) {
			await checkpoint();
			const { stdout: headOut } = await execOnBuildServer(
				getCheckedOutCommitCommand(codePath),
			);
			const buildCommit = parseCheckedOutCommit(headOut);
			if (buildCommit !== servingCommit) {
				const found = buildCommit ? `commit ${buildCommit}` : "no commit";
				throw new Error(
					`The build server's checkout is ${found}, not commit ${servingCommit} that the serving host checked. Nothing was built; deploy again.`,
				);
			}
		}

		// The compose checks again, on the files this build server is about to
		// build (T-7960): its checkout and patches, the compose's settings as
		// they are now. The serving host's checks looked at the serving host's
		// files, which other steps (a restore, a running container) can change
		// without moving its commit. A raw compose's file is the row the serving
		// host checked.
		if (entity.sourceType !== "raw") {
			await checkpoint();
			await assertComposeVolumesBound({ ...entity, serverId: buildServerId });
		}

		// Same compose file the serving host will run (domains, randomize,
		// isolated deployment), and the same .env, so build args interpolate alike.
		await checkpoint();
		const writeCompose = await writeDomainsToCompose(
			buildEntity,
			buildEntity.domains,
			stageOptions,
		);
		const envCommand = buildEntity.createEnvFile
			? await getCreateEnvFileCommand(buildEntity, stageOptions)
			: "";
		await run(`set -e;${writeCompose}${envCommand}`);

		// File mounts live in `<compose>/files` on the serving host, where
		// `env_file:` / build secrets reach them as `../files/...`. Without them
		// `compose config` and `compose build` fail on a missing file.
		const filesDir = join(COMPOSE_PATH, entity.appName, "files");
		const fileMounts = (resolved.mounts ?? []).filter(
			(mount) => mount.type === "file" && mount.filePath,
		);
		if (fileMounts.length > 0) {
			await checkpoint();
			const mountsCommand = await getCreateFilesCommand({
				serverId: buildServerId,
				outputPath: filesDir,
				files: fileMounts.map((mount) => ({
					filePath: mount.filePath || "",
					content: mount.content || "",
				})),
				...stageOptions,
			});
			await run(`set -e;${mountsCommand}`);
		}

		// A stack's environment is staged once for the config and the build
		// commands; it is removed below whatever the outcome.
		await checkpoint();
		const stackEnvFile = await stageStackEnvFile(buildEntity, {
			deploymentId: deployment.deploymentId,
			onStaged: (paths) => stackEnvStaged.push(...paths),
		});

		// Not streamed: the resolved configuration contains the environment.
		await checkpoint();
		const configCommand = getComposeConfigJsonCommand(
			buildEntity,
			codePath,
			projectPath,
			stackEnvFile,
		);
		let stdout: string;
		try {
			({ stdout } = await execOnBuildServer(configCommand));
		} catch (error) {
			// Nothing else writes this failure down: the command is not streamed
			// (stdout is the resolved environment) and an ExecError is not logged by
			// the caller, so a compose that does not resolve (a `${VAR:?}` with no
			// value, a YAML error) used to fail with an empty log. Only a bounded,
			// scrubbed stderr is logged (the reason, not the resolved configuration),
			// never stdout or error.message, which carries the stdout tail when
			// stderr is empty. Plain errors (an SSH failure) are logged by the caller.
			if (error instanceof ExecError) {
				log.line(describeConfigFailure(buildServer.name, error));
			}
			throw error;
		}
		const builtServices = parseBuiltServices(stdout, entity.appName);

		if (builtServices.length === 0) {
			log.line(
				"No service has a build section, so there is nothing to build; the serving host will only pull.",
			);
			return { images: [] };
		}

		await run(
			getComposeBuildCommand(buildEntity, codePath, projectPath, stackEnvFile),
		);

		const tag = getBuiltImageTag(
			deployment.deploymentId ?? Date.now().toString(36),
		);
		// Services that share one image (the same `image:` name, e.g. through a
		// YAML anchor) are one build and one push: they all run the same
		// reference, named after the first service that uses it.
		const byLocalImage = new Map<string, ComposePushedImage>();
		const images: ComposePushedImage[] = builtServices.map((built) => {
			const shared = byLocalImage.get(built.localImage);
			if (shared)
				return { ...built, ref: shared.ref, latestRef: shared.latestRef };
			const repo = getBuiltImageRepoName(entity.appName, built.service);
			const pushed = {
				...built,
				ref: getRegistryTag(registry, `${repo}:${tag}`),
				latestRef: getRegistryTag(registry, `${repo}:latest`),
			};
			byLocalImage.set(built.localImage, pushed);
			return pushed;
		});

		// The logins run as their own commands, with the password on stdin: a
		// password inside a script would show in the host's process list. The
		// build server logs in to the registry's own docker config (the push uses
		// it), so it cannot replace another registry's login on that host.
		const configDir = await login(buildServerId, true, cancelable);
		await run(
			getTagAndPushCommand({
				images: [...byLocalImage.values()],
				registryLabel: registry.registryUrl || registry.registryName,
				configDir,
				rebuildService: (service) =>
					getComposeBuildServiceCommand(
						buildEntity,
						codePath,
						service,
						projectPath,
						stackEnvFile,
					),
			}),
		);
		// The serving host pulls the images it was just told about, and its stack
		// deploy sends the default config's login to the swarm
		// (--with-registry-auth), so that login stays in the default config.
		await login(entity.serverId, false, undefined);
		return { images };
	} catch (error) {
		await removeStagedFiles(buildServerId, staged);
		throw error;
	} finally {
		await removeStagedFiles(buildServerId, stackEnvStaged);
		await log.close();
	}
};

/**
 * Builds the compose's images on its build server, pushes them, and writes the
 * override on the serving host. Returns what `getBuildComposeCommand` needs to
 * pull and run them, or `undefined` for a compose without a build server.
 *
 * If anything fails, the serving host's compose file and `.env` (already
 * replaced by the clone) are put back and the previous release re-confirmed, so
 * a failed build leaves production exactly as it was.
 */
export const prepareComposeBuildServerDeploy = async ({
	entity,
	deployment,
	runStep,
	applyPatches = true,
	freshVolumes = false,
	cancellable = true,
	reuseClone = false,
	servingCommitOutput,
	patches,
}: {
	entity: ComposeBuildEntity;
	deployment: { logPath: string; deploymentId?: string };
	/** Runs a command on the serving host, appending its output to the log. */
	runStep: (command: string) => Promise<unknown>;
	applyPatches?: boolean;
	freshVolumes?: boolean;
	/**
	 * Whether this deployment can be cancelled (pid file + cancel checkpoints).
	 * False for compose previews: their deployment rows carry no composeId, so
	 * nothing could ever find them to cancel, and they keep the exact commands
	 * and database reads they had before cancellation existed.
	 */
	cancellable?: boolean;
	/**
	 * Rebuild: skip the clone when the build server already holds a usable
	 * checkout for this compose, so it builds the same code the serving host
	 * has on disk. Falls back to cloning when there is none.
	 */
	reuseClone?: boolean;
	/**
	 * `readServingHostCommitOutput` as read right after the serving host's
	 * fetch. Required for a non-raw compose: without it the build is refused,
	 * never read late.
	 */
	servingCommitOutput?: string;
	/**
	 * The patch rows the serving host applied (and the guards checked); the
	 * build server applies these. Required when patches are applied: without
	 * them the build is refused, never read again.
	 */
	patches?: Patch[];
}): Promise<RemoteBuildDeployInfo | undefined> => {
	if (!entity.buildServerId) {
		// Deleting a build server nulls `buildServerId` (ON DELETE SET NULL) but
		// leaves the registry behind. That compose was set up to never build on
		// its serving host, so do not silently start doing it.
		if (entity.buildRegistryId) {
			throw new Error(
				"This compose has a Build Registry but its Build Server no longer exists. Pick a build server again, or set both to None to build on the serving host.",
			);
		}
		return undefined;
	}

	try {
		const { images } = await buildImagesOnBuildServer(
			entity,
			deployment,
			applyPatches,
			cancellable,
			reuseClone,
			{ servingCommitOutput, patches },
		);

		// The images are pushed, but the serving host has not been told about
		// them yet. A cancel that landed after the last build-server step (so
		// there was nothing left to kill) stops here, before anything is written
		// or pulled: a cancelled deploy never runs a half-pushed or unwanted set.
		if (cancellable) {
			await assertDeploymentNotCancelled(deployment.deploymentId);
		}

		if (images.length > 0) {
			await runStep(
				`set -e;${getWriteFileCommand(
					getComposeBuildOverridePath(entity),
					buildComposeOverrideYaml(
						images.map((image) => ({
							service: image.service,
							image: image.ref,
						})),
						entity.composeType,
					),
				)}`,
			);
		} else {
			// An override left by an earlier deploy would resurrect services this
			// release no longer has (an override entry creates the service).
			await runStep(`rm -f ${quote([getComposeBuildOverridePath(entity)])};`);
		}

		// A cancel that landed while the serving host was being written to (an
		// SSH round trip) must not go on to pull and run the new set. Checked
		// inside the try so the restore below puts the previous release's files
		// back and removes the override that was just written.
		if (cancellable) {
			await assertDeploymentNotCancelled(deployment.deploymentId);
		}

		return {
			images: images.map((image) => ({
				service: image.service,
				image: image.ref,
			})),
			servingHostLabel: entity.server?.name ?? "the Dokploy host",
		};
	} catch (error) {
		try {
			const restore = await getRestoreAfterFailedBuildCommand(entity, {
				deploymentId: deployment.deploymentId,
				freshVolumes,
			});
			if (restore) await runStep(restore);
		} catch (restoreError) {
			console.error(
				"Could not restore the previous compose release after a failed build",
				restoreError,
			);
			if (isDeploymentCancelledError(error)) {
				// The cancel itself is real, but the serving host was left with the
				// new compose files instead of the previous release's. That is a
				// failure to report, not a clean cancel (which says "nothing was
				// changed"), so it is thrown as an ordinary error.
				const reason =
					restoreError instanceof Error
						? restoreError.message
						: String(restoreError);
				throw new Error(
					`Deployment cancelled, but the previous release could not be restored on the serving host (${reason}). Its compose files may still be the new ones; check them or redeploy.`,
				);
			}
		}
		throw error;
	}
};
