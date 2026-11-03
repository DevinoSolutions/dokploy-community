import type { FetchLike } from "../github-deployments/device-flow";
import { GITHUB_API, rateLimitRetryAt } from "../github-deployments/github-api";
import type { EnvironmentPolicy } from "./environment-policy";
import type { CompareStatus } from "./ordering";

/**
 * The GitHub REST calls the connection makes beyond #577's Deployments calls:
 * repositories, branches, workflow runs, artifacts, compare and environments.
 * Everything goes through an injected `fetch`. Nothing here logs or returns
 * the token.
 */

export type ApiResponse = Awaited<ReturnType<FetchLike>> & {
	arrayBuffer?: () => Promise<ArrayBuffer>;
};
export type ApiFetch = (
	input: string,
	init?: Parameters<FetchLike>[1],
) => Promise<ApiResponse>;

export interface ApiDeps {
	fetch: ApiFetch;
	now: () => number;
}

export type ApiResult<T> =
	| { kind: "ok"; value: T; etag: string | null }
	| { kind: "not-modified" }
	| { kind: "not-found" }
	| { kind: "unauthorized" }
	| { kind: "forbidden"; message: string }
	| { kind: "rate-limited"; retryAt: number }
	| { kind: "error"; status: number };

export type ApiFailure = Exclude<ApiResult<never>, { kind: "ok" }>;

const headers = (token: string, extra: Record<string, string> = {}) => ({
	Accept: "application/vnd.github+json",
	Authorization: `Bearer ${token}`,
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "dokploy-community",
	...extra,
});

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const isDotSegment = (name: string) => /^\.{1,2}$/.test(name);
export const isGithubName = (name: string) =>
	GITHUB_NAME.test(name) && !isDotSegment(name);

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
const str = (value: unknown): string | null =>
	typeof value === "string" ? value : null;
const int = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** One GET, with the failure statuses mapped the same way for every call. */
const get = async <T>(
	deps: ApiDeps,
	token: string,
	url: string,
	map: (json: unknown) => T | null,
	options: { etag?: string | null } = {},
): Promise<ApiResult<T>> => {
	let response: ApiResponse;
	try {
		response = await deps.fetch(url, {
			method: "GET",
			headers: headers(
				token,
				options.etag ? { "If-None-Match": options.etag } : {},
			),
		});
	} catch {
		return { kind: "error", status: 0 };
	}
	if (response.status === 304) return { kind: "not-modified" };
	if (response.status === 401) return { kind: "unauthorized" };
	if (response.status === 404) return { kind: "not-found" };
	if (response.status === 403 || response.status === 429) {
		const body = await response.text().catch(() => "");
		const retryAt = rateLimitRetryAt(
			response.status,
			response.headers,
			body,
			deps.now(),
		);
		return retryAt !== null
			? { kind: "rate-limited", retryAt }
			: { kind: "forbidden", message: "GitHub refused access" };
	}
	if (!response.ok) return { kind: "error", status: response.status };
	const value = map(await response.json().catch(() => null));
	if (value === null) return { kind: "error", status: response.status };
	return { kind: "ok", value, etag: response.headers.get("etag") };
};

export interface RepoRef {
	owner: string;
	repo: string;
}

const repoPath = (ref: RepoRef): string | null =>
	isGithubName(ref.owner) && isGithubName(ref.repo)
		? `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
		: null;

const NOT_FOUND: ApiFailure = { kind: "not-found" };

export interface RepositoryInfo {
	id: number;
	owner: string;
	name: string;
	fullName: string;
	defaultBranch: string;
	isPrivate: boolean;
}

const mapRepository = (json: unknown): RepositoryInfo | null => {
	const o = asObject(json);
	const owner = str(asObject(o?.owner)?.login);
	const name = str(o?.name);
	const id = int(o?.id);
	if (!o || !owner || !name || id === null) return null;
	return {
		id,
		owner,
		name,
		fullName: str(o.full_name) ?? `${owner}/${name}`,
		defaultBranch: str(o.default_branch) ?? "main",
		isPrivate: o.private === true,
	};
};

/** `GET /repositories/{id}`: the repository by its immutable id (a rename changes nothing). */
export const getRepositoryById = (
	deps: ApiDeps,
	token: string,
	repoId: number,
	etag?: string | null,
) =>
	get<RepositoryInfo>(
		deps,
		token,
		`${GITHUB_API}/repositories/${repoId}`,
		mapRepository,
		{ etag },
	);

/** `GET /repos/{owner}/{repo}`: used once, at Connect, to learn the repository id. */
export const getRepositoryByName = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
): Promise<ApiResult<RepositoryInfo>> => {
	const base = repoPath(ref);
	if (!base) return Promise.resolve(NOT_FOUND);
	return get<RepositoryInfo>(deps, token, base, mapRepository);
};

/** `GET /repos/{o}/{r}/branches/{branch}`: the head commit of a branch. */
export const getBranchHead = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	branch: string,
) => {
	const base = repoPath(ref);
	if (!base || branch.length === 0 || branch.length > 255) {
		return Promise.resolve(NOT_FOUND);
	}
	return get<{ sha: string }>(
		deps,
		token,
		`${base}/branches/${encodeURIComponent(branch)}`,
		(json) => {
			const sha = str(asObject(asObject(json)?.commit)?.sha);
			return sha && /^[0-9a-f]{40}$/.test(sha) ? { sha } : null;
		},
	);
};

export interface RunInfo {
	id: number;
	attempt: number;
	/** `path` of the run with any `@ref` suffix removed. */
	path: string;
	headBranch: string | null;
	headSha: string;
	event: string;
	status: string;
	conclusion: string | null;
	repositoryId: number | null;
	headRepositoryId: number | null;
	htmlUrl: string;
	runStartedAt: string | null;
	updatedAt: string | null;
}

const mapRun = (json: unknown): RunInfo | null => {
	const o = asObject(json);
	const id = int(o?.id);
	const headSha = str(o?.head_sha);
	const status = str(o?.status);
	if (!o || id === null || !headSha || !status) return null;
	const path = (str(o.path) ?? "").split("@")[0] ?? "";
	return {
		id,
		attempt: int(o.run_attempt) ?? 1,
		path,
		headBranch: str(o.head_branch),
		headSha,
		event: str(o.event) ?? "",
		status,
		conclusion: str(o.conclusion),
		repositoryId: int(asObject(o.repository)?.id),
		headRepositoryId: int(asObject(o.head_repository)?.id),
		htmlUrl: str(o.html_url) ?? "",
		runStartedAt: str(o.run_started_at),
		updatedAt: str(o.updated_at),
	};
};

/** `GET /repos/{o}/{r}/actions/runs/{id}/attempts/{n}`: that attempt, not the latest. */
export const getRunAttempt = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	runId: number,
	attempt: number,
) => {
	const base = repoPath(ref);
	if (!base) return Promise.resolve(NOT_FOUND);
	return get<RunInfo>(
		deps,
		token,
		`${base}/actions/runs/${runId}/attempts/${attempt}`,
		mapRun,
	);
};

/** `GET .../actions/workflows/{file}/runs?branch=`: the newest runs of the release workflow. */
export const listWorkflowRuns = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	workflowFile: string,
	branch: string,
	etag?: string | null,
) => {
	const base = repoPath(ref);
	if (!base || !/^[A-Za-z0-9._-]{1,100}$/.test(workflowFile)) {
		return Promise.resolve(NOT_FOUND);
	}
	return get<RunInfo[]>(
		deps,
		token,
		`${base}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?branch=${encodeURIComponent(branch)}&per_page=20`,
		(json) => {
			const list = asObject(json)?.workflow_runs;
			if (!Array.isArray(list)) return null;
			return list.map(mapRun).filter((r): r is RunInfo => r !== null);
		},
		{ etag },
	);
};

export interface ArtifactInfo {
	id: number;
	name: string;
	expired: boolean;
	sizeInBytes: number;
	workflowRunId: number | null;
	workflowRunRepositoryId: number | null;
	workflowRunHeadRepositoryId: number | null;
}

/** `GET .../actions/runs/{id}/artifacts?name=`: artifacts of one run, filtered by name. */
export const listRunArtifacts = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	runId: number,
	name: string,
) => {
	const base = repoPath(ref);
	if (!base) return Promise.resolve(NOT_FOUND);
	return get<ArtifactInfo[]>(
		deps,
		token,
		`${base}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=30`,
		(json) => {
			const list = asObject(json)?.artifacts;
			if (!Array.isArray(list)) return null;
			const artifacts: ArtifactInfo[] = [];
			for (const item of list) {
				const o = asObject(item);
				const id = int(o?.id);
				const artifactName = str(o?.name);
				if (!o || id === null || !artifactName) continue;
				const run = asObject(o.workflow_run);
				artifacts.push({
					id,
					name: artifactName,
					expired: o.expired !== false,
					sizeInBytes: int(o.size_in_bytes) ?? Number.MAX_SAFE_INTEGER,
					workflowRunId: int(run?.id),
					workflowRunRepositoryId: int(run?.repository_id),
					workflowRunHeadRepositoryId: int(run?.head_repository_id),
				});
			}
			return artifacts;
		},
	);
};

/**
 * `GET .../actions/artifacts/{id}/zip`: GitHub answers 302 to a signed blob
 * URL; `fetch` follows it and drops the Authorization header on the other
 * origin. The caller has already checked the size against the listing.
 */
export const downloadArtifactZip = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	artifactId: number,
	maxBytes: number,
): Promise<ApiResult<Uint8Array>> => {
	const base = repoPath(ref);
	if (!base) return NOT_FOUND;
	let response: ApiResponse;
	try {
		response = await deps.fetch(`${base}/actions/artifacts/${artifactId}/zip`, {
			method: "GET",
			headers: headers(token),
		});
	} catch {
		return { kind: "error", status: 0 };
	}
	if (response.status === 401) return { kind: "unauthorized" };
	if (response.status === 404 || response.status === 410) return NOT_FOUND;
	if (response.status === 403 || response.status === 429) {
		const body = await response.text().catch(() => "");
		const retryAt = rateLimitRetryAt(
			response.status,
			response.headers,
			body,
			deps.now(),
		);
		return retryAt !== null
			? { kind: "rate-limited", retryAt }
			: { kind: "forbidden", message: "GitHub refused access" };
	}
	if (!response.ok || !response.arrayBuffer) {
		return { kind: "error", status: response.status };
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > maxBytes) return { kind: "error", status: 413 };
	return { kind: "ok", value: bytes, etag: null };
};

/** `GET .../compare/{base}...{head}`: how `head` relates to `base`. */
export const compareCommits = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	base: string,
	head: string,
) => {
	const root = repoPath(ref);
	if (!root || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
		return Promise.resolve(NOT_FOUND);
	}
	return get<CompareStatus>(
		deps,
		token,
		`${root}/compare/${base}...${head}?per_page=1`,
		(json) => {
			const status = str(asObject(json)?.status);
			return status === "ahead" ||
				status === "behind" ||
				status === "identical" ||
				status === "diverged"
				? status
				: null;
		},
	);
};

/**
 * The environment and its deployment branch policies (two calls). Needs
 * repository read access; a 404 means the environment does not exist.
 */
export const getEnvironmentPolicy = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	environment: string,
): Promise<ApiResult<EnvironmentPolicy>> => {
	const base = repoPath(ref);
	if (!base || environment.length === 0 || environment.length > 255) {
		return NOT_FOUND;
	}
	const envUrl = `${base}/environments/${encodeURIComponent(environment)}`;
	const env = await get<{ custom: boolean; protectedBranches: boolean }>(
		deps,
		token,
		envUrl,
		(json) => {
			const policy = asObject(asObject(json)?.deployment_branch_policy);
			return {
				custom: policy?.custom_branch_policies === true,
				protectedBranches: policy?.protected_branches === true,
			};
		},
	);
	if (env.kind !== "ok") return env;
	if (!env.value.custom) {
		return {
			kind: "ok",
			value: {
				customBranchPolicies: false,
				protectedBranches: env.value.protectedBranches,
				policies: [],
			},
			etag: null,
		};
	}
	const list = await get<Array<{ name: string; type: string }>>(
		deps,
		token,
		`${envUrl}/deployment-branch-policies?per_page=30`,
		(json) => {
			const items = asObject(json)?.branch_policies;
			if (!Array.isArray(items)) return null;
			const policies: Array<{ name: string; type: string }> = [];
			for (const item of items) {
				const o = asObject(item);
				const name = str(o?.name);
				const type = str(o?.type);
				// An entry we cannot read is not skipped: skipping could leave one
				// allowed branch looking like the only one. Fail closed.
				if (!name || !type) return null;
				policies.push({ name, type });
			}
			return policies;
		},
	);
	if (list.kind !== "ok") return list;
	return {
		kind: "ok",
		value: {
			customBranchPolicies: true,
			protectedBranches: env.value.protectedBranches,
			policies: list.value,
		},
		etag: null,
	};
};

/** `GET .../contents/{path}?ref=`: the file text, for the "workflow found" check. */
export const getFileText = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	path: string,
	branch: string,
) => {
	const base = repoPath(ref);
	if (!base || path.includes("..") || path.length > 255) {
		return Promise.resolve(NOT_FOUND);
	}
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	return get<string>(
		deps,
		token,
		`${base}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
		(json) => {
			const o = asObject(json);
			const content = str(o?.content);
			if (!content || o?.encoding !== "base64") return null;
			return Buffer.from(content, "base64").toString("utf8");
		},
	);
};

/**
 * The repository-bound face of the calls above. Acceptance and the poller
 * depend on this interface, so tests can replace GitHub with a table.
 */
export interface ActionsApi {
	branchHead(branch: string): Promise<ApiResult<{ sha: string }>>;
	runAttempt(runId: number, attempt: number): Promise<ApiResult<RunInfo>>;
	artifacts(runId: number, name: string): Promise<ApiResult<ArtifactInfo[]>>;
	downloadArtifact(
		artifactId: number,
		maxBytes: number,
	): Promise<ApiResult<Uint8Array>>;
	compare(base: string, head: string): Promise<ApiResult<CompareStatus>>;
	environmentPolicy(environment: string): Promise<ApiResult<EnvironmentPolicy>>;
}

export const createActionsApi = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
): ActionsApi => ({
	branchHead: (branch) => getBranchHead(deps, token, ref, branch),
	runAttempt: (runId, attempt) =>
		getRunAttempt(deps, token, ref, runId, attempt),
	artifacts: (runId, name) => listRunArtifacts(deps, token, ref, runId, name),
	downloadArtifact: (artifactId, maxBytes) =>
		downloadArtifactZip(deps, token, ref, artifactId, maxBytes),
	compare: (base, head) => compareCommits(deps, token, ref, base, head),
	environmentPolicy: (environment) =>
		getEnvironmentPolicy(deps, token, ref, environment),
});
