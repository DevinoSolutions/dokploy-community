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
	getManifestChildDigests,
	getManifestUrl,
	getNextTagsPageUrl,
	getReadFilesCommand,
	getRegistryApiBases,
	getTagsListUrl,
	isValidDigest,
	mapDeploymentTagTimes,
	NO_CURL_MARKER,
	REGISTRY_CURL_COMMAND,
	type RegistryRequest,
	type RegistryResponse,
	parseOverrideImages,
	parseRegistryEndpoint,
	parseRegistryImageRef,
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
 * Progress: manifest operations on a registry backed by object storage can
 * take the better part of a second each, and one curl runs its requests one
 * after the other. So requests go out in small batches, a few SSH sessions at
 * a time, and a batch that runs out of time still counts what it answered;
 * what it did not answer is "unknown", which never makes anything deletable.
 * Each repository is resolved and pruned before the next one, oldest tags
 * first, so a run that stops at the time budget has still removed what it got
 * to, and the next deploy carries on from there.
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
 * Longest a single curl invocation may take before its SSH session is
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
/** Manifests actually deleted per run; a larger backlog is worked off over several deploys. */
const MAX_DELETIONS_PER_RUN = 50;
/** Requests per curl invocation (they run one after the other). */
const BATCH_SIZE = 20;
/** curl invocations, each over its own SSH session, running at once. */
const MAX_CONCURRENT_BATCHES = 3;
/** Old tags resolved before the next round of deletions. */
const WAVE_SIZE = BATCH_SIZE * MAX_CONCURRENT_BATCHES;
/** A "running" deployment older than this is a leftover, not a concurrent deploy. */
const RUNNING_DEPLOYMENT_WINDOW_MS = 2 * 60 * 60 * 1000;

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

const hasConcurrentDeployment = (
	deployments: {
		deploymentId: string;
		createdAt: string;
		status: string | null;
	}[],
	currentDeploymentId?: string,
) => {
	const now = Date.now();
	return deployments.some(
		(candidate) =>
			candidate.deploymentId !== currentDeploymentId &&
			candidate.status === "running" &&
			now - Date.parse(candidate.createdAt) < RUNNING_DEPLOYMENT_WINDOW_MS,
	);
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
	/** What this run has done so far; reported however it ends. */
	const progress = {
		/** Repositories with old tags this run got to. */
		repos: 0,
		/** Repositories at least one manifest was removed from. */
		prunedRepos: new Set<string>(),
		deleted: 0,
		removedTags: 0,
		gone: 0,
		failed: 0,
		/** DELETEs sent whose answer did not arrive in time. */
		unconfirmed: 0,
	};
	const progressDetails = () =>
		`${progress.failed ? `; ${progress.failed} failed` : ""}${
			progress.gone ? `; ${progress.gone} already gone` : ""
		}${
			progress.unconfirmed
				? `; ${progress.unconfirmed} not confirmed in time`
				: ""
		}`;
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
		const outOfTime = () => cancelled || Date.now() >= deadline;
		const assertTime = () => {
			if (outOfTime()) {
				throw new BudgetSpent("the time budget for cleanup ran out");
			}
		};

		/**
		 * One SSH session = one curl invocation on the build server. Running out
		 * of time is not an error: the session is dropped and the responses that
		 * arrived before that are returned; the rest are simply missing.
		 */
		const runBatch = async (requests: RegistryRequest[]) => {
			let stdout = "";
			let expired = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expiry = new Promise<null>((resolve) => {
				timer = setTimeout(
					() => {
						expired = true;
						resolve(null);
					},
					Math.max(1, Math.min(batchTimeoutMs, deadline - Date.now())),
				);
			});
			try {
				const opening = openRemoteInputSession(
					buildServerId,
					REGISTRY_CURL_COMMAND,
					{ onStdout: (text) => void (stdout += text) },
				);
				const session = await Promise.race([opening, expiry]);
				if (!session) {
					// Connecting took the whole slot; drop the session if it opens late.
					opening.then(
						(late) => late.abort(),
						() => {},
					);
					return new Map<number, RegistryResponse>();
				}
				activeSessions.add(session);
				void expiry.then(() => session.abort());
				try {
					try {
						await session.write(
							Buffer.from(
								buildRegistryCurlConfig({
									requests,
									username: registry.username,
									password: registry.password,
								}),
								"utf8",
							),
						);
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
			if (stdout.includes(NO_CURL_MARKER)) {
				throw new RetentionAbort("curl is not installed on the build server");
			}
			return parseRegistryResponses(stdout);
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
			if (hasConcurrentDeployment(deployments, deployment.deploymentId)) {
				log.line(
					"Build registry cleanup deferred: another deployment of this compose is running.",
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

			// 4. The first page of every repository's tag listing, in one go. It is
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
					const next = getNextTagsPageUrl(base, repo, response.headers.link);
					if (next === null) return tags;
					// A partial listing cannot tell what is kept.
					if (next === undefined) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: the tag listing links to a next page that is not this repository's listing on this registry.`,
						);
						return null;
					}
					if (seen.has(next)) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: the tag listing is paged in a loop.`,
						);
						return null;
					}
					if (page >= MAX_TAG_PAGES) {
						log.line(
							`Warning: ⚠️ Build registry cleanup skipped ${repo}: its tag listing has more than ${MAX_TAG_PAGES} pages (${tags.length} tags so far).`,
						);
						return null;
					}
					seen.add(next);
					assertTime();
					response = (
						await runAll([
							{ id: 0, method: "GET", url: next, includeHeaders: true },
						])
					).get(0);
				}
			};

			/** Set once a concurrent deploy shows up or the deletion cap is hit. */
			let stopped = false;

			/** Resolves and prunes one repository. */
			const pruneRepo = async ({
				repo,
				doomed,
				resolve,
				required,
			}: {
				repo: string;
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
					protectedDigests.add(digest);
					for (const child of getManifestChildDigests(response.body)) {
						protectedDigests.add(child);
					}
				}
				if (unanswered > 0) {
					assertTime();
					log.line(
						`Build registry cleanup left ${repo} for the next deploy: ${plural(unanswered, "kept tag", "kept tags")} did not resolve in time.`,
					);
					return;
				}

				// b. Old tags, oldest first, a wave at a time: resolve with HEAD,
				// delete what no kept tag needs, then the next wave. A doomed tag
				// that no longer resolves (HEAD 404) is dangling: nothing to delete,
				// nothing counted. One that did not answer is left alone.
				const removed = new Set<string>();
				for (let start = 0; start < doomed.length; start += WAVE_SIZE) {
					if (progress.deleted >= MAX_DELETIONS_PER_RUN) {
						stopped = true;
						return;
					}
					assertTime();
					const wave = doomed.slice(start, start + WAVE_SIZE);
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
						const digest = response.headers["docker-content-digest"];
						if (
							response.status === 200 &&
							digest &&
							isValidDigest(digest) &&
							!removed.has(digest)
						) {
							doomedDigests.set(tag, digest);
						}
					}
					const deletions = selectDigestsToDelete({
						doomedDigests,
						protectedDigests,
					}).deleteDigests.map((digest) => ({
						digest,
						tags: [...doomedDigests]
							.filter(([, value]) => value === digest)
							.map(([tag]) => tag),
					}));

					// c. Delete. Before every round look again for a deploy that
					// started while this ran: its pushes are the one thing the checks
					// above cannot see. Only manifests actually deleted count against
					// the per-run cap.
					let next = 0;
					while (next < deletions.length) {
						if (progress.deleted >= MAX_DELETIONS_PER_RUN) {
							stopped = true;
							return;
						}
						assertTime();
						if (
							hasConcurrentDeployment(
								await findAllDeploymentsByComposeId(entity.composeId),
								deployment.deploymentId,
							)
						) {
							log.line(
								"Build registry cleanup stopped: another deployment of this compose started.",
							);
							stopped = true;
							return;
						}
						const round = deletions.slice(
							next,
							next +
								Math.min(WAVE_SIZE, MAX_DELETIONS_PER_RUN - progress.deleted),
						);
						next += round.length;
						const { responses, failed, error } = await runBatches(
							round.map((entry, id) => ({
								id,
								method: "DELETE" as const,
								url: getManifestUrl(base, repo, entry.digest),
							})),
						);
						for (const [id, entry] of round.entries()) {
							const response = responses.get(id);
							if (!response) {
								progress.unconfirmed += 1;
								continue;
							}
							if (response.status === 202) {
								progress.deleted += 1;
								progress.removedTags += entry.tags.length;
								progress.prunedRepos.add(repo);
								removed.add(entry.digest);
								continue;
							}
							if (response.status === 404) {
								progress.gone += 1;
								removed.add(entry.digest);
								continue;
							}
							failIfSystemic(response.status, "deleting manifests");
							progress.failed += 1;
							log.line(
								`Warning: ⚠️ Build registry cleanup: deleting ${repo}@${entry.digest.slice(0, 19)} returned HTTP ${response.status}.`,
							);
						}
						if (failed) throw error;
					}
				}
			};

			// 5. One repository at a time: list, resolve, prune.
			for (const [index, repo] of repos.entries()) {
				if (stopped) break;
				assertTime();
				const tags = await listTags(repo, firstPages.get(index));
				if (!tags) continue;
				const required = protectedByRepo.get(repo) ?? new Set<string>();
				const plan = planRepoTags({
					tags,
					protectedTags: required,
					tagTimes,
					keep,
				});
				if (plan.doomedTags.length === 0) continue;
				progress.repos += 1;
				// Whatever the listing says, `latest` and every tag the release
				// files name are resolved too, so their digests are protected even
				// when the listing is stale or incomplete.
				await pruneRepo({
					repo,
					doomed: plan.doomedTags,
					resolve: [...new Set([...plan.keptTags, ...required, LATEST_TAG])],
					required,
				});
			}

			if (progress.deleted > 0 || progress.failed > 0) {
				log.line(
					`Build registry cleanup: removed ${plural(progress.deleted, "old image manifest", "old image manifests")} (${plural(progress.removedTags, "dpl- tag", "dpl- tags")}) from ${plural(progress.repos, "repository", "repositories")}, keeping the newest ${keep} per service${progressDetails()}.`,
				);
			}
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
				progress.deleted > 0 || progress.failed > 0
					? `Build registry cleanup stopped at the time budget: removed ${plural(progress.deleted, "old image manifest", "old image manifests")} (${plural(progress.removedTags, "dpl- tag", "dpl- tags")}) from ${plural(progress.prunedRepos.size, "repository", "repositories")}${progressDetails()}; the rest continues on the next deploy.`
					: `Build registry cleanup stopped at the time budget before removing anything${progressDetails()}; it continues on the next deploy.`,
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
