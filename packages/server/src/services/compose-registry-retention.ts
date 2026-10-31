import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	type ComposePathLike,
	getComposeBackupDir,
	getComposeBuildOverridePath,
	LAST_GOOD_OVERRIDE_BAK,
	PRE_DEPLOY_OVERRIDE_BAK,
} from "@dokploy/server/utils/builders/compose";
import {
	BUILD_REGISTRY_KEEP_DPL_TAGS,
	buildRegistryCurlConfig,
	buildRegistryDeleteJobCommand,
	buildRegistryDeleteJobConfig,
	buildRegistryJobStatusCommand,
	getManifestChildDigests,
	getManifestUrl,
	getNestedIndexReason,
	getNextTagsPageUrl,
	getReadFilesCommand,
	getRegistryApiBases,
	getRegistryJobKey,
	getTagsListUrl,
	hasRepeatedHeader,
	isBodyTruncated,
	isValidDigest,
	mapDeploymentTagTimes,
	NO_CURL_MARKER,
	REGISTRY_CURL_COMMAND,
	RELIED_ON_HEADERS,
	type RegistryRequest,
	type RegistryResponse,
	parseOverrideImages,
	parseRegistryEndpoint,
	parseRegistryImageRef,
	parseRegistryJobOutput,
	parseRegistryResponses,
	parseTagList,
	planRepoTags,
	selectDigestsToDelete,
	splitFileOutput,
} from "@dokploy/server/utils/builders/compose-registry-retention";
import {
	execAsync,
	execAsyncRemote,
	openRemoteInputSession,
	type RemoteInputSession,
} from "@dokploy/server/utils/process/execAsync";
import { quote } from "shell-quote";
import { createDeploymentLogWriter } from "./compose-build-server";
import { findAllDeploymentsByComposeId } from "./deployment";
import { findRegistryByIdWithCredentials } from "./registry";

/**
 * Retention for the `dpl-<deploymentId>` tags a build-server compose pushes.
 *
 * Every deploy pushes one tag per service repository and nothing removes them,
 * so the registry grows with every release. After a *successful* deploy this
 * keeps the newest `BUILD_REGISTRY_KEEP_DPL_TAGS` tags per service repository
 * and deletes the manifests of the rest.
 *
 * Which host talks to the registry: the compose's **build server**. It already
 * pushed to that registry, so it can reach it by definition. That matters for
 * the setups this exists for, where the registry is `localhost:5000` through an
 * SSH tunnel that only exists on the build server; the Dokploy host could not
 * resolve that address at all. The serving host can usually reach it as well
 * (it pulls), but it is the host users care most about, so it is left alone.
 * The build server is always a remote server, so every call goes over SSH.
 *
 * Credentials: curl runs with `--config -` and the registry password travels
 * on that command's stdin (`openRemoteInputSession`). The command string, and
 * therefore the remote shell's argv, the environment, any file and any log,
 * never contain it.
 *
 * Reading versus deleting. Reads (tag listings, GET/HEAD of manifests) are
 * fast and go out in small batches, a few SSH sessions at a time, with a short
 * timeout; what a batch did not answer is "unknown", which never makes
 * anything deletable. A manifest DELETE is a different animal: on a registry
 * backed by object storage it takes time proportional to the repository's tag
 * count (15 to 70 s at ~220 tags), far longer than the budget of a deploy, and
 * a DELETE the client gives up on keeps running on the registry while the
 * next request starts on top of it, which makes the storage answer 503. So
 * nothing here waits for a DELETE. The run decides what to delete and then
 * hands the whole list to ONE detached job on the build server (see
 * `buildRegistryDeleteJobCommand`): it runs the DELETEs strictly one after the
 * other with a long timeout, holds a per-registry lock so a second deploy can
 * never start a second chain, and leaves its answers in a result file. The
 * run only reports that the job was started. The *next* run asks whether the
 * job is done, reads its answers, and confirms the outcome against the
 * registry (HEAD of each digest) before it says "gone".
 *
 * Fairness: one job per run, filled from the service repositories in turn
 * (one wave of old tags each), and the next run starts where this one left
 * off, so one repository with a big backlog cannot starve the others.
 *
 * Everything here is best effort and bounded. `pruneComposeBuildRegistry`
 * never throws; every failure (a 401, a 405 because deletes are disabled, a
 * registry without the v2 delete API, a network error, a missing curl) becomes
 * one warning line in the deployment log. Running out of time is not a
 * failure: it gets a plain line saying what was done.
 */

/** Wall-clock budget for one retention run. */
const RETENTION_BUDGET_MS = 45_000;
/**
 * Longest a single read curl invocation may take before its SSH session is
 * dropped. Whatever it answered by then still counts.
 */
const BATCH_TIMEOUT_MS = 20_000;
/**
 * How long past the budget a step that is not a curl batch (the database, an
 * SSH connect) may hang before the run is given up on.
 */
const BACKSTOP_GRACE_MS = 5_000;
/** Longest the serving host may take to print the override files. */
const READ_FILES_TIMEOUT_MS = 10_000;
/** Service repositories handled per run. */
const MAX_REPOS = 20;
/** Pages of one repository's tag listing followed per run. */
const MAX_TAG_PAGES = 10;
/**
 * Manifest DELETEs handed to one job (one job per run). A larger backlog is
 * worked off over several deploys.
 */
const MAX_DELETIONS_PER_RUN = 50;
/**
 * Estimated serial running time one job may have: a DELETE costs about
 * `ESTIMATED_DELETE_BASE_MS + ESTIMATED_DELETE_MS_PER_TAG * tags in its
 * repository`. The job has no deploy guard once it runs, so its length is
 * bounded.
 */
const DELETE_JOB_TARGET_MS = 10 * 60_000;
const ESTIMATED_DELETE_BASE_MS = 1_300;
const ESTIMATED_DELETE_MS_PER_TAG = 80;
/** Requests per curl invocation (they run one after the other). */
const BATCH_SIZE = 20;
/** Read curl invocations, each over its own SSH session, running at once. */
const MAX_CONCURRENT_BATCHES = 3;
/**
 * Time kept free at the end of the budget for starting the job: reading stops
 * this long before the budget does.
 */
const JOB_START_RESERVE_MS = 3_000;
/**
 * A deployment of the compose created this long before the prune began, or
 * later, counts as started during the prune. Covers clock differences between
 * the process that wrote the row and this one; erring early only stops a
 * prune that could have gone on.
 */
const STARTED_SINCE_SLACK_MS = 5_000;
/** Old tags resolved before the next decision. */
const WAVE_SIZE = BATCH_SIZE * MAX_CONCURRENT_BATCHES;
/** A "running" deployment older than this is a leftover, not a concurrent deploy. */
const RUNNING_DEPLOYMENT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A job record older than this is forgotten even if nobody asked about it. */
const PENDING_JOB_TTL_MS = 6 * 60 * 60 * 1000;
/** A tag found dangling is looked at again after this long. */
const DANGLING_RECHECK_MS = 6 * 60 * 60 * 1000;
/** Repositories remembered at most (oldest forgotten first). */
const MAX_REMEMBERED_REPOS = 500;

class RetentionAbort extends Error {}
/** The time budget ran out: not a failure, the next deploy carries on. */
class BudgetSpent extends RetentionAbort {}

const LATEST_TAG = "latest";

/**
 * Composes with a prune in progress. Two deploys of one compose can finish
 * close together; their prunes must never overlap, or the second one could
 * delete a digest the first one has just decided to keep.
 */
const pruneInFlight = new Set<string>();

interface DeleteEntry {
	repo: string;
	digest: string;
	/** The old tags that point at `digest`. */
	tags: string[];
}

/** The delete job a registry was last handed, until a later run has settled it. */
interface PendingJob {
	composeId: string;
	token: string;
	startedAt: number;
	entries: DeleteEntry[];
}

/**
 * registry -> the job its last run started. At most one: the build server's
 * lock lets only one job per registry live. In memory only: after a restart
 * the next run simply finds the lock free or held and plans again, and a
 * DELETE of a digest that is already gone is harmless.
 */
const pendingJobs = new Map<string, PendingJob>();

/**
 * What earlier runs learned about a repository's old tags, so the waves of
 * HEADs do not spend themselves on the same tags every run.
 */
interface RepoMemory {
	/** Tags whose manifest is gone (HEAD 404): nothing to delete, ever; tag -> when seen. */
	dangling: Map<string, number>;
	/** Tags whose digest a kept tag also uses; tag -> that digest. */
	shared: Map<string, string>;
}
const repoMemory = new Map<string, RepoMemory>();

const getRepoMemory = (registryId: string, repo: string) => {
	const key = `${registryId}\n${repo}`;
	let memory = repoMemory.get(key);
	if (memory) {
		// Most recently used last.
		repoMemory.delete(key);
	} else {
		memory = { dangling: new Map(), shared: new Map() };
		if (repoMemory.size >= MAX_REMEMBERED_REPOS) {
			const oldest = repoMemory.keys().next().value;
			if (oldest !== undefined) repoMemory.delete(oldest);
		}
	}
	repoMemory.set(key, memory);
	return memory;
};

/**
 * compose -> the repository its next prune starts with. The runs take the
 * repositories in turn: a run that fills its job, or runs out of time, hands
 * over to the repository after (or at) the one it stopped in. Without this
 * the repositories at the front would take every run's budget and the last
 * ones would never be reached. In memory only: after a restart a run starts at
 * the front again, which is merely less fair.
 */
const rotation = new Map<string, string>();

/** Forgets everything the retention remembers between runs. For tests. */
export const resetRegistryRetentionState = () => {
	pendingJobs.clear();
	repoMemory.clear();
	rotation.clear();
	pruneInFlight.clear();
};

/**
 * Whether another deployment of the compose may push while this prune runs:
 * one that is running, or, with `since`, one created at or after `since`
 * whatever its status. A deploy that started and already finished during the
 * prune may have pushed an unchanged service under a digest the protection
 * snapshot did not know was in use. A row whose time cannot be read counts.
 */
const hasConcurrentDeployment = (
	deployments: {
		deploymentId: string;
		createdAt: string;
		status: string | null;
	}[],
	currentDeploymentId?: string,
	since?: number,
) => {
	const now = Date.now();
	return deployments.some((candidate) => {
		if (candidate.deploymentId === currentDeploymentId) return false;
		const created = Date.parse(candidate.createdAt);
		if (since !== undefined && !(created < since)) return true;
		return (
			candidate.status === "running" &&
			now - created < RUNNING_DEPLOYMENT_WINDOW_MS
		);
	});
};

export interface RegistryRetentionEntity extends ComposePathLike {
	composeId: string;
	buildRegistryId: string | null;
}

const redact = (text: string, secret?: string | null) =>
	secret ? text.split(secret).join("***") : text;

const withTimeout = <T>(
	promise: Promise<T>,
	ms: number,
	makeError: () => Error,
) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(makeError()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const plural = (count: number, one: string, many: string) =>
	`${count} ${count === 1 ? one : many}`;

/** "HTTP 202 x3, HTTP 500 x1" for the answers of a job, most frequent first. */
const describeStatuses = (statuses: Iterable<number>) => {
	const counts = new Map<number, number>();
	for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.map(([status, count]) =>
			status === 0 ? `no answer x${count}` : `HTTP ${status} x${count}`,
		)
		.join(", ");
};

/**
 * Prunes old `dpl-` tags of `entity`'s service repositories in its build
 * registry. A no-op (no I/O at all) for a compose without a build server, so
 * every other unit behaves exactly as before.
 */
export const pruneComposeBuildRegistry = async ({
	entity,
	deployment,
	keep = BUILD_REGISTRY_KEEP_DPL_TAGS,
	budgetMs = RETENTION_BUDGET_MS,
	batchTimeoutMs = BATCH_TIMEOUT_MS,
}: {
	entity: RegistryRetentionEntity;
	deployment: { logPath: string; deploymentId?: string };
	keep?: number;
	budgetMs?: number;
	batchTimeoutMs?: number;
}): Promise<void> => {
	const { buildServerId, buildRegistryId } = entity;
	if (!buildServerId || !buildRegistryId) return;
	if (process.env.DOKPLOY_DISABLE_BUILD_REGISTRY_RETENTION === "true") return;
	if (pruneInFlight.has(entity.composeId)) return;

	const log = createDeploymentLogWriter(entity.serverId ?? null, deployment.logPath);
	let password: string | null | undefined;
	let cancelled = false;
	const activeSessions = new Set<RemoteInputSession>();
	pruneInFlight.add(entity.composeId);
	try {
		const registry = await findRegistryByIdWithCredentials(buildRegistryId);
		password = registry.password;

		if (registry.registryType === "awsEcr") {
			log.line(
				"Build registry cleanup skipped: AWS ECR registries are not pruned by Dokploy (use an ECR lifecycle policy).",
			);
			return;
		}
		const endpoint = parseRegistryEndpoint(registry.registryUrl);
		if (!endpoint) {
			log.line(
				"Build registry cleanup skipped: the build registry has no URL.",
			);
			return;
		}

		const deadline = Date.now() + budgetMs;
		/** Reading stops here, so there is time left to start the job. */
		const readDeadline = deadline - Math.min(JOB_START_RESERVE_MS, budgetMs / 2);
		const outOfTime = () => cancelled || Date.now() >= readDeadline;
		const assertTime = () => {
			if (outOfTime()) {
				throw new BudgetSpent("the time budget for cleanup ran out");
			}
		};
		const jobKey = getRegistryJobKey(buildRegistryId);

		/**
		 * One SSH session running `command`, fed `input` on stdin. Running out of
		 * time is not an error: the session is dropped and the output that
		 * arrived before that is returned.
		 */
		const runSession = async (
			command: string,
			input: string | null,
			until: number,
		) => {
			let stdout = "";
			let expired = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expiry = new Promise<null>((resolve) => {
				timer = setTimeout(
					() => {
						expired = true;
						resolve(null);
					},
					Math.max(1, Math.min(batchTimeoutMs, until - Date.now())),
				);
			});
			try {
				const opening = openRemoteInputSession(buildServerId, command, {
					onStdout: (text) => void (stdout += text),
				});
				const session = await Promise.race([opening, expiry]);
				if (!session) {
					// Connecting took the whole slot; drop the session if it opens late.
					opening.then(
						(late) => late.abort(),
						() => {},
					);
					return { stdout, expired: true };
				}
				activeSessions.add(session);
				void expiry.then(() => session.abort());
				try {
					try {
						if (input !== null) {
							await session.write(Buffer.from(input, "utf8"));
						}
					} catch {
						// The command may already be gone (no curl); `end` reports why.
					}
					await session.end();
				} catch (error) {
					// Dropped on purpose (out of time): keep what was answered.
					if (!expired && !cancelled) throw error;
				} finally {
					activeSessions.delete(session);
				}
			} finally {
				clearTimeout(timer);
			}
			return { stdout, expired };
		};

		/** One curl invocation of reads: the responses that arrived in time. */
		const runBatch = async (requests: RegistryRequest[]) => {
			const input = buildRegistryCurlConfig({
				requests,
				username: registry.username,
				password: registry.password,
			});
			const { stdout } = await runSession(
				REGISTRY_CURL_COMMAND,
				input,
				readDeadline,
			);
			if (stdout.includes(NO_CURL_MARKER)) {
				throw new RetentionAbort("curl is not installed on the build server");
			}
			return parseRegistryResponses(
				stdout,
				requests.map((request) => request.id),
			);
		};

		/**
		 * Sends `requests` (ids unique within the call) in batches of
		 * `BATCH_SIZE`, at most `MAX_CONCURRENT_BATCHES` at a time. A request
		 * without a response was not answered in time. No batch starts once the
		 * budget is spent; a batch that fails ends the scheduling, and its error
		 * comes back next to whatever the other batches answered.
		 */
		const runBatches = async (requests: RegistryRequest[]) => {
			const chunks: RegistryRequest[][] = [];
			for (let start = 0; start < requests.length; start += BATCH_SIZE) {
				chunks.push(requests.slice(start, start + BATCH_SIZE));
			}
			const responses = new Map<number, RegistryResponse>();
			let error: unknown;
			let failed = false;
			let next = 0;
			const worker = async () => {
				while (next < chunks.length && !failed && !outOfTime()) {
					const chunk = chunks[next++] as RegistryRequest[];
					try {
						for (const [id, response] of await runBatch(chunk)) {
							responses.set(id, response);
						}
					} catch (caught) {
						if (!failed) error = caught;
						failed = true;
					}
				}
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(MAX_CONCURRENT_BATCHES, chunks.length) },
					worker,
				),
			);
			return { responses, failed, error };
		};
		const runAll = async (requests: RegistryRequest[]) => {
			const { responses, failed, error } = await runBatches(requests);
			if (failed) throw error;
			return responses;
		};

		/** Statuses that mean no further request can succeed. */
		const failIfSystemic = (status: number, action: string) => {
			if (status === 0) {
				throw new RetentionAbort(
					"the registry could not be reached from the build server",
				);
			}
			if (status === 401 || status === 403) {
				throw new RetentionAbort(
					`the registry refused the stored credentials (HTTP ${status}) while ${action}; token-authenticated registries are not supported`,
				);
			}
			if (status === 405 || status === 501) {
				throw new RetentionAbort(
					`the registry does not allow ${action} (HTTP ${status}); the v2 delete API is disabled or unsupported (registry:2 needs REGISTRY_STORAGE_DELETE_ENABLED=true)`,
				);
			}
		};

		const run = async () => {
			// 1. What the current release and the rollback snapshots reference.
			// Everything below protects what existed when this snapshot was read.
			// Any deployment of the compose created from then on (running or
			// already finished) may have pushed something the snapshot does not
			// know is in use: the job is not started as soon as one shows up.
			const snapshotAt = Date.now() - STARTED_SINCE_SLACK_MS;
			const overridePath = getComposeBuildOverridePath(entity);
			const backupDir = getComposeBackupDir(entity);
			const files = [
				overridePath,
				join(backupDir, LAST_GOOD_OVERRIDE_BAK),
				join(backupDir, PRE_DEPLOY_OVERRIDE_BAK),
			];
			const readFiles = getReadFilesCommand(files.map((file) => quote([file])));
			const { stdout: filesOutput } = await withTimeout(
				entity.serverId
					? execAsyncRemote(entity.serverId, readFiles)
					: execAsync(readFiles),
				READ_FILES_TIMEOUT_MS,
				() => new RetentionAbort("reading the release overrides timed out"),
			);
			const protectedByRepo = new Map<string, Set<string>>();
			for (const text of splitFileOutput(filesOutput)) {
				for (const image of parseOverrideImages(text)) {
					const ref = parseRegistryImageRef(image);
					if (!ref || ref.host !== endpoint.host) continue;
					const tags = protectedByRepo.get(ref.repo) ?? new Set<string>();
					tags.add(ref.tag);
					protectedByRepo.set(ref.repo, tags);
				}
			}
			if (protectedByRepo.size === 0) {
				log.line(
					"Build registry cleanup: the release overrides reference no images of this registry, nothing to prune.",
				);
				return;
			}
			if (protectedByRepo.size > MAX_REPOS) {
				throw new RetentionAbort(
					`the compose has ${protectedByRepo.size} service repositories (more than ${MAX_REPOS})`,
				);
			}

			// 2. Deployment times, and a guard against racing a concurrent deploy
			// of this compose (its tags may not be referenced by any file yet, and
			// an unchanged service pushed now shares a digest we might delete).
			const deployments = await findAllDeploymentsByComposeId(entity.composeId);
			if (
				hasConcurrentDeployment(
					deployments,
					deployment.deploymentId,
					snapshotAt,
				)
			) {
				log.line(
					"Build registry cleanup deferred: another deployment of this compose is running or has just started.",
				);
				return;
			}
			const tagTimes = mapDeploymentTagTimes(deployments);

			// 3. Find the registry's API address from the build server.
			const bases = getRegistryApiBases(endpoint);
			const probe = await runAll(
				bases.map((base, id) => ({
					id,
					method: "GET" as const,
					url: `${base}/v2/`,
				})),
			);
			const reachable = bases.findIndex((_, id) => probe.get(id)?.status === 200);
			if (reachable === -1) {
				assertTime();
				for (const response of probe.values()) {
					failIfSystemic(response.status, "checking the API");
				}
				throw new RetentionAbort(
					probe.size < bases.length
						? "the registry did not answer the v2 API check in time"
						: "the registry did not answer the v2 API check as expected",
				);
			}
			const base = bases[reachable] as string;

			// 4. What happened to the job an earlier run of this compose started.
			// Its DELETEs were sent, not confirmed: the job's answers and the
			// registry itself say what became of them. While it still runs nothing
			// new is planned (the lock would refuse a second job anyway).
			const earlier = pendingJobs.get(buildRegistryId);
			if (earlier && Date.now() - earlier.startedAt > PENDING_JOB_TTL_MS) {
				pendingJobs.delete(buildRegistryId);
			} else if (earlier && earlier.composeId === entity.composeId) {
				const { stdout } = await runSession(
					buildRegistryJobStatusCommand({ key: jobKey }),
					null,
					readDeadline,
				);
				const status = parseRegistryJobOutput(
					stdout,
					earlier.entries.map((_, id) => id),
				);
				if (status.kind === "nocurl") {
					throw new RetentionAbort("curl is not installed on the build server");
				}
				if (status.kind !== "idle") {
					assertTime();
					log.line(
						status.kind === "busy"
							? `Build registry cleanup: the background deletion job from an earlier deploy is still running on the build server (${plural(earlier.entries.length, "old image manifest", "old image manifests")} sent); nothing new is started until it is done.`
							: "Build registry cleanup: could not tell whether the background deletion job from an earlier deploy has finished; it is checked again on the next deploy.",
					);
					return;
				}
				pendingJobs.delete(buildRegistryId);
				const answers = status.token === earlier.token ? status.responses : null;
				const heads = await runAll(
					earlier.entries.map((entry, id) => ({
						id,
						method: "HEAD" as const,
						url: getManifestUrl(base, entry.repo, entry.digest),
						manifest: true,
					})),
				);
				let gone = 0;
				let present = 0;
				let unknown = 0;
				for (const [id, entry] of earlier.entries.entries()) {
					const response = heads.get(id);
					if (response?.status === 404) {
						gone += 1;
						// A tag that is still listed for a manifest that is gone is dangling.
						const memory = getRepoMemory(buildRegistryId, entry.repo);
						for (const tag of entry.tags) memory.dangling.set(tag, Date.now());
					} else if (response?.status === 200) {
						present += 1;
					} else {
						unknown += 1;
					}
				}
				const minutes = Math.max(
					1,
					Math.round((Date.now() - earlier.startedAt) / 60_000),
				);
				log.line(
					`Build registry cleanup: the background deletion job from an earlier deploy (started ${minutes} min ago) has finished: ${gone} of ${plural(earlier.entries.length, "old image manifest", "old image manifests")} confirmed gone${present ? `, ${present} still present (retried below)` : ""}${unknown ? `, ${unknown} not confirmed` : ""}${answers && answers.size > 0 ? `; the job's DELETE answers: ${describeStatuses([...answers.values()].map((answer) => answer.status))}` : ""}.`,
				);
				if (answers) {
					for (const answer of answers.values()) {
						// A DELETE that timed out (status 0) says nothing about the
						// registry being unreachable; only a refusal ends the run.
						if (answer.status !== 0) {
							failIfSystemic(answer.status, "deleting manifests");
						}
					}
				}
			}

			// 5. The first page of every repository's tag listing, in one go. It is
			// asked for with its headers: a `Link` header names the next page.
			const repos = [...protectedByRepo.keys()];
			const firstPages = await runAll(
				repos.map((repo, id) => ({
					id,
					method: "GET" as const,
					url: getTagsListUrl(base, repo),
					includeHeaders: true,
				})),
			);

			/** Every tag of `repo`, or `null` when the listing cannot be trusted whole. */
			const listTags = async (
				repo: string,
				first: RegistryResponse | undefined,
			): Promise<string[] | null> => {
				const tags: string[] = [];
				const seen = new Set<string>([
					new URL(getTagsListUrl(base, repo)).href,
				]);
				let response = first;
				for (let page = 1; ; page++) {
					if (!response) {
						assertTime();
						log.line(
							`Build registry cleanup left ${repo} for the next deploy: its tag listing did not arrive in time.`,
						);
						return null;
					}
					failIfSystemic(response.status, "listing tags");
					if (response.status === 404) return null;
					if (response.status !== 200) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: listing tags returned HTTP ${response.status}.`,
						);
						return null;
					}
					const pageTags = parseTagList(response.body);
					if (!pageTags) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: unreadable tag list.`,
						);
						return null;
					}
					tags.push(...pageTags);
					// Fail closed from here on: a listing that may be partial cannot
					// tell which tags are kept, so the repository is skipped whole.
					const next = hasRepeatedHeader(response, ["link"])
						? ({
								kind: "unusable",
								reason: "the response has more than one Link header",
							} as const)
						: hasRepeatedHeader(response, RELIED_ON_HEADERS)
							? ({
									kind: "unusable",
									reason:
										"the response repeats its Content-Length or Content-Type header",
								} as const)
							: getNextTagsPageUrl(base, repo, response.headers.link);
					if (next.kind === "complete") return tags;
					if (next.kind === "unusable") {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: the tag listing may be incomplete, ${next.reason}.`,
						);
						return null;
					}
					if (seen.has(next.url)) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: the tag listing is paged in a loop.`,
						);
						return null;
					}
					if (page >= MAX_TAG_PAGES) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: its tag listing has more than ${MAX_TAG_PAGES} pages (${tags.length} tags so far); nothing is pruned from a partial listing.`,
						);
						return null;
					}
					seen.add(next.url);
					assertTime();
					response = (
						await runAll([
							{ id: 0, method: "GET", url: next.url, includeHeaders: true },
						])
					).get(0);
				}
			};

			// The job being filled: what this run decided to delete.
			const queue: DeleteEntry[] = [];
			const queuedKeys = new Set<string>();
			let queuedMs = 0;
			let full = false;
			/** Adds `entry` unless the job has no room for it. */
			const tryQueue = (entry: DeleteEntry, listedTags: number) => {
				const cost =
					ESTIMATED_DELETE_BASE_MS + ESTIMATED_DELETE_MS_PER_TAG * listedTags;
				if (
					queue.length >= MAX_DELETIONS_PER_RUN ||
					(queue.length > 0 && queuedMs + cost > DELETE_JOB_TARGET_MS)
				) {
					full = true;
					return false;
				}
				queue.push(entry);
				queuedKeys.add(`${entry.repo}@${entry.digest}`);
				queuedMs += cost;
				if (queue.length >= MAX_DELETIONS_PER_RUN || queuedMs >= DELETE_JOB_TARGET_MS) {
					full = true;
				}
				return true;
			};

			/**
			 * Resolves one repository's old tags, a wave at a time, until a wave
			 * yields something to delete (the other repositories get their turn),
			 * and queues those digests.
			 */
			const gatherRepo = async ({
				repo,
				listed,
				doomed,
				resolve,
				required,
			}: {
				repo: string;
				/** Every tag the listing named. */
				listed: string[];
				/** Old tags, oldest first. */
				doomed: string[];
				/** Every tag that stays, plus the ones that must exist (see below). */
				resolve: string[];
				/** Tags an override file names; a 404 on one means the registry is not to be trusted. */
				required: Set<string>;
			}) => {
				// a. Every tag that stays, with GET: its digest, and its manifest
				// body for the children of an image index. All of them, or nothing
				// in this repository is deleted.
				const kept = await runAll(
					resolve.map((tag, id) => ({
						id,
						method: "GET" as const,
						url: getManifestUrl(base, repo, tag),
						manifest: true,
						includeHeaders: true,
					})),
				);
				const protectedDigests = new Set<string>();
				let unanswered = 0;
				for (const [id, tag] of resolve.entries()) {
					const response = kept.get(id);
					if (!response) {
						unanswered += 1;
						continue;
					}
					failIfSystemic(response.status, "reading manifests");
					// Two digests, lengths or types for one response: which one is
					// true is unknown.
					if (hasRepeatedHeader(response, RELIED_ON_HEADERS)) {
						unanswered += 1;
						continue;
					}
					const digest = response.headers["docker-content-digest"];
					if (response.status === 404) {
						// `latest` may simply not exist when the listing did not have it.
						// Any other kept tag, and every tag a release file names, was
						// either listed or required: a 404 means the registry is
						// inconsistent, and what it protects is unknown.
						if (tag === LATEST_TAG && !required.has(tag)) continue;
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: could not read the kept tag ${tag} (HTTP 404).`,
						);
						return;
					}
					if (response.status !== 200 || !digest || !isValidDigest(digest)) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: could not read the kept tag ${tag} (HTTP ${response.status}).`,
						);
						return;
					}
					// A body cut off in transfer (curl's max-time still writes the
					// marker and the status) or one that is not a readable manifest
					// tells nothing about the children of an index: unknown, so the
					// repository waits for a run that reads it whole.
					if (isBodyTruncated(response)) {
						unanswered += 1;
						continue;
					}
					// Only one level of an index is read. A child that may be an
					// index itself could protect manifests nothing here sees.
					const nested = getNestedIndexReason(response.body);
					if (nested) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: the kept tag ${tag} is an index whose children may be indexes themselves (${nested}); nested indexes are not pruned.`,
						);
						return;
					}
					const children = getManifestChildDigests(response.body);
					if (!children) {
						unanswered += 1;
						continue;
					}
					protectedDigests.add(digest);
					for (const child of children) protectedDigests.add(child);
				}
				if (unanswered > 0) {
					assertTime();
					log.line(
						`Build registry cleanup left ${repo} for the next deploy: ${plural(unanswered, "kept tag", "kept tags")} did not resolve in time or came back cut off or ambiguous.`,
					);
					return;
				}

				// b. Old tags, oldest first, a wave at a time: resolve with HEAD and
				// pick what no kept tag needs. Tags earlier runs found out about are
				// not asked again: a dangling one (HEAD 404, the manifest is gone,
				// only the tag name is left and registry:2 cannot remove it) has
				// nothing to delete, and one that shares its digest with a kept tag
				// stays protected for as long as that digest is. Left in, they take
				// the front of every wave for ever. One that did not answer is left
				// alone, and is asked again next time.
				const memory = getRepoMemory(buildRegistryId, repo);
				const listedSet = new Set(listed);
				for (const tag of memory.dangling.keys()) {
					if (!listedSet.has(tag)) memory.dangling.delete(tag);
				}
				for (const tag of memory.shared.keys()) {
					if (!listedSet.has(tag)) memory.shared.delete(tag);
				}
				const now = Date.now();
				const candidates = doomed.filter((tag) => {
					const seen = memory.dangling.get(tag);
					if (seen !== undefined && now - seen < DANGLING_RECHECK_MS) {
						return false;
					}
					const sharedWith = memory.shared.get(tag);
					return !(sharedWith && protectedDigests.has(sharedWith));
				});
				for (let start = 0; start < candidates.length; start += WAVE_SIZE) {
					if (full) return;
					assertTime();
					const wave = candidates.slice(start, start + WAVE_SIZE);
					const heads = await runAll(
						wave.map((tag, id) => ({
							id,
							method: "HEAD" as const,
							url: getManifestUrl(base, repo, tag),
							manifest: true,
						})),
					);
					const doomedDigests = new Map<string, string>();
					for (const [id, tag] of wave.entries()) {
						const response = heads.get(id);
						if (!response) continue;
						failIfSystemic(response.status, "reading manifests");
						// No answer, or an ambiguous one: left alone, never deletable.
						if (hasRepeatedHeader(response, RELIED_ON_HEADERS)) continue;
						if (response.status === 404) {
							memory.dangling.set(tag, Date.now());
							memory.shared.delete(tag);
							continue;
						}
						const digest = response.headers["docker-content-digest"];
						if (response.status !== 200 || !digest || !isValidDigest(digest)) {
							continue;
						}
						if (protectedDigests.has(digest)) {
							memory.shared.set(tag, digest);
							continue;
						}
						memory.shared.delete(tag);
						if (!queuedKeys.has(`${repo}@${digest}`)) {
							doomedDigests.set(tag, digest);
						}
					}
					const deletions = selectDigestsToDelete({
						doomedDigests,
						protectedDigests,
					}).deleteDigests.map((digest) => ({
						repo,
						digest,
						tags: [...doomedDigests]
							.filter(([, value]) => value === digest)
							.map(([tag]) => tag),
					}));
					let added = 0;
					for (const entry of deletions) {
						if (!tryQueue(entry, listed.length)) break;
						added += 1;
					}
					// One wave's worth per repository per run: the others have a turn.
					if (added > 0 || full) return;
				}
			};

			// 6. The repositories in turn, starting where the last run stopped:
			// list, resolve, queue. Nothing is deleted here.
			const resumeAt = rotation.get(entity.composeId);
			const first = resumeAt ? Math.max(0, repos.indexOf(resumeAt)) : 0;
			const ordered = [...repos.slice(first), ...repos.slice(0, first)];
			const reposInRun = new Set<string>();
			let position = 0;
			let interrupted = false;
			try {
				for (; position < ordered.length && !full; position++) {
					const repo = ordered[position] as string;
					assertTime();
					const tags = await listTags(repo, firstPages.get(repos.indexOf(repo)));
					if (!tags) continue;
					const required = protectedByRepo.get(repo) ?? new Set<string>();
					const plan = planRepoTags({
						tags,
						protectedTags: required,
						tagTimes,
						keep,
					});
					if (plan.doomedTags.length === 0) continue;
					const before = queue.length;
					// Whatever the listing says, `latest` and every tag the release
					// files name are resolved too, so their digests are protected even
					// when the listing is stale or incomplete.
					await gatherRepo({
						repo,
						listed: tags,
						doomed: plan.doomedTags,
						resolve: [...new Set([...plan.keptTags, ...required, LATEST_TAG])],
						required,
					});
					if (queue.length > before) reposInRun.add(repo);
				}
			} catch (error) {
				if (!(error instanceof BudgetSpent) || cancelled) throw error;
				interrupted = true;
			}
			// The next run takes the repositories in turn: after the one that
			// filled the job; at the one the time ran out in, unless that was the
			// first (it alone used up the budget, so the next one must not start
			// with it again); from the front after a complete pass.
			if (interrupted) {
				const next = position === 0 ? 1 : position;
				rotation.set(entity.composeId, ordered[next % ordered.length] as string);
			} else if (full) {
				rotation.set(
					entity.composeId,
					ordered[position % ordered.length] as string,
				);
			} else {
				rotation.delete(entity.composeId);
			}

			if (queue.length === 0) {
				if (interrupted) throw new BudgetSpent("the time budget for cleanup ran out");
				return;
			}

			// 7. Hand the list to one detached job. The registry's lock decides
			// whether it may start; the deploy guard is looked at once more right
			// before, since a deploy that began during this run pushes things the
			// checks above could not see.
			if (cancelled) return;
			if (Date.now() >= deadline) {
				throw new BudgetSpent("the time budget for cleanup ran out");
			}
			if (
				hasConcurrentDeployment(
					await findAllDeploymentsByComposeId(entity.composeId),
					deployment.deploymentId,
					snapshotAt,
				)
			) {
				log.line(
					"Build registry cleanup stopped: another deployment of this compose started.",
				);
				return;
			}
			const token = randomBytes(8).toString("hex");
			const { stdout } = await runSession(
				buildRegistryDeleteJobCommand({ key: jobKey, token }),
				buildRegistryDeleteJobConfig({
					requests: queue.map((entry, id) => ({
						id,
						method: "DELETE" as const,
						url: getManifestUrl(base, entry.repo, entry.digest),
					})),
					username: registry.username,
					password: registry.password,
				}),
				deadline,
			);
			const started = parseRegistryJobOutput(stdout);
			const what = `${plural(queue.length, "old image manifest", "old image manifests")} (${plural(
				queue.reduce((sum, entry) => sum + entry.tags.length, 0),
				"dpl- tag",
				"dpl- tags",
			)}) from ${plural(reposInRun.size, "repository", "repositories")}`;
			if (started.kind === "nocurl") {
				throw new RetentionAbort("curl is not installed on the build server");
			}
			if (started.kind === "busy") {
				log.line(
					`Build registry cleanup: a deletion job is still running on the build server for this registry, so ${what} wait for the next deploy.`,
				);
				return;
			}
			// Whatever else came back, the job may have started (the answer can be
			// lost on the way): the next run asks, and the registry has the last
			// word about what is gone.
			pendingJobs.set(buildRegistryId, {
				composeId: entity.composeId,
				token,
				startedAt: Date.now(),
				entries: queue,
			});
			log.line(
				`Build registry cleanup: ${
					started.kind === "started"
						? "started a background job on the build server"
						: "sent a background job to the build server (it did not confirm in time that it started)"
				} that deletes ${what} one at a time, keeping the newest ${keep} per service${
					interrupted
						? "; it stopped reading at the time budget and the rest continues on the next deploy"
						: ""
				}. Deletions are sent, not yet confirmed: the next deploy checks them.`,
			);
		};

		// The batches stop themselves at the deadline; this only catches a step
		// that hangs past it (the database, an SSH connect).
		await withTimeout(
			run(),
			budgetMs + BACKSTOP_GRACE_MS,
			() => new BudgetSpent("the time budget for cleanup ran out"),
		).catch((error) => {
			cancelled = true;
			for (const session of activeSessions) session.abort();
			throw error;
		});
	} catch (error) {
		if (error instanceof BudgetSpent) {
			log.line(
				"Build registry cleanup stopped at the time budget before starting a deletion job; it continues on the next deploy.",
			);
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		log.line(
			`Warning: ⚠️ Build registry cleanup did not complete: ${redact(message, password)}`,
		);
	} finally {
		pruneInFlight.delete(entity.composeId);
		await log.close();
	}
};
