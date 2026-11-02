import { readFile } from "node:fs/promises";
import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	deployments,
	environments,
	github,
	gitProvider,
	projects,
} from "@dokploy/server/db/schema";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import {
	authGithub,
	DEFAULT_GITHUB_API_URL,
	deriveGithubApiUrl,
	getGithubToken,
	haveGithubRequirements,
} from "@dokploy/server/utils/providers/github";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { quote } from "shell-quote";
import {
	LIVE_BUILD_RUN_STATUSES,
	parseBuildRunUrl,
} from "./build-origin-shared";
import { appendGithubLines } from "./external-build";
import {
	createGithubRunPoller,
	type LiveRunRow,
	POLL_INTERVAL_MS,
	type PollerDeps,
	type RunFetchResult,
} from "./github-run-poller";
import type { GithubRunJob } from "./github-run-progress";

/**
 * The real database, hosts and GitHub behind the live-row poller (github-run-poller.ts).
 */

const LOG_TAIL_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

// Every registered row no deploy took over, also one whose run is over: it still has its takeover grace to run.
const liveRowFilter = and(
	eq(deployments.status, "running"),
	eq(deployments.buildOrigin, "github-actions"),
	eq(deployments.externalBuildOnly, true),
	isNotNull(deployments.buildRunId),
	isNotNull(deployments.buildRepository),
);

const listLiveRows = async (): Promise<LiveRunRow[]> => {
	const rows = await db
		.select({
			deploymentId: deployments.deploymentId,
			applicationId: deployments.applicationId,
			composeId: deployments.composeId,
			serverId: deployments.serverId,
			buildServerId: deployments.buildServerId,
			logPath: deployments.logPath,
			buildRepository: deployments.buildRepository,
			buildRunId: deployments.buildRunId,
			buildRunUrl: deployments.buildRunUrl,
			buildRunStatus: deployments.buildRunStatus,
			buildRunStep: deployments.buildRunStep,
			startedAt: deployments.startedAt,
			createdAt: deployments.createdAt,
		})
		.from(deployments)
		.where(liveRowFilter)
		.orderBy(deployments.createdAt);
	return rows.flatMap((row) =>
		row.buildRepository && row.buildRunId
			? [
					{
						...row,
						buildRepository: row.buildRepository,
						buildRunId: row.buildRunId,
					},
				]
			: [],
	);
};

const organizationOf = async (row: LiveRunRow): Promise<string | null> => {
	if (row.applicationId) {
		const [found] = await db
			.select({ organizationId: projects.organizationId })
			.from(applications)
			.innerJoin(
				environments,
				eq(applications.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(eq(applications.applicationId, row.applicationId));
		return found?.organizationId ?? null;
	}
	if (row.composeId) {
		const [found] = await db
			.select({ organizationId: projects.organizationId })
			.from(compose)
			.innerJoin(
				environments,
				eq(compose.environmentId, environments.environmentId),
			)
			.innerJoin(projects, eq(environments.projectId, projects.projectId))
			.where(eq(compose.composeId, row.composeId));
		return found?.organizationId ?? null;
	}
	return null;
};

type ProviderRow = typeof github.$inferSelect;

/** The GitHub App providers of the organization that can mint an installation token on github.com. */
const providersOf = async (organizationId: string): Promise<ProviderRow[]> => {
	const rows = await db
		.select({ provider: github })
		.from(github)
		.innerJoin(gitProvider, eq(github.gitProviderId, gitProvider.gitProviderId))
		.where(eq(gitProvider.organizationId, organizationId));
	return rows
		.map((row) => row.provider)
		.filter((provider) => {
			if (!haveGithubRequirements(provider)) return false;
			try {
				// Only github.com runs have a link Dokploy accepts; a Server instance is another host.
				return (
					deriveGithubApiUrl(provider.githubUrl) === DEFAULT_GITHUB_API_URL
				);
			} catch {
				return false;
			}
		});
};

// The provider that last read a repository, tried first next time.
const workingProvider = new Map<string, string>();
const organizationCache = new Map<
	string,
	{ organizationId: string | null; at: number }
>();
const ORGANIZATION_CACHE_MS = 10 * 60_000;

type HttpAnswer =
	| {
			ok: true;
			json: unknown;
			remaining: number | null;
			resetAt: number | null;
	  }
	| {
			ok: false;
			status: number;
			retryAfterMs: number | null;
			remaining: number | null;
			resetAt: number | null;
	  };

const numberHeader = (headers: Headers, name: string) => {
	const value = Number(headers.get(name));
	return headers.get(name) !== null && Number.isFinite(value) ? value : null;
};

const getJson = async (
	url: string,
	token: string | null,
): Promise<HttpAnswer> => {
	const response = await fetch(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "dokploy-community",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		redirect: "error",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const remaining = numberHeader(response.headers, "x-ratelimit-remaining");
	const reset = numberHeader(response.headers, "x-ratelimit-reset");
	const resetAt = reset === null ? null : reset * 1000;
	if (response.ok) {
		return { ok: true, json: await response.json(), remaining, resetAt };
	}
	const retryAfter = numberHeader(response.headers, "retry-after");
	return {
		ok: false,
		status: response.status,
		retryAfterMs: retryAfter === null ? null : retryAfter * 1000,
		remaining,
		resetAt,
	};
};

/** A 403 or 429 that is the rate limit, as opposed to a repository this token cannot see. */
const isRateLimited = (answer: Extract<HttpAnswer, { ok: false }>) =>
	answer.status === 429 ||
	(answer.status === 403 &&
		(answer.remaining === 0 || answer.retryAfterMs !== null));

const backoffOf = (
	answer: Extract<HttpAnswer, { ok: false }>,
	now: number,
): RunFetchResult => ({
	kind: "backoff",
	retryAfterMs:
		answer.retryAfterMs ??
		(answer.resetAt !== null ? Math.max(answer.resetAt - now, 60_000) : 60_000),
});

const jobsUrl = (row: LiveRunRow) => {
	const attempt = parseBuildRunUrl(row.buildRunUrl)?.attempt;
	return `${DEFAULT_GITHUB_API_URL}/repos/${row.buildRepository}/actions/runs/${row.buildRunId}${
		attempt ? `/attempts/${attempt}` : ""
	}/jobs?per_page=100`;
};

const runUrl = (row: LiveRunRow) => {
	const attempt = parseBuildRunUrl(row.buildRunUrl)?.attempt;
	return `${DEFAULT_GITHUB_API_URL}/repos/${row.buildRepository}/actions/runs/${row.buildRunId}${
		attempt ? `/attempts/${attempt}` : ""
	}`;
};

const fetchRun = async (row: LiveRunRow): Promise<RunFetchResult> => {
	const now = Date.now();
	let organizationId: string | null = null;
	const cached = organizationCache.get(row.deploymentId);
	if (cached && now - cached.at < ORGANIZATION_CACHE_MS) {
		organizationId = cached.organizationId;
	} else {
		organizationId = await organizationOf(row);
		organizationCache.set(row.deploymentId, { organizationId, at: now });
	}

	const tokens: Array<{ id: string | null; token: string | null }> = [];
	if (organizationId) {
		const providers = await providersOf(organizationId);
		const first = workingProvider.get(row.buildRepository);
		providers.sort(
			(a, b) => Number(b.githubId === first) - Number(a.githubId === first),
		);
		for (const provider of providers) {
			try {
				tokens.push({
					id: provider.githubId,
					token: await getGithubToken(authGithub(provider)),
				});
			} catch (error) {
				console.error(
					`GitHub run poller: no installation token from provider ${provider.githubId}`,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}
	// A public repository can be read without any token.
	tokens.push({ id: null, token: null });

	for (const { id, token } of tokens) {
		const jobs = await getJson(jobsUrl(row), token);
		if (!jobs.ok) {
			if (isRateLimited(jobs)) return backoffOf(jobs, now);
			// 401 / 403 / 404: this token cannot see the repository; the next one may. 5xx: later.
			if (jobs.status >= 500) return { kind: "backoff", retryAfterMs: 60_000 };
			continue;
		}
		if (id) workingProvider.set(row.buildRepository, id);
		const list = (jobs.json as { jobs?: GithubRunJob[] } | null)?.jobs ?? [];
		const allDone =
			list.length > 0 && list.every((job) => job.status === "completed");
		let run: { status: string | null; conclusion: string | null } | null = null;
		let remaining = jobs.remaining;
		let resetAt = jobs.resetAt;
		if (allDone) {
			// The jobs say it is over; the run has the conclusion and knows of jobs that start later.
			const answer = await getJson(runUrl(row), token).catch(() => null);
			if (answer?.ok) {
				const body = answer.json as {
					status?: string;
					conclusion?: string | null;
				};
				run = {
					status: body.status ?? null,
					conclusion: body.conclusion ?? null,
				};
				remaining = answer.remaining;
				resetAt = answer.resetAt;
			}
		}
		return {
			kind: "ok",
			jobs: list,
			run,
			authenticated: token !== null,
			rateLimitRemaining: remaining,
			rateLimitResetAt: resetAt,
		};
	}
	return { kind: "unreadable" };
};

const logHostOf = (row: Pick<LiveRunRow, "serverId" | "buildServerId">) =>
	row.buildServerId || row.serverId || null;

const readLog = async (row: LiveRunRow): Promise<string> => {
	try {
		const host = logHostOf(row);
		if (host) {
			const { stdout } = await execAsyncRemote(
				host,
				`tail -c ${LOG_TAIL_BYTES} -- ${quote([row.logPath])}`,
			);
			return String(stdout ?? "");
		}
		const text = await readFile(row.logPath, "utf8");
		return text.slice(-LOG_TAIL_BYTES);
	} catch {
		// No log to compare with: lines may then be written twice, never lost.
		return "";
	}
};

const stillWaiting = and(
	eq(deployments.status, "running"),
	eq(deployments.buildOrigin, "github-actions"),
	eq(deployments.externalBuildOnly, true),
);
// Progress is only written while the run is: a finished run stays finished.
const runStillGoing = and(
	stillWaiting,
	inArray(deployments.buildRunStatus, [...LIVE_BUILD_RUN_STATUSES]),
);

export const createDefaultGithubRunPollerDeps = (): PollerDeps => ({
	now: () => Date.now(),
	listLiveRows,
	fetchRun,
	readLog,
	appendLines: (row, lines) => appendGithubLines(row, lines),
	setProgress: async (deploymentId, progress) => {
		const changed = await db
			.update(deployments)
			.set({
				buildRunStatus: progress.buildRunStatus,
				buildRunStep: progress.buildRunStep,
			})
			.where(and(eq(deployments.deploymentId, deploymentId), runStillGoing))
			.returning({ deploymentId: deployments.deploymentId });
		return changed.length > 0;
	},
	markRunFinished: async (deploymentId) => {
		const changed = await db
			.update(deployments)
			.set({ buildRunStatus: "completed", buildRunStep: null })
			.where(and(eq(deployments.deploymentId, deploymentId), stillWaiting))
			.returning({ deploymentId: deployments.deploymentId });
		return changed.length > 0;
	},
	endRow: async (deploymentId, outcome) => {
		const changed = await db
			.update(deployments)
			.set({
				status: outcome.status,
				finishedAt: new Date().toISOString(),
				errorMessage: outcome.errorMessage,
				buildRunStatus: "completed",
				buildRunStep: null,
			})
			.where(and(eq(deployments.deploymentId, deploymentId), stillWaiting))
			.returning({ deploymentId: deployments.deploymentId });
		return changed.length > 0;
	},
});

/**
 * Starts the poller (one loop for every live row; a pass with no live row is one cheap query). Self-hosted only,
 * like the watchdog. Returns a function that stops it.
 */
export const startGithubRunPoller = (
	deps: PollerDeps = createDefaultGithubRunPollerDeps(),
	intervalMs: number = POLL_INTERVAL_MS,
): (() => void) => {
	if (IS_CLOUD) return () => {};
	const poller = createGithubRunPoller(deps);
	const timer = setInterval(() => void poller.poll(), intervalMs);
	// A pass must never keep the process alive on shutdown.
	timer.unref?.();
	return () => clearInterval(timer);
};
