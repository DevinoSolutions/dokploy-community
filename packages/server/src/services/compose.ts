import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
} from "@dokploy/server/db/schema";
import { resyncBackupPoliciesForEnvironment } from "@dokploy/server/services/backup-policy";
import { prepareComposeBuildServerDeploy } from "@dokploy/server/services/compose-build-server";
import { pruneComposeBuildRegistry } from "@dokploy/server/services/compose-registry-retention";
import {
	type ComposePathLike,
	getBackupCurrentDeploymentCommand,
	getBuildComposeCommand,
	getComposeBuildOverridePath,
	getRestoreAfterFailedBuildCommand,
	getRollbackMarkerProbeCommand,
} from "@dokploy/server/utils/builders/compose";
import {
	getPhaseLogLine,
	resolveDeployGuardrails,
} from "@dokploy/server/utils/builders/compose-guardrails";
import {
	commandRunsRollingReplace,
	resolveComposeRolling,
} from "@dokploy/server/utils/builders/compose-rolling";
import { RELEASE_KILL_GRACE_SECONDS } from "@dokploy/server/utils/builders/remote-build-cancel";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@dokploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getDokployUrl } from "./admin";
// Fork module: build-policy required checks for compose units.
// See services/build-policy/README.md.
import { waitForComposeRequiredChecks } from "./build-policy/compose-checks";
import {
	createDeploymentCompose,
	getDeploymentErrorMessage,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import {
	appendLogLine,
	assertDeploymentNotCancelled,
	CANCELLED_THEN_FAILED_NOTE,
	CANCELLED_TOO_LATE_NOTE,
	DeploymentCancelledError,
	isDeploymentCancelled,
	isDeploymentCancelledError,
	markDeploymentDoneUnlessCancelled,
	runReleaseScript,
	statusAfterCancelledDeploy,
} from "./deployment-cancel";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

/** How long after a deploy returns its registry prune starts. */
export const REGISTRY_PRUNE_START_DELAY_MS = 3_000;

/**
 * Starts the build-registry cleanup of a build-server compose *after* the
 * deploy that triggered it has returned, never as part of it.
 *
 * The deployment queue holds a concurrency slot and the compose's group lock
 * until `deployCompose` / `rebuildCompose` resolve, so awaiting the prune there
 * would keep the next deploy of the same compose (and one of the LOCAL slots)
 * waiting on housekeeping. Here nothing is awaited: the prune is a timer, its
 * outcome is only ever logged, and it is not journaled (a prune lost to a
 * restart is simply retried by the next deploy). Whatever it does, including
 * throwing, cannot change the deployment's or the compose's status, because it
 * runs outside the deploy's try/catch and outside the queue job.
 *
 * A no-op (no timer at all) for a compose without a build server.
 */
export const scheduleComposeBuildRegistryPrune = (
	args: Parameters<typeof pruneComposeBuildRegistry>[0],
) => {
	if (!args.entity.buildServerId) return;
	try {
		const timer = setTimeout(() => {
			Promise.resolve()
				.then(() => pruneComposeBuildRegistry(args))
				.catch((error) => {
					console.error("Build registry cleanup failed", error);
				});
		}, REGISTRY_PRUNE_START_DELAY_MS);
		// Never keep the process alive (shutdown) for housekeeping.
		timer.unref?.();
	} catch (error) {
		console.error("Could not schedule the build registry cleanup", error);
	}
};

type ComposeBuildEntity = Awaited<ReturnType<typeof findComposeById>> & {
	type: "compose";
	/**
	 * Pull-request head ref, set only by the compose-preview path so previews
	 * of pull requests from forks check out the PR head on the base repository
	 * instead of a branch that does not exist there — see
	 * utils/providers/head-ref.ts.
	 */
	headRef?: string | null;
};

/**
 * Snapshots the compose file and `.env` that are on disk *before* the deploy
 * touches the code directory, so a failed deploy can restore exactly the
 * release that was serving traffic when it started.
 */
export const backupCurrentDeployment = async (
	compose: ComposePathLike,
	logPath: string,
) => {
	const command = `(${getBackupCurrentDeploymentCommand(compose)}) >> ${logPath} 2>&1`;
	if (compose.serverId) {
		await execAsyncRemote(compose.serverId, command);
	} else {
		await execAsync(command);
	}
};

/**
 * True when the deploy script reported that it restored the previous release
 * *and* brought it back up. The marker is bound to the deployment id, so a
 * marker written by an earlier deployment can never make this one look live.
 */
export const didRollbackSucceed = async (
	compose: ComposePathLike,
	logPath: string,
	deploymentId: string,
) => {
	const command = getRollbackMarkerProbeCommand(logPath, deploymentId);
	try {
		if (compose.serverId) {
			const { stdout } = await execAsyncRemote(compose.serverId, command);
			return stdout.trim() === "LIVE_OK";
		}
		const { stdout } = await execAsync(command);
		return stdout.trim() === "LIVE_OK";
	} catch {
		return false;
	}
};

const formatElapsedSeconds = (startedAt: number) =>
	`${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

/**
 * Opt-in "phase timestamps" guardrail for the steps Dokploy itself drives
 * (fetch, patches, build-server build, final status). Each boundary becomes a
 * UTC-stamped line in the deploy log, written by the host that holds the log,
 * with the elapsed seconds of the phase. The phases that run inside the deploy
 * script (pull, compose up, health check) stamp themselves, see
 * utils/builders/compose-guardrails.ts.
 *
 * Disabled (the default): `run` is a plain call and nothing is ever written.
 * Enabled: a log write that fails is reported to the console and never fails
 * the deployment.
 */
export const createComposePhaseLogger = (
	entity: { serverId: string | null; deployGuardrails?: unknown },
	logPath: string,
) => {
	const enabled =
		resolveDeployGuardrails(entity.deployGuardrails)?.phaseTimestamps === true;
	const note = async (message: string) => {
		if (!enabled || !logPath || logPath === ".") return;
		const command = `${getPhaseLogLine(message)} >> ${quote([logPath])}`;
		try {
			if (entity.serverId) {
				await execAsyncRemote(entity.serverId, command);
			} else {
				await execAsync(command);
			}
		} catch (error) {
			console.error(
				"Could not write a phase timestamp to the deploy log",
				error,
			);
		}
	};
	const run = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
		if (!enabled) return step();
		const startedAt = Date.now();
		await note(`${name}: started`);
		try {
			const result = await step();
			await note(`${name}: finished after ${formatElapsedSeconds(startedAt)}`);
			return result;
		} catch (error) {
			await note(`${name}: failed after ${formatElapsedSeconds(startedAt)}`);
			throw error;
		}
	};
	// Shell for the failure path, which writes the log in one command of its own.
	const failedCommand = (startedAt: number) =>
		enabled
			? `${getPhaseLogLine(`Deployment failed (total ${formatElapsedSeconds(startedAt)})`)} >> ${quote([logPath])};`
			: "";
	return {
		enabled,
		note,
		run,
		elapsed: formatElapsedSeconds,
		failedCommand,
	};
};

/**
 * Whether a cancel can stop the deploy script of a compose on its serving host.
 * Only the rolling replace has a trap that makes that safe (it removes the
 * replica it had not promoted), with or without a build server; the single
 * `up` of any other deploy keeps running to the end when it is cancelled
 * through a build server, and is interrupted by the generic stop when there is
 * none.
 */
const isReleaseCancelable = (command: string, cancellable = true) =>
	cancellable && commandRunsRollingReplace(command);

/**
 * Whether a cancel of this compose, as it was loaded when the deploy started,
 * goes through its deployment row (see `deployment-cancel.ts`) instead of the
 * generic stop: it builds on a build server, or it has a rolling replace, whose
 * release step is cancelable. Only decides whether the failure path reads the
 * cancel flag to note an earlier cancel in the log; a compose that was never
 * cancelled that way is unaffected, and the row itself is protected from the
 * closing `done` whatever this says (see `markDeploymentDoneUnlessCancelled`).
 */
const usesDeploymentCancel = (
	entity: Pick<Compose, "buildServerId" | "rollingReplace">,
) =>
	Boolean(entity.buildServerId) ||
	resolveComposeRolling(entity.rollingReplace) !== null;

/**
 * The cancel check between the steps of a compose with a rolling replace that
 * builds on its serving host. A cancel that lands while a step runs (fetching
 * the source, applying patches) has no release step to signal yet: it only
 * claims the deployment row (see `cancelRollingReleases`), and the deploy
 * stops here, at the next step boundary, with a `DeploymentCancelledError`.
 * A no-op for every other compose (a build server has its own checkpoints, see
 * `prepareComposeBuildServerDeploy`; the rest keeps the generic stop) and for
 * a deployment that cannot be cancelled (a preview).
 */
const createCancelCheckpoint = (
	entity: Awaited<ReturnType<typeof findComposeById>>,
	deployment: { deploymentId?: string; logPath: string },
	{
		cancellable = true,
		freshVolumes = false,
	}: { cancellable?: boolean; freshVolumes?: boolean } = {},
) => {
	const { deploymentId, logPath } = deployment;
	const enabled =
		cancellable &&
		Boolean(deploymentId) &&
		!entity.buildServerId &&
		resolveComposeRolling(entity.rollingReplace) !== null;
	// The fetch / patches / raw write already replaced the compose file and
	// `.env` on disk, and a later Start runs `up -d` from them: a cancel here
	// puts the previous release's files back, like a failed build-server build
	// (see `prepareComposeBuildServerDeploy`). A first deploy has no previous
	// release; the restore script says so and leaves the files.
	const restorePreviousRelease = async () => {
		try {
			const restore = await getRestoreAfterFailedBuildCommand(entity, {
				deploymentId,
				freshVolumes,
			});
			if (!restore) return;
			const commandWithLog = `(${restore}) >> ${logPath} 2>&1`;
			if (entity.serverId) {
				await execAsyncRemote(entity.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		} catch (restoreError) {
			console.error(
				"Could not restore the previous compose release after a cancel",
				restoreError,
			);
			const reason =
				restoreError instanceof Error
					? restoreError.message
					: String(restoreError);
			throw new Error(
				`Deployment cancelled, but the previous release could not be restored (${reason}). Its compose files may still be the new ones; check them or redeploy.`,
			);
		}
	};
	// `restore: false` for the check before anything was written. `anyCompose`
	// is for the required-checks wait, which polls the flag whatever this
	// deploy loaded at its start: a cancel claims the row from the compose as it
	// is when the button is pressed (rolling may have been switched on since,
	// and a build-server compose has its own checkpoints only from its build on),
	// and a wait that kept holding the queue slot would end as a timeout error.
	return async ({
		restore = true,
		anyCompose = false,
	}: {
		restore?: boolean;
		anyCompose?: boolean;
	} = {}) => {
		if (!enabled && !(anyCompose && cancellable && deploymentId)) return;
		try {
			await assertDeploymentNotCancelled(deploymentId);
		} catch (error) {
			if (restore && isDeploymentCancelledError(error)) {
				await restorePreviousRelease();
			}
			throw error;
		}
	};
};

/**
 * Shared clone → patches → (optional fresh-volumes down) → build pipeline used
 * by both `deployCompose` and the compose-preview deploy path. Extracting it
 * keeps `deployCompose` behavior identical while letting a preview run the same
 * steps against an in-memory entity whose `appName`, `branch`, `suffix`,
 * `domains` and `env` have been overridden for isolation.
 *
 * `applyPatches` is skipped for previews because `generateApplyPatchesCommand`
 * resolves the code directory from the base compose's appName, which does not
 * match the preview's isolated appName.
 *
 * The pipeline is transactional: the release currently on disk is snapshotted
 * before the clone, and `getBuildComposeCommand` restores it if the docker
 * command fails. Previews get the same treatment — their snapshots live under
 * their own isolated appName — so a broken PR push does not take the existing
 * preview URL down.
 */
export const runComposeBuild = async (
	entity: ComposeBuildEntity,
	deployment: { logPath: string; deploymentId?: string },
	options: {
		freshVolumes?: boolean;
		applyPatches?: boolean;
		/** False for compose previews, which cannot be cancelled (see prepare). */
		cancellable?: boolean;
	} = {},
) => {
	const { freshVolumes = false, applyPatches = true, cancellable } = options;
	const serverId = entity.serverId;
	const phases = createComposePhaseLogger(entity, deployment.logPath);
	const checkpoint = createCancelCheckpoint(entity, deployment, {
		cancellable,
		freshVolumes,
	});

	const runStep = async (rawCommand: string) => {
		const commandWithLog = `(${rawCommand}) >> ${deployment.logPath} 2>&1`;
		if (serverId) {
			await execAsyncRemote(serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
	};

	await checkpoint({ restore: false });

	// Must run before the clone / raw-file rewrite below overwrites the code
	// directory, otherwise there is nothing left to roll back to.
	await backupCurrentDeployment(entity, deployment.logPath);

	let command = "set -e;";
	if (entity.sourceType === "github") {
		command += await cloneGithubRepository(entity);
	} else if (entity.sourceType === "gitlab") {
		command += await cloneGitlabRepository(entity);
	} else if (entity.sourceType === "bitbucket") {
		command += await cloneBitbucketRepository(entity);
	} else if (entity.sourceType === "git") {
		command += await cloneGitRepository(entity);
	} else if (entity.sourceType === "gitea") {
		command += await cloneGiteaRepository(entity);
	} else if (entity.sourceType === "raw") {
		command += await getCreateComposeFileCommand(entity, {
			deploymentId: deployment.deploymentId,
		});
	}
	await phases.run(
		entity.sourceType === "raw" ? "Write compose file" : "Fetch source",
		() => runStep(command),
	);
	await checkpoint();

	if (applyPatches && entity.sourceType !== "raw") {
		command = "set -e;";
		command += await generateApplyPatchesCommand(
			{
				id: entity.composeId,
				type: "compose",
				serverId: entity.serverId,
			},
			{ deploymentId: deployment.deploymentId },
		);
		await phases.run("Apply patches", () => runStep(command));
		await checkpoint();
	}

	// >>> build-policy hook (compose): required-checks gate, between the clone
	// and the build — the compose equivalent of the application path's hook
	// 2a/4. Deliberately ahead of the `down --volumes` step below, so a refused
	// check never leaves the stack torn down. Reads nothing at all when the
	// unit has no `requiredChecks`, which is every existing row.
	// See packages/server/src/services/build-policy/README.md
	await waitForComposeRequiredChecks({
		compose: entity,
		serverId,
		assertNotCancelled: () => checkpoint({ anyCompose: true }),
	});
	// <<< build-policy hook (compose)
	await checkpoint();

	// Build-server composes build and push their images before the running
	// release is touched, so a failed build never reaches `down --volumes`.
	// A no-op (undefined) for every compose without a `buildServerId`.
	const prepareBuildServer = () =>
		prepareComposeBuildServerDeploy({
			entity,
			deployment,
			runStep,
			applyPatches,
			freshVolumes,
			cancellable,
		});
	const remoteBuild = entity.buildServerId
		? await phases.run("Build images on the build server", prepareBuildServer)
		: await prepareBuildServer();

	// Last check before the steps that cannot be interrupted: the stack is
	// taken down (fresh volumes) or the plain `up` starts. Once the stack was
	// taken down there is no check before the `up`: nothing restores a
	// fresh-volumes deploy, so a cancel is better reported as too late than
	// as "the previous release keeps serving" with the stack down.
	const tearsDown = freshVolumes && entity.composeType === "docker-compose";
	await checkpoint();
	if (tearsDown) {
		const downCommand = `set -e; env -i PATH="$PATH" docker compose -p ${entity.appName} down --volumes 2>&1 || true;`;
		await runStep(downCommand);
	}

	command = "set -e;";
	command += await getBuildComposeCommand(entity, {
		deploymentId: deployment.deploymentId,
		freshVolumes,
		remoteBuild,
	});
	if (!tearsDown) await checkpoint();
	if (deployment.deploymentId && isReleaseCancelable(command, cancellable)) {
		await runReleaseScript({
			serverId,
			command: `(${command}) >> ${deployment.logPath} 2>&1`,
			deploymentId: deployment.deploymentId,
		});
		return;
	}
	await runStep(command);
};

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	resyncBackupPoliciesForEnvironment(newDestination.environmentId);
	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	resyncBackupPoliciesForEnvironment(newDestination.environmentId);

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: {
				columns: {
					githubClientSecret: false,
					githubPrivateKey: false,
					githubWebhookSecret: false,
				},
			},
			gitlab: {
				columns: { secret: false, accessToken: false, refreshToken: false },
			},
			bitbucket: { columns: { appPassword: false, apiToken: false } },
			gitea: {
				columns: {
					clientSecret: false,
					accessToken: false,
					refreshToken: false,
				},
			},
			server: true,
			// Only its name: the restore step quotes it in "redeploy, which builds
			// on <name>" when it refuses to rebuild a pre-build-server release.
			buildServer: { columns: { serverId: true, name: true } },
			backups: {
				with: {
					destination: {
						columns: {
							accessKey: false,
							secretAccessKey: false,
						},
					},
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

/**
 * A deploy that was cancelled through its deployment row (a build-server
 * compose, or a rolling replace; see `deployment-cancel.ts`) ends here
 * instead of in the generic failure path: the deployment already says
 * `cancelled` and must not become `error`, no build-error notification goes
 * out for something the user asked for, and the service returns to the state
 * of the release that is still serving.
 *
 * Returns the error to rethrow, or `null` when this was not a cancellation.
 *
 * Only a `DeploymentCancelledError` counts. A cancel that arrives too late
 * (the pull/up is already running) leaves the row `cancelled`, but if the
 * release then genuinely fails, that failure takes the normal failure path
 * (error status, rollback handling, notification) and the log notes the
 * earlier cancel request. The same goes for a cancel inside prepare whose
 * restore of the previous release failed: that is thrown as a plain error.
 */
const settleCancelledComposeDeploy = async (
	entity: Pick<Compose, "composeId" | "serverId">,
	deployment: { deploymentId: string; logPath: string },
	error: unknown,
) => {
	if (!isDeploymentCancelledError(error)) return null;

	try {
		const cancelled = error as DeploymentCancelledError;
		const note = !cancelled.duringRelease
			? "Deployment cancelled ⛔ Nothing was pulled or started from this build; the previous release keeps serving."
			: cancelled.releaseKilled
				? `Deployment cancelled ⛔ The release step did not finish its cancel cleanup within ${RELEASE_KILL_GRACE_SECONDS}s and was killed. A replica it had not promoted may be left over (the next deploy reconciles it), services it had already updated stay on the new release, and a docker compose step it had started may still be running on its own.`
				: "Deployment cancelled ⛔ The release step was stopped. A rolling replace removes the replica it had not promoted yet; services it had already updated stay on the new release, and a step it had started is let finish before it stops.";
		const command = `echo ${quote([`\n${note}`])} >> ${quote([deployment.logPath])};`;
		if (entity.serverId) {
			await execAsyncRemote(entity.serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (logError) {
		console.error("Could not log the cancelled deployment", logError);
	}
	const settledStatus = await statusAfterCancelledDeploy({
		composeId: entity.composeId,
	});
	await updateCompose(entity.composeId, { composeStatus: settledStatus });
	return new DeploymentCancelledError(undefined, { settledStatus });
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
	freshVolumes = false,
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
	freshVolumes?: boolean;
}) => {
	const compose = await findComposeById(composeId);

	const buildLink = `${await getDokployUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	const phases = createComposePhaseLogger(compose, deployment.logPath);
	const deployStartedAt = Date.now();

	try {
		const entity = {
			...compose,
			type: "compose" as const,
		};

		await runComposeBuild(entity, deployment, { freshVolumes });
		await phases.note(
			`Deployment finished (total ${phases.elapsed(deployStartedAt)})`,
		);

		// A cancel that landed during the pull/up cannot be honoured (the release
		// is already running); it stays recorded as cancelled, not "done".
		const finished = await markDeploymentDoneUnlessCancelled(
			deployment.deploymentId,
		);
		await updateCompose(composeId, {
			composeStatus: "done",
		});

		if (!finished) {
			await appendLogLine(
				compose.serverId,
				deployment.logPath,
				CANCELLED_TOO_LATE_NOTE,
			);
		} else {
			await sendBuildSuccessNotifications({
				projectName: compose.environment.project.name,
				applicationName: compose.name,
				applicationType: "compose",
				serviceId: compose.composeId,
				buildLink,
				organizationId: compose.environment.project.organizationId,
				domains: compose.domains,
				environmentName: compose.environment.name,
			});
		}

		// Build-server composes: drop old per-deployment registry tags, detached
		// (see scheduleComposeBuildRegistryPrune).
		scheduleComposeBuildRegistryPrune({ entity, deployment });
	} catch (error) {
		const cancelled = await settleCancelledComposeDeploy(
			compose,
			deployment,
			error,
		);
		if (cancelled) throw cancelled;

		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		// A cancel that came too late, followed by a real failure: say so, the
		// deployment ends as `error` (it did fail), not `cancelled`.
		if (
			usesDeploymentCancel(compose) &&
			(await isDeploymentCancelled(deployment.deploymentId))
		) {
			command += `echo "\n${CANCELLED_THEN_FAILED_NOTE}" >> ${deployment.logPath};`;
		}
		command += phases.failedCommand(deployStartedAt);
		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		// The deployment itself always records the failure; the *service* is only
		// marked broken when the previous release could not be brought back.
		const rollbackSucceeded = await didRollbackSucceed(
			compose,
			deployment.logPath,
			deployment.deploymentId,
		);
		await updateCompose(composeId, {
			composeStatus: rollbackSucceeded ? "done" : "error",
		});
		const errorMessage = await getDeploymentErrorMessage({
			logPath: deployment.logPath,
			serverId: compose.serverId,
			fallback: "Error building, check the logs for details.",
		});

		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			serviceId: compose.composeId,
			errorMessage,
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (compose.sourceType !== "raw") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
	freshVolumes = false,
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
	freshVolumes?: boolean;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});
	const phases = createComposePhaseLogger(compose, deployment.logPath);
	const deployStartedAt = Date.now();
	const checkpoint = createCancelCheckpoint(compose, deployment, {
		freshVolumes,
	});

	try {
		await checkpoint({ restore: false });

		// Snapshot before the raw-file rewrite / patch application below.
		await backupCurrentDeployment(compose, deployment.logPath);

		let command = "set -e;";
		if (compose.sourceType === "raw") {
			command += await getCreateComposeFileCommand(compose, {
				deploymentId: deployment.deploymentId,
			});
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		await phases.run("Prepare compose file", async () => {
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		});
		await checkpoint();

		if (compose.sourceType !== "raw") {
			command = "set -e;";
			command += await generateApplyPatchesCommand(
				{
					id: compose.composeId,
					type: "compose",
					serverId: compose.serverId,
				},
				{ deploymentId: deployment.deploymentId },
			);
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			await phases.run("Apply patches", async () => {
				if (compose.serverId) {
					await execAsyncRemote(compose.serverId, commandWithLog);
				} else {
					await execAsync(commandWithLog);
				}
			});
			await checkpoint();
		}

		// >>> build-policy hook (compose rebuild): the same required-checks gate
		// `runComposeBuild` applies, in the same position — after the patches
		// step, ahead of the `down --volumes` step and the build.
		//
		// A redeploy re-uses whatever is already in the code directory, and
		// `runComposeBuild` clones *before* it gates, so a refused deploy leaves
		// the unchecked commit on disk. Without this call, Redeploy would build
		// exactly the commit the gate had just rejected. `rebuildApplication`
		// never had that hole; this is compose catching up. Round-3 review
		// finding H.
		await waitForComposeRequiredChecks({
			compose,
			serverId: compose.serverId,
			assertNotCancelled: () => checkpoint({ anyCompose: true }),
		});
		// <<< build-policy hook (compose rebuild)
		await checkpoint();

		// Build-server composes: build and push first (see runComposeBuild).
		const runRebuildStep = async (rawCommand: string) => {
			const stepWithLog = `(${rawCommand}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, stepWithLog);
			} else {
				await execAsync(stepWithLog);
			}
		};
		const prepareBuildServer = () =>
			prepareComposeBuildServerDeploy({
				entity: compose,
				deployment,
				runStep: runRebuildStep,
				freshVolumes,
				// A rebuild does not pull on the serving host, so it must not
				// build newer code on the build server either.
				reuseClone: true,
			});
		const remoteBuild = compose.buildServerId
			? await phases.run("Build images on the build server", prepareBuildServer)
			: await prepareBuildServer();

		// Last check before the steps that cannot be interrupted, and none
		// after the stack was taken down (see runComposeBuild).
		const tearsDown = freshVolumes && compose.composeType === "docker-compose";
		await checkpoint();
		if (tearsDown) {
			const downCommand = `set -e; env -i PATH="$PATH" docker compose -p ${compose.appName} down --volumes 2>&1 || true;`;
			const downWithLog = `(${downCommand}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, downWithLog);
			} else {
				await execAsync(downWithLog);
			}
		}

		command = "set -e;";
		command += await getBuildComposeCommand(compose, {
			deploymentId: deployment.deploymentId,
			freshVolumes,
			remoteBuild,
		});
		if (!tearsDown) await checkpoint();
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (isReleaseCancelable(command)) {
			await runReleaseScript({
				serverId: compose.serverId,
				command: commandWithLog,
				deploymentId: deployment.deploymentId,
			});
		} else if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
		await phases.note(
			`Deployment finished (total ${phases.elapsed(deployStartedAt)})`,
		);

		// See deployCompose: a cancel during the pull/up stays cancelled.
		const finished = await markDeploymentDoneUnlessCancelled(
			deployment.deploymentId,
		);
		await updateCompose(composeId, {
			composeStatus: "done",
		});
		if (!finished) {
			await appendLogLine(
				compose.serverId,
				deployment.logPath,
				CANCELLED_TOO_LATE_NOTE,
			);
		}

		// Build-server composes: drop old per-deployment registry tags, detached
		// (see scheduleComposeBuildRegistryPrune).
		scheduleComposeBuildRegistryPrune({ entity: compose, deployment });
	} catch (error) {
		const cancelled = await settleCancelledComposeDeploy(
			compose,
			deployment,
			error,
		);
		if (cancelled) throw cancelled;

		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		// A cancel that came too late, followed by a real failure: say so, the
		// deployment ends as `error` (it did fail), not `cancelled`.
		if (
			usesDeploymentCancel(compose) &&
			(await isDeploymentCancelled(deployment.deploymentId))
		) {
			command += `echo "\n${CANCELLED_THEN_FAILED_NOTE}" >> ${deployment.logPath};`;
		}
		command += phases.failedCommand(deployStartedAt);
		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		const rollbackSucceeded = await didRollbackSucceed(
			compose,
			deployment.logPath,
			deployment.deploymentId,
		);
		await updateCompose(composeId, {
			composeStatus: rollbackSucceeded ? "done" : "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);

		if (compose.composeType === "stack") {
			const command = `
			docker network disconnect ${compose.appName} dokploy-traefik;
			docker stack rm ${compose.appName};
			rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
			docker network disconnect ${compose.appName} dokploy-traefik;
			env -i PATH="$PATH" docker compose -p ${compose.appName} down ${
				deleteVolumes ? "--volumes" : ""
			};
			rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

// Starting or stopping a compose that was never deployed has no project
// directory to run in; without this check Node reports a misleading
// `spawn /bin/sh ENOENT`.
const assertComposeDirectoryExists = async (
	serverId: string | null,
	dir: string,
	action: "start" | "stop",
) => {
	let exists = true;
	if (serverId) {
		// Report through stdout so an SSH failure surfaces as itself instead of
		// being mistaken for a missing directory.
		const { stdout } = await execAsyncRemote(
			serverId,
			`if [ -d ${quote([dir])} ]; then echo present; else echo missing; fi`,
		);
		exists = stdout.trim() !== "missing";
	} else {
		exists = existsSync(dir);
	}
	if (!exists) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `This compose hasn't been deployed yet, so there is nothing to ${action}. Deploy it first.`,
		});
	}
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	if (compose.composeType === "docker-compose") {
		await assertComposeDirectoryExists(compose.serverId, projectPath, "start");
	}
	try {
		const path =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		// A compose built on a build server starts from the pushed images: merge
		// the override (when the last deploy wrote one) and never build here.
		let baseCommand = `env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([path])} up -d`;
		if (compose.buildServerId) {
			const overridePath = quote([getComposeBuildOverridePath(compose)]);
			const upBase = `env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([path])}`;
			baseCommand = `if [ -f ${overridePath} ]; then ${upBase} -f ${overridePath} up -d --no-build; else ${upBase} up -d --no-build; fi`;
		}
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${projectPath} && ${baseCommand}`,
				);
			} else {
				await execAsync(baseCommand, {
					cwd: projectPath,
				});
			}
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	if (compose.composeType === "docker-compose") {
		await assertComposeDirectoryExists(
			compose.serverId,
			join(COMPOSE_PATH, compose.appName),
			"stop",
		);
	}
	try {
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${join(COMPOSE_PATH, compose.appName)} && env -i PATH="$PATH" docker compose -p ${
						compose.appName
					} stop`,
				);
			} else {
				await execAsync(
					`env -i PATH="$PATH" docker compose -p ${compose.appName} stop`,
					{
						cwd: join(COMPOSE_PATH, compose.appName),
					},
				);
			}
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${compose.appName}`,
				);
			} else {
				await execAsync(`docker stack rm ${compose.appName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
