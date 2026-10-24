import { quote } from "shell-quote";

/** A full SHA-1 commit id, the only form a pin accepts. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const isCommitSha = (value: unknown): value is string =>
	typeof value === "string" && COMMIT_SHA_PATTERN.test(value);

/**
 * HEAD as a commit object. A bare `HEAD` resolves to whatever id `.git/HEAD`
 * holds, even one whose object the repository does not have; `HEAD^{commit}`
 * only resolves to a commit that is really there.
 */
const HEAD_COMMIT = quote(["HEAD^{commit}"]);

/**
 * Files in a `.git` that make it take objects or refs from another
 * repository. A provider clone never writes any of them.
 */
const BORROWED_GIT_STATE = [
	"commondir",
	"objects/info/alternates",
	"objects/info/http-alternates",
];

/**
 * True when `codePath` is the top level of a checkout of its own: its `.git`
 * is a real directory (not a link to another repository's) whose object
 * store is its own (no `commondir`, no alternates, no linked `objects`), and
 * git reports the relative `.git` as the git dir (a plain `git -C` walks up
 * into any ancestor repository).
 */
export const getOwnCheckoutTest = (codePath: string) => {
	const dir = quote([codePath]);
	const gitDir = quote([`${codePath}/.git`]);
	const objects = quote([`${codePath}/.git/objects`]);
	const borrowed = BORROWED_GIT_STATE.map((name) => {
		const path = quote([`${codePath}/.git/${name}`]);
		return `[ ! -e ${path} ] && [ ! -L ${path} ]`;
	}).join(" && ");
	return `[ -d ${gitDir} ] && [ ! -L ${gitDir} ] && [ ! -L ${objects} ] && ${borrowed} && [ "$(git -C ${dir} rev-parse --git-dir 2>/dev/null)" = .git ]`;
};

/** Shell expression for the commit checked out at `codePath`. */
export const getHeadCommitExpression = (codePath: string) =>
	`$(git -C ${quote([codePath])} rev-parse --verify -q ${HEAD_COMMIT} 2>/dev/null)`;

/**
 * Prints the commit checked out at `codePath`, or nothing when `codePath` is
 * not a checkout of its own (see `getOwnCheckoutTest`) or its HEAD is not a
 * commit the repository holds.
 */
export const getCheckedOutCommitCommand = (codePath: string) =>
	`if ${getOwnCheckoutTest(codePath)}; then git -C ${quote([codePath])} rev-parse --verify -q ${HEAD_COMMIT} 2>/dev/null || true; fi`;

/**
 * What a commit read reports when the command itself could not run (an SSH
 * failure, say), so the refusal names that instead of a missing checkout.
 * Never a commit id.
 */
export const COMMIT_READ_FAILED = "dokploy-commit-read-failed";

/** The commit `getCheckedOutCommitCommand` printed, or null when it is not one. */
export const parseCheckedOutCommit = (stdout: string | undefined) => {
	const sha = (stdout ?? "").trim();
	return isCommitSha(sha) ? sha : null;
};

/**
 * Why `getCheckedOutCommitCommand`'s output gives no commit to pin, for the
 * message a refused build shows.
 */
export const describeUnreadableCommit = (stdout: string | undefined) => {
	const out = (stdout ?? "").trim();
	if (out === COMMIT_READ_FAILED) {
		return "the read could not run on the serving host (connection or command failure)";
	}
	if (/^[0-9a-f]{64}$/.test(out)) {
		return "the repository uses the SHA-256 object format, which a build-server build cannot pin yet";
	}
	return out
		? "it is not a full commit id"
		: "the code directory is not a git checkout of its own";
};

/**
 * Shell sequence, appended to a clone, that moves the checkout at `outputPath`
 * to exactly `commitSha` (T-7282). A build server clones the branch (or PR
 * head) tip once more after the serving host fetched and checked it; a push in
 * between would otherwise build a compose file nobody checked.
 *
 * When the tip still is `commitSha` nothing is fetched. Otherwise that one
 * commit is fetched from `origin` (with `authConfig` on every command that
 * talks to the remote, as in head-ref.ts) and checked out detached. What the
 * tip left behind and the pinned commit does not track (a submodule only the
 * tip has, say) is removed, the submodule URLs are taken from the pinned
 * commit's `.gitmodules` and the submodules moved to the commits it records.
 * The script exits non-zero when the checkout does not end on `commitSha`, so
 * an unpinned build never starts. Runs under the caller's `set -e`.
 */
export const buildPinCommitCommand = ({
	outputPath,
	commitSha,
	enableSubmodules,
	authConfig,
}: {
	outputPath: string;
	commitSha: string;
	enableSubmodules?: boolean;
	authConfig?: string;
}) => {
	if (!isCommitSha(commitSha)) {
		throw new Error("Refusing to pin the checkout to an invalid commit id");
	}
	const dir = quote([outputPath]);
	const sha = quote([commitSha]);
	const head = getHeadCommitExpression(outputPath);
	const git = authConfig ? `git ${authConfig}` : "git";
	let command = "";
	command += `if [ "${head}" != ${sha} ]; then `;
	command += `echo ${quote([`Checking out commit ${commitSha}, the one the serving host checked`])}; `;
	command += `if ! ${git} -C ${dir} fetch --progress --depth 1 origin -- ${sha}; then echo ${quote([`❌ [ERROR] Could not fetch commit ${commitSha} on the build server`])}; exit 1; fi; `;
	command += `git -C ${dir} checkout -q --detach ${sha}; `;
	// Double -f: also untracked nested repositories (a tip-only submodule).
	command += `git -C ${dir} clean -ffdxq; `;
	if (enableSubmodules) {
		command += `git -C ${dir} submodule sync -q --recursive; `;
		command += `${git} -C ${dir} submodule update --init --recursive; `;
		command += `git -C ${dir} submodule foreach -q --recursive git clean -ffdxq; `;
	}
	command += "fi; ";
	command += `if [ "${head}" != ${sha} ]; then echo ${quote([`❌ [ERROR] The build server checkout is not commit ${commitSha}`])}; exit 1; fi;`;
	return command;
};
