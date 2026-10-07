import { quote } from "shell-quote";

/**
 * The pull/merge-request head ref a preview deployment has to check out,
 * derived from the git provider and the preview row's stored PR number.
 *
 * Every preview row is created from a real pull/merge request (webhook or the
 * "Build Preview" dialog), and all three supported providers publish the PR
 * head on the *base* repository under a well-known ref:
 *
 * - GitHub / Gitea/Forgejo: `refs/pull/<n>/head`
 * - GitLab: `refs/merge-requests/<iid>/head`
 *
 * Checking out that ref instead of `branch` is what makes previews work for
 * pull requests opened from a fork: the head branch only exists in the fork,
 * but the base repository always advertises the PR head ref, so the clone can
 * reuse the configured provider credentials. It also removes the ambiguity of
 * a head branch whose name collides with a branch in the base repository.
 *
 * Returns `null` for providers without such a ref (bitbucket, plain git) —
 * callers then fall back to cloning `branch` directly.
 */
export const buildPreviewHeadRef = (
	sourceType: string | null | undefined,
	pullRequestNumber: string | null | undefined,
): string | null => {
	if (!pullRequestNumber) {
		return null;
	}

	if (sourceType === "github" || sourceType === "gitea") {
		return `refs/pull/${pullRequestNumber}/head`;
	}

	if (sourceType === "gitlab") {
		return `refs/merge-requests/${pullRequestNumber}/head`;
	}

	return null;
};

/**
 * Shell sequence that checks `headRef` out of the *base* repository
 * (`cloneUrl`, credentials already embedded) into an existing empty
 * `outputPath` — the shallow-clone equivalent of `git clone --branch <branch>`.
 *
 * The PR head ref is fetched first, with a fallback to `branch` so a server
 * that does not advertise the ref (or a row whose stored PR number is not a
 * real PR) keeps the pre-existing branch-clone behaviour instead of failing.
 * Callers must have already emitted `rm -rf`/`mkdir -p` for `outputPath` and
 * run under `set -e`; if both fetches fail the command aborts before checkout.
 */
export const buildHeadRefCheckoutCommand = ({
	cloneUrl,
	branch,
	headRef,
	outputPath,
	enableSubmodules,
}: {
	cloneUrl: string;
	branch: string;
	headRef: string;
	outputPath: string;
	enableSubmodules: boolean;
}): string => {
	const dir = quote([outputPath]);
	let command = "";

	command += `echo ${quote([`Checking out ${headRef} into ${outputPath}: ✅`])};`;
	command += `git init -q ${dir};`;
	command += `git -C ${dir} remote add origin ${quote([cloneUrl])};`;
	command += `git -C ${dir} fetch --progress --depth 1 origin ${quote([headRef])} || git -C ${dir} fetch --progress --depth 1 origin ${quote([branch])};`;
	command += `git -C ${dir} checkout -q FETCH_HEAD;`;

	if (enableSubmodules) {
		command += `git -C ${dir} submodule update --init --recursive;`;
	}

	return command;
};
