/**
 * Acceptance rule 5: the GitHub Environment that holds the registry
 * credential must still allow deployments from the tracked branch ONLY.
 * Pure: the caller reads the environment and its branch policies.
 */

export interface EnvironmentPolicy {
	/** `deployment_branch_policy.custom_branch_policies`; false when the policy is null. */
	customBranchPolicies: boolean;
	protectedBranches: boolean;
	policies: Array<{ name: string; type: string }>;
}

export type PolicyCheck = { ok: true } | { ok: false; message: string };

export const evaluateEnvironmentPolicy = (
	policy: EnvironmentPolicy,
	trackedBranch: string,
): PolicyCheck => {
	if (!policy.customBranchPolicies) {
		return {
			ok: false,
			message: policy.protectedBranches
				? "The environment allows every protected branch, not only the tracked branch"
				: "The environment allows every branch",
		};
	}
	const [only, ...rest] = policy.policies;
	if (!only || rest.length > 0) {
		return {
			ok: false,
			message:
				"The environment must allow exactly one deployment branch, the tracked branch",
		};
	}
	if (only.type !== "branch" || only.name !== trackedBranch) {
		return {
			ok: false,
			message: `The environment allows ${only.name} (${only.type}), not only ${trackedBranch}`,
		};
	}
	return { ok: true };
};
