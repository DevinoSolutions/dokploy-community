import type { ApiResult, RepositoryInfo } from "./actions-api";
import type { EnvironmentPolicy } from "./environment-policy";
import { evaluateEnvironmentPolicy } from "./environment-policy";
import { type PreviousSource, snapshotPreviousSource } from "./flip";
import { GHA_SOURCE_TYPE, isGhaSourceType } from "./provider";

/**
 * Connect: every check that has to pass before a service starts following
 * GitHub Actions releases, and the one change made at that moment (git
 * autodeploy off, the old source kept). Pure over injected reads; the router
 * supplies the reads and applies the result.
 */

export type ConnectCode =
	| "scope"
	| "service"
	| "repository"
	| "branch"
	| "environment"
	| "mode"
	| "registry"
	| "github";

export type ConnectRefusal = { ok: false; code: ConnectCode; message: string };

export interface ConnectRequest {
	owner: string;
	repo: string;
	trackedBranch: string;
	environment: string;
	protectionMode: "environment" | "repository-secret";
	/** Where mirrored images live (host[:port][/path]); null = public GHCR images only. */
	registryPrefix: string | null;
}

export type ServiceFacts =
	| {
			kind: "application";
			sourceType: string | null;
			/** Settings of a GitHub-sourced application. */
			owner: string | null;
			repository: string | null;
			fields: Record<string, unknown>;
	  }
	| { kind: "compose"; sourceType: string | null };

export interface ConnectReads {
	repository(): Promise<ApiResult<RepositoryInfo>>;
	branchHead(branch: string): Promise<ApiResult<{ sha: string }>>;
	environmentPolicy(environment: string): Promise<ApiResult<EnvironmentPolicy>>;
}

export interface ConnectPlan {
	ok: true;
	repoId: number;
	repoFullName: string;
	/** Head of the tracked branch at Connect: the commit the first release should carry. */
	expectedSha: string;
	/** What the service was before it became a github-actions one, so Disconnect can put it back. */
	previousSource: PreviousSource | null;
	/**
	 * The change made at Connect (T-13879): the service gets the github-actions source type. Git settings are left
	 * untouched, and git autodeploy is turned off for an application, so only one thing deploys it.
	 */
	serviceUpdate: { sourceType: typeof GHA_SOURCE_TYPE; autoDeploy?: false };
}

const refuse = (code: ConnectCode, message: string): ConnectRefusal => ({
	ok: false,
	code,
	message,
});

const same = (a: string | null, b: string) =>
	a !== null && a.toLowerCase() === b.toLowerCase();

const failure = (
	result: Exclude<ApiResult<unknown>, { kind: "ok" }>,
	what: string,
): ConnectRefusal => {
	switch (result.kind) {
		case "unauthorized":
			return refuse(
				"github",
				"GitHub rejected the connection. Reconnect GitHub and try again.",
			);
		case "forbidden":
			return refuse(
				"github",
				`GitHub refused to show ${what}: ${result.message}`,
			);
		case "rate-limited":
			return refuse(
				"github",
				"GitHub rate limit reached. Try again in a few minutes.",
			);
		case "not-found":
			return refuse(
				"github",
				`${what} was not found, or the connected GitHub account cannot see it.`,
			);
		case "not-modified":
			return refuse("github", `GitHub gave no ${what} to read. Try again.`);
		default:
			return refuse(
				"github",
				`GitHub could not be reached (status ${result.status}). Try again.`,
			);
	}
};

export const scopeProblem = (
	scopes: readonly string[],
	isPrivate: boolean,
): string | null => {
	if (!scopes.includes("repo_deployment")) {
		return "The GitHub connection lacks the repo_deployment scope. Reconnect GitHub.";
	}
	const canRead =
		scopes.includes("repo") || (!isPrivate && scopes.includes("public_repo"));
	if (canRead) return null;
	return isPrivate
		? "This repository is private, and the GitHub connection lacks the repo scope. Reconnect GitHub and approve repository access."
		: "The GitHub connection lacks the public_repo scope. Reconnect GitHub.";
};

export const planConnect = async (
	input: {
		scopes: readonly string[];
		service: ServiceFacts;
		request: ConnectRequest;
	},
	reads: ConnectReads,
): Promise<ConnectPlan | ConnectRefusal> => {
	const { service, request } = input;

	if (request.protectionMode !== "environment") {
		return refuse(
			"mode",
			"Only environment protection is available now. Create the GitHub environment and limit its deployment branches to the tracked branch.",
		);
	}

	if (
		request.registryPrefix !== null &&
		service.kind === "application" &&
		service.sourceType === "github"
	) {
		return refuse(
			"registry",
			"An application built from git can move only to a public GHCR image for now. To use a private registry, give it a Docker image source with that registry first, then connect it.",
		);
	}

	if (
		service.kind === "compose" &&
		service.sourceType !== "raw" &&
		!isGhaSourceType(service.sourceType)
	) {
		return refuse(
			"service",
			"Only compose stacks whose file is stored in Dokploy can follow GitHub Actions releases for now.",
		);
	}
	if (service.kind === "application") {
		if (
			service.sourceType !== "github" &&
			service.sourceType !== "docker" &&
			!isGhaSourceType(service.sourceType)
		) {
			return refuse(
				"service",
				"Only applications built from GitHub, or running a Docker image, can follow GitHub Actions releases for now.",
			);
		}
		if (
			service.sourceType === "github" &&
			!(
				same(service.owner, request.owner) &&
				same(service.repository, request.repo)
			)
		) {
			return refuse(
				"repository",
				`This application builds from ${service.owner ?? "?"}/${service.repository ?? "?"}, not ${request.owner}/${request.repo}.`,
			);
		}
	}

	const repository = await reads.repository();
	if (repository.kind !== "ok") {
		const refusal = failure(
			repository,
			`The repository ${request.owner}/${request.repo}`,
		);
		// GitHub answers 404 for a private repository a token cannot see.
		if (repository.kind === "not-found" && !input.scopes.includes("repo")) {
			return {
				...refusal,
				message: `${refusal.message} If it is a private repository, reconnect GitHub with private repository access (the repo scope).`,
			};
		}
		return refusal;
	}
	const problem = scopeProblem(input.scopes, repository.value.isPrivate);
	if (problem) return refuse("scope", problem);

	const head = await reads.branchHead(request.trackedBranch);
	if (head.kind === "not-found") {
		return refuse(
			"branch",
			`Branch ${request.trackedBranch} does not exist in ${repository.value.fullName}.`,
		);
	}
	if (head.kind !== "ok")
		return failure(head, `Branch ${request.trackedBranch}`);

	const policy = await reads.environmentPolicy(request.environment);
	if (policy.kind === "not-found") {
		return refuse(
			"environment",
			`Create the GitHub environment ${request.environment} in ${repository.value.fullName}, set Deployment branches to ${request.trackedBranch} only, and add the build secrets there.`,
		);
	}
	if (policy.kind !== "ok") {
		return failure(policy, `The environment ${request.environment}`);
	}
	const checked = evaluateEnvironmentPolicy(
		policy.value,
		request.trackedBranch,
	);
	if (!checked.ok) {
		return refuse(
			"environment",
			`${checked.message}. Change the environment ${request.environment}, then connect again.`,
		);
	}

	// A service already marked github-actions without a connection (an orphan) has nothing to go back to.
	const orphan = isGhaSourceType(service.sourceType);
	let previousSource: PreviousSource | null = null;
	if (!orphan) {
		previousSource =
			service.kind === "application"
				? snapshotPreviousSource({
						...service.fields,
						sourceType: service.sourceType,
					})
				: { sourceType: service.sourceType };
	}
	return {
		ok: true,
		repoId: repository.value.id,
		repoFullName: repository.value.fullName,
		expectedSha: head.value.sha,
		previousSource,
		serviceUpdate:
			service.kind === "application"
				? { sourceType: GHA_SOURCE_TYPE, autoDeploy: false }
				: { sourceType: GHA_SOURCE_TYPE },
	};
};
