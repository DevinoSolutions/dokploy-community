import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type {
	apiFindGithubBranches,
	apiFindGithubPullRequests,
} from "@dokploy/server/db/schema";
import { findGithubById, type Github } from "@dokploy/server/services/github";
import type { ChangeRequest } from "@dokploy/server/types/change-request";
import type { InferResultType } from "@dokploy/server/types/with";
import { GIT_ALLOW_PROTOCOL_ENV } from "@dokploy/server/utils/providers/git-url";
import {
	assertGithubHostReachable,
	createPinnedGithubFetch,
	GIT_NO_REDIRECTS_CONFIG,
	GithubHostError,
	type GithubHostGuardOptions,
	getAllowedGithubHosts,
	githubHostPolicyError,
	githubHostRefusalMessage,
	githubInstanceRequestOptions,
	isPublicGithubHost,
	redactAddresses,
} from "@dokploy/server/utils/providers/github-host";
import { buildHeadRefCheckoutCommand } from "@dokploy/server/utils/providers/head-ref";
import { buildPinCommitCommand } from "@dokploy/server/utils/providers/pin-commit";
import { createAppAuth } from "@octokit/auth-app";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import { quote } from "shell-quote";
import type { z } from "zod";
import { getGitTokenAuthConfig } from "./git";

export const DEFAULT_GITHUB_URL = "https://github.com";
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";

const parseGithubBaseUrlShape = (
	githubUrl?: string | null,
): { url: string; hostname: string } | { error: string } => {
	const raw = githubUrl?.trim();
	if (!raw) {
		return { url: DEFAULT_GITHUB_URL, hostname: "github.com" };
	}

	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
		? raw
		: `https://${raw}`;

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return { error: `"${raw}" is not a valid URL` };
	}

	if (parsed.protocol !== "https:") {
		return { error: "Only https is supported for GitHub instances" };
	}

	// "acme.ghe.com." resolves the same as "acme.ghe.com", but the trailing dot
	// would slip past the checks below.
	if (parsed.hostname.endsWith(".")) {
		parsed.hostname = parsed.hostname.replace(/\.+$/, "");
	}

	const { hostname } = parsed;

	// "https://." is nothing once the root label is removed.
	if (/^\.*$/.test(hostname)) {
		return { error: `"${raw}" is not a valid URL` };
	}

	if (!hostname.includes(".")) {
		return { error: `"${hostname}" is not a fully qualified hostname` };
	}

	return { url: `${parsed.protocol}//${parsed.host}`, hostname };
};

/**
 * The GitHub base URL a user typed, or why it is refused. An IP address or an
 * internal host name (localhost, .local, .internal) is refused unless its
 * hostname is in `allowedHosts` (DOKPLOY_GITHUB_ENTERPRISE_ALLOWED_HOSTS); the
 * name is resolved later, by assertGithubHostReachable.
 */
export const parseGithubBaseUrl = (
	githubUrl?: string | null,
	allowedHosts: ReadonlySet<string> = getAllowedGithubHosts(),
): { url: string } | { error: string } => {
	const result = parseGithubBaseUrlShape(githubUrl);
	if ("error" in result) return result;
	const policyError = githubHostPolicyError(result.hostname, allowedHosts);
	return policyError ? { error: policyError } : { url: result.url };
};

// Stored values are only normalized here; the host policy applies when a URL
// is entered (parseGithubBaseUrl) and before a request is sent.
export const normalizeGithubUrl = (githubUrl?: string | null): string => {
	const result = parseGithubBaseUrlShape(githubUrl);
	return "url" in result ? result.url : DEFAULT_GITHUB_URL;
};

export const deriveGithubApiUrl = (githubUrl?: string | null): string => {
	const normalized = normalizeGithubUrl(githubUrl);
	const { protocol, host } = new URL(normalized);

	if (host === "github.com" || host === "www.github.com") {
		return DEFAULT_GITHUB_API_URL;
	}

	// Data residency tenants keep the api. prefix; GHES does not have one.
	if (host === "ghe.com" || host.endsWith(".ghe.com")) {
		return `${protocol}//api.${host}`;
	}

	return `${protocol}//${host}/api/v3`;
};

/**
 * Octokit options for the provider's GitHub instance. Every call to a stored
 * host other than github.com goes through the pinned fetch (host policy and
 * address check at connect time, no redirects, 15 second timeout per request).
 * Retries are off there, so a failing instance is not asked again within a
 * longer window; github.com is left as it is.
 */
const githubInstanceOptions = (githubUrl?: string | null) => {
	const apiUrl = deriveGithubApiUrl(githubUrl);
	if (isPublicGithubHost(new URL(apiUrl).hostname)) return {};
	return {
		request: { fetch: createPinnedGithubFetch() },
		retry: { enabled: false },
	};
};

export const authGithub = (githubProvider: Github): Octokit => {
	if (!haveGithubRequirements(githubProvider)) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Github Account not configured correctly",
		});
	}

	const octokit: Octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider?.githubAppId || 0,
			privateKey: githubProvider?.githubPrivateKey || "",
			installationId: githubProvider?.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider?.githubUrl),
		...githubInstanceOptions(githubProvider?.githubUrl),
	});

	return octokit;
};

/**
 * The app URL a provider stores (`html_url` of the converted manifest) as a
 * URL, or null unless it is on the provider's own GitHub instance: same
 * scheme, host and port as `githubUrl`. `http:` therefore only passes for an
 * instance that is itself served over http.
 */
export const parseGithubAppUrl = (
	appUrl: string | null | undefined,
	githubUrl: string | null | undefined,
): URL | null => {
	try {
		const app = new URL(appUrl ?? "");
		const instance = new URL(githubUrl?.trim() || DEFAULT_GITHUB_URL);
		if (app.protocol !== "https:" && app.protocol !== "http:") return null;
		return app.origin === instance.origin ? app : null;
	} catch {
		return null;
	}
};

/**
 * Throws a GithubHostError unless the server may call the GitHub instance at
 * `baseUrl`: the host the user typed and the API host Octokit connects to
 * (api.<host> for ghe.com tenants) both have to pass.
 */
export const assertGithubInstanceReachable = async (
	baseUrl: string,
	guard: GithubHostGuardOptions = {},
): Promise<void> => {
	const base = new URL(normalizeGithubUrl(baseUrl));
	await assertGithubHostReachable(base.origin, guard);
	const apiHost = new URL(deriveGithubApiUrl(baseUrl)).hostname;
	if (apiHost !== base.hostname) {
		await assertGithubHostReachable(`https://${apiHost}`, {
			...guard,
			displayHost: base.hostname,
		});
	}
};

/**
 * Exchanges the code GitHub hands back after the manifest form for the new
 * app's credentials, at the instance `baseUrl` names. The host is checked
 * first (GithubHostError when it is refused), redirects are not followed and
 * the request times out.
 */
export const convertGithubManifest = async (
	baseUrl: string,
	code: string,
	guard: GithubHostGuardOptions & { fetch?: typeof fetch } = {},
) => {
	await assertGithubInstanceReachable(baseUrl, guard);
	const octokit = new Octokit({
		baseUrl: deriveGithubApiUrl(baseUrl),
		request: githubInstanceRequestOptions(guard.fetch, guard),
		// The manifest code can be used once, so a failed POST is not repeated.
		retry: { enabled: false },
	});
	try {
		const { data } = await octokit.request(
			"POST /app-manifests/{code}/conversions",
			{ code },
		);
		return data;
	} catch (error) {
		const refusal = githubHostRefusalMessage(error);
		if (refusal) throw new GithubHostError(refusal);
		throw error;
	}
};

export type GithubInstallationCheck =
	| { ok: true }
	| { ok: false; reason: "invalid" | "not_found" | "unavailable" }
	// The server may not call this host; `message` is safe to show.
	| { ok: false; reason: "host_refused"; message: string };

/**
 * Asks GitHub, with the app's own JWT, whether `installationId` is an
 * installation of this app. GitHub only returns the app's own installations
 * for that call, so an id from another app (or a made-up one) is a 404.
 */
export const verifyGithubInstallation = async (
	githubProvider: Pick<
		Github,
		"githubAppId" | "githubPrivateKey" | "githubUrl"
	>,
	installationId: string,
	guard: GithubHostGuardOptions & {
		fetch?: typeof fetch;
		retryAfterBaseValue?: number;
	} = {},
): Promise<GithubInstallationCheck> => {
	if (!/^[1-9][0-9]{0,14}$/.test(installationId)) {
		return { ok: false, reason: "invalid" };
	}
	if (!githubProvider.githubAppId || !githubProvider.githubPrivateKey) {
		return { ok: false, reason: "unavailable" };
	}

	// Before Octokit exists, so a refusal never reaches its retry plugin.
	try {
		await assertGithubInstanceReachable(githubProvider.githubUrl ?? "", guard);
	} catch (error) {
		if (error instanceof GithubHostError) {
			return { ok: false, reason: "host_refused", message: error.message };
		}
		return { ok: false, reason: "unavailable" };
	}

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider.githubAppId,
			privateKey: githubProvider.githubPrivateKey,
		},
		baseUrl: deriveGithubApiUrl(githubProvider.githubUrl),
		request: githubInstanceRequestOptions(guard.fetch, guard),
		...(guard.retryAfterBaseValue !== undefined && {
			retry: { retryAfterBaseValue: guard.retryAfterBaseValue },
		}),
	});

	try {
		const { data } = await octokit.request(
			"GET /app/installations/{installation_id}",
			{ installation_id: Number(installationId) },
		);
		return data.app_id === githubProvider.githubAppId
			? { ok: true }
			: { ok: false, reason: "not_found" };
	} catch (error) {
		const refusal = githubHostRefusalMessage(error);
		if (refusal) {
			return { ok: false, reason: "host_refused", message: refusal };
		}
		return {
			ok: false,
			reason:
				(error as { status?: number })?.status === 404
					? "not_found"
					: "unavailable",
		};
	}
};

export const GITHUB_REQUEST_FAILED_MESSAGE =
	"The request to the GitHub instance failed. Check the instance URL and the app's credentials; the server log has the details.";

/**
 * The error to give a client when a call to a GitHub instance failed. The text
 * of the remote answer and of a connection error can name an internal address
 * or carry what a service there replied, so it is not passed on: the client
 * gets the host policy's own message, or a generic one, and the detail goes to
 * the server log with addresses removed.
 */
export const githubClientError = (
	error: unknown,
	action: string,
): TRPCError => {
	const { name, status, code, message } = (error ?? {}) as {
		name?: unknown;
		status?: unknown;
		code?: unknown;
		message?: unknown;
	};
	console.error(
		`[github] ${action} failed: ${String(name ?? "Error")} status=${String(status ?? "-")} code=${String(code ?? "-")} ${redactAddresses(String(message ?? error))}`,
	);
	const refusal = githubHostRefusalMessage(error);
	if (refusal) return new TRPCError({ code: "BAD_REQUEST", message: refusal });
	if (status === 401 || status === 403) {
		return new TRPCError({
			code: "BAD_REQUEST",
			message:
				"The GitHub instance rejected the app's credentials or permissions.",
		});
	}
	if (status === 404) {
		return new TRPCError({
			code: "BAD_REQUEST",
			message: "The GitHub instance could not find what was asked for.",
		});
	}
	return new TRPCError({
		code: "BAD_REQUEST",
		message: GITHUB_REQUEST_FAILED_MESSAGE,
	});
};

export const getGithubToken = async (
	octokit: ReturnType<typeof authGithub>,
) => {
	const installation = (await octokit.auth({
		type: "installation",
	})) as {
		token: string;
	};

	return installation.token;
};

/**
 * Check if a GitHub user has write/admin permissions on a repository
 * This is used to validate PR authors before allowing preview deployments
 */
export const checkUserRepositoryPermissions = async (
	githubProvider: Github,
	owner: string,
	repo: string,
	username: string,
): Promise<{ hasWriteAccess: boolean; permission: string | null }> => {
	try {
		const octokit = authGithub(githubProvider);

		// Check if user is a collaborator with write permissions
		const { data: permission } =
			await octokit.rest.repos.getCollaboratorPermissionLevel({
				owner,
				repo,
				username,
			});

		// Allow only users with 'write', 'admin', or 'maintain' permissions
		// Currently exists Read, Triage, Write, Maintain, Admin
		const allowedPermissions = ["write", "admin", "maintain"];
		const hasWriteAccess = allowedPermissions.includes(permission.permission);

		return {
			hasWriteAccess,
			permission: permission.permission,
		};
	} catch (error) {
		// If user is not a collaborator, GitHub API returns 404
		console.warn(
			`User ${username} is not a collaborator of ${owner}/${repo}:`,
			error,
		);
		return {
			hasWriteAccess: false,
			permission: null,
		};
	}
};

export const haveGithubRequirements = (githubProvider: Github) => {
	return !!(
		githubProvider?.githubAppId &&
		githubProvider?.githubPrivateKey &&
		githubProvider?.githubInstallationId
	);
};

const getErrorCloneRequirements = (entity: {
	repository?: string | null;
	owner?: string | null;
	branch?: string | null;
}) => {
	const reasons: string[] = [];
	const { repository, owner, branch } = entity;

	if (!repository) reasons.push("1. Repository not assigned.");
	if (!owner) reasons.push("2. Owner not specified.");
	if (!branch) reasons.push("3. Branch not defined.");

	return reasons;
};

export type ApplicationWithGithub = InferResultType<
	"applications",
	{ github: true }
>;

export type ComposeWithGithub = InferResultType<"compose", { github: true }>;

interface CloneGithubRepository {
	appName: string;
	owner: string | null;
	branch: string | null;
	/**
	 * Pull-request head ref (e.g. `refs/pull/123/head`) to check out instead of
	 * `branch`. Set for preview deployments so pull requests from forks build
	 * from the base repository — see utils/providers/head-ref.ts.
	 */
	headRef?: string | null;
	githubId: string | null;
	repository: string | null;
	type?: "application" | "compose";
	enableSubmodules: boolean;
	serverId: string | null;
	outputPathOverride?: string;
	/**
	 * Commit the checkout must end on (T-7282): a compose's build-server copy
	 * is pinned to the commit its serving host checked. See pin-commit.ts.
	 */
	pinCommit?: string | null;
}
export const cloneGithubRepository = async ({
	type = "application",
	...entity
}: CloneGithubRepository) => {
	let command = "set -e;";
	const isCompose = type === "compose";
	const {
		appName,
		repository,
		owner,
		branch,
		headRef,
		githubId,
		enableSubmodules,
		serverId,
		outputPathOverride,
		pinCommit,
	} = entity;
	const { APPLICATIONS_PATH, COMPOSE_PATH } = paths(!!serverId);

	if (!githubId) {
		command += `echo "Error: ❌ Github Provider not found"; exit 1;`;

		return command;
	}

	const requirements = getErrorCloneRequirements(entity);

	// Check if requirements are met
	if (requirements.length > 0) {
		command += `echo "GitHub Repository configuration failed for application: ${appName}"; echo "Reasons:"; echo "${requirements.join("\n")}"; exit 1;`;
		return command;
	}

	const githubProvider = await findGithubById(githubId);
	// The stored host is checked before the token is minted and before anything
	// is cloned from it (a clone runs under git, outside the pinned fetch).
	await assertGithubInstanceReachable(githubProvider.githubUrl ?? "");
	const basePath = isCompose ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = outputPathOverride ?? join(basePath, appName, "code");
	const octokit = authGithub(githubProvider);
	const token = await getGithubToken(octokit);
	const cloneBase = new URL(normalizeGithubUrl(githubProvider.githubUrl));
	const repoclone = `${cloneBase.host}/${owner}/${repository}.git`;
	command += GIT_ALLOW_PROTOCOL_ENV;
	command += `rm -rf ${outputPath};`;
	command += `mkdir -p ${outputPath};`;
	const cloneUrl = `${cloneBase.protocol}//${repoclone}`;
	// Git does not follow a redirect from an Enterprise host to another one.
	const authConfig = `${isPublicGithubHost(cloneBase.hostname) ? "" : `${GIT_NO_REDIRECTS_CONFIG} `}${getGitTokenAuthConfig(cloneUrl, token)}`;
	const pin = pinCommit
		? buildPinCommitCommand({
				outputPath: String(outputPath ?? ""),
				commitSha: pinCommit,
				enableSubmodules,
				authConfig,
			})
		: "";

	command += `echo ${quote([`Cloning Repo ${repoclone} to ${outputPath}: ✅`])};`;
	if (headRef) {
		command += buildHeadRefCheckoutCommand({
			cloneUrl: String(cloneUrl ?? ""),
			branch: String(branch ?? ""),
			headRef,
			outputPath: String(outputPath ?? ""),
			enableSubmodules,
			authConfig,
		});
		return command + pin;
	}
	command += `git ${authConfig} clone --branch ${quote([String(branch ?? "")])} --depth 1 ${enableSubmodules ? "--recurse-submodules" : ""} ${quote([String(cloneUrl ?? "")])} ${quote([String(outputPath ?? "")])} --progress;`;
	command += pin;

	return command;
};

export const getGithubRepositories = async (githubId?: string) => {
	if (!githubId) {
		return [];
	}

	const githubProvider = await findGithubById(githubId);

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider.githubAppId,
			privateKey: githubProvider.githubPrivateKey,
			installationId: githubProvider.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider.githubUrl),
		...githubInstanceOptions(githubProvider.githubUrl),
	});

	const repositories = (await octokit.paginate(
		octokit.rest.apps.listReposAccessibleToInstallation,
	)) as unknown as Awaited<
		ReturnType<typeof octokit.rest.apps.listReposAccessibleToInstallation>
	>["data"]["repositories"];

	return repositories;
};

export const getGithubPullRequests = async (
	input: z.infer<typeof apiFindGithubPullRequests>,
): Promise<ChangeRequest[]> => {
	if (!input.githubId) {
		return [];
	}
	const githubProvider = await findGithubById(input.githubId);

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider.githubAppId,
			privateKey: githubProvider.githubPrivateKey,
			installationId: githubProvider.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider.githubUrl),
		...githubInstanceOptions(githubProvider.githubUrl),
	});

	const pullRequests = (await octokit.paginate(octokit.rest.pulls.list, {
		owner: input.owner,
		repo: input.repo,
		state: "open",
		sort: "updated",
		direction: "desc",
		per_page: 100,
	})) as unknown as Awaited<ReturnType<typeof octokit.rest.pulls.list>>["data"];

	return pullRequests.map((pr) => ({
		id: pr.id,
		number: pr.number,
		title: pr.title,
		url: pr.html_url,
		branch: pr.head?.ref ?? "",
		baseBranch: pr.base?.ref ?? "",
		draft: pr.draft ?? false,
		// The author drives the collaborator check on the manual build path, the
		// same way `pull_request.user.login` does for webhook-triggered previews.
		authorUsername: pr.user?.login ?? null,
		authorId: null,
	}));
};

export const getGithubBranches = async (
	input: z.infer<typeof apiFindGithubBranches>,
) => {
	if (!input.githubId) {
		return [];
	}
	const githubProvider = await findGithubById(input.githubId);

	const octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider.githubAppId,
			privateKey: githubProvider.githubPrivateKey,
			installationId: githubProvider.githubInstallationId,
		},
		baseUrl: deriveGithubApiUrl(githubProvider.githubUrl),
		...githubInstanceOptions(githubProvider.githubUrl),
	});

	const branches = (await octokit.paginate(octokit.rest.repos.listBranches, {
		owner: input.owner,
		repo: input.repo,
	})) as unknown as Awaited<
		ReturnType<typeof octokit.rest.repos.listBranches>
	>["data"];

	return branches;
};
