/**
 * Ordering and replay (acceptance rule 6). Pure.
 *
 * After a service is connected a release whose commit is an ancestor of the
 * deployed commit is refused (re-running an old run must not regress
 * production). Two releases of one commit: the higher run attempt wins, an
 * identical set of digests is a no-op, a lower attempt is refused, and between
 * different runs of one commit the later run wins.
 */

/** GitHub's compare status of `head` relative to `base`. */
export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface ReleaseStamp {
	sha: string;
	runId: number;
	attempt: number;
	/** Sorted digests of every image of the release. */
	digests: string[];
}

export type OrderingDecision =
	| { accept: true; noop: boolean }
	| {
			accept: false;
			code:
				| "not-on-branch"
				| "ordering-behind"
				| "ordering-lower-attempt"
				| "ordering-older-run";
			message: string;
	  };

const sameDigests = (a: string[], b: string[]) =>
	a.length === b.length && a.every((digest, index) => digest === b[index]);

export const decideOrdering = (input: {
	deployed: ReleaseStamp | null;
	candidate: ReleaseStamp;
	/** compare(deployed.sha ... candidate.sha); null when there is no deployed commit or the commits are equal. */
	deployedToCandidate: CompareStatus | null;
	/** The candidate commit is an ancestor of (or equal to) the tracked branch head. */
	reachableFromBranch: boolean;
	/** True only for an explicit rollback. */
	allowBehind: boolean;
}): OrderingDecision => {
	const { deployed, candidate } = input;
	if (!input.reachableFromBranch) {
		return {
			accept: false,
			code: "not-on-branch",
			message: "The release commit is not on the tracked branch",
		};
	}
	if (!deployed) return { accept: true, noop: false };

	if (deployed.sha === candidate.sha) {
		const noop = sameDigests(deployed.digests, candidate.digests);
		if (candidate.runId === deployed.runId) {
			if (candidate.attempt > deployed.attempt) return { accept: true, noop };
			if (candidate.attempt === deployed.attempt && noop) {
				return { accept: true, noop: true };
			}
			return {
				accept: false,
				code: "ordering-lower-attempt",
				message: "A later attempt of this run was already released",
			};
		}
		if (candidate.runId > deployed.runId) return { accept: true, noop };
		return {
			accept: false,
			code: "ordering-older-run",
			message: "A later run of this commit was already released",
		};
	}

	if (input.deployedToCandidate === null) {
		throw new Error("decideOrdering needs the compare status for two commits");
	}
	if (
		input.deployedToCandidate === "behind" ||
		input.deployedToCandidate === "identical"
	) {
		if (input.allowBehind) return { accept: true, noop: false };
		return {
			accept: false,
			code: "ordering-behind",
			message: "The release commit is older than the deployed commit",
		};
	}
	// ahead: the normal case. diverged: the deployed commit left the branch
	// (a force push); the candidate is on the branch, so it recovers the service.
	return { accept: true, noop: false };
};
