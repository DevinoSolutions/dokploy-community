import { authGithub } from "@dokploy/server/utils/providers/github";
import { findGithubById } from "../github";
import { recordBuildPolicyAudit } from "./audit";
import { BuildPolicyError } from "./errors";
import type { BuildPolicyUnitType } from "./policy";
import {
	type CheckRunLike,
	waitForRequiredChecks,
} from "./required-checks";
import { parseGithubOwnerRepo } from "./source";

/**
 * Per-unit `requiredChecks` gating, wired to the GitHub App installation token
 * the fork already holds. Empty list (the default) is a no-op.
 *
 * Fails closed: if the checks cannot be read, the deploy stops rather than
 * proceeding as though they had passed.
 */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RequiredChecksUnit {
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName: string;
	organizationId: string;
	requiredChecks: string[] | null | undefined;
	sourceType: string;
	githubId?: string | null;
	owner?: string | null;
	repository?: string | null;
	customGitUrl?: string | null;
}

const resolveOwnerRepo = (
	unit: RequiredChecksUnit,
): { owner: string; repo: string } => {
	if (unit.sourceType === "github" && unit.owner && unit.repository) {
		return { owner: unit.owner, repo: unit.repository };
	}
	const parsed = parseGithubOwnerRepo(unit.customGitUrl);
	if (parsed) return parsed;
	throw new BuildPolicyError(
		"REQUIRED_CHECKS_UNAVAILABLE",
		`Required checks are configured on "${unit.unitName}" but its repository ` +
			"could not be determined, so they cannot be verified.",
	);
};

export const waitForUnitRequiredChecks = async ({
	unit,
	sha,
	timeoutMs,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	listCheckRunsOverride,
	sleepOverride,
	nowOverride,
}: {
	unit: RequiredChecksUnit;
	sha: string | null | undefined;
	timeoutMs: number;
	pollIntervalMs?: number;
	/** Test seams; production passes none of these. */
	listCheckRunsOverride?: () => Promise<CheckRunLike[]>;
	sleepOverride?: (ms: number) => Promise<void> | void;
	nowOverride?: () => number;
}): Promise<void> => {
	const requiredChecks = (unit.requiredChecks ?? []).filter(
		(name): name is string => typeof name === "string" && name.length > 0,
	);
	if (requiredChecks.length === 0) return;

	if (!sha) {
		throw new BuildPolicyError(
			"REQUIRED_CHECKS_UNAVAILABLE",
			`Required checks are configured on "${unit.unitName}" but this deploy ` +
				"carries no commit sha to check against.",
		);
	}

	const { owner, repo } = resolveOwnerRepo(unit);

	const listCheckRuns =
		listCheckRunsOverride ??
		(async (): Promise<CheckRunLike[]> => {
			if (!unit.githubId) {
				throw new BuildPolicyError(
					"REQUIRED_CHECKS_UNAVAILABLE",
					`Required checks are configured on "${unit.unitName}" but it is not ` +
						"connected to a GitHub App provider, so they cannot be verified.",
				);
			}
			const provider = await findGithubById(unit.githubId);
			const octokit = authGithub(provider);
			const { data } = await octokit.rest.checks.listForRef({
				owner,
				repo,
				ref: sha,
				per_page: 100,
			});
			return (data.check_runs ?? []).map((run) => ({
				name: run.name,
				status: run.status,
				conclusion: run.conclusion ?? null,
			}));
		});

	try {
		await waitForRequiredChecks({
			requiredChecks,
			owner,
			repo,
			sha,
			timeoutMs,
			pollIntervalMs,
			listCheckRuns,
			sleep: sleepOverride ?? sleep,
			now: nowOverride ?? Date.now,
		});
	} catch (error) {
		const code =
			error instanceof BuildPolicyError ? error.code : "REQUIRED_CHECKS_FAILED";
		await recordBuildPolicyAudit({
			organizationId: unit.organizationId,
			action:
				code === "REQUIRED_CHECKS_TIMEOUT"
					? "required_checks_timeout"
					: "required_checks_failed",
			applicationId: unit.unitType === "application" ? unit.unitId : null,
			composeId: unit.unitType === "compose" ? unit.unitId : null,
			reason: error instanceof Error ? error.message : String(error),
			metadata: { owner, repo, sha, requiredChecks },
		});
		throw error;
	}
};
