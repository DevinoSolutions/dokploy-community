import { TRPCError } from "@trpc/server";

/**
 * The repository URL of a custom git source (and of the compose template
 * clone) is typed by the user. Git accepts much more than a remote repository
 * there: `file://` and local paths clone a directory of the host that runs the
 * clone, and transport helpers (`ext::`) or a value read as an option run
 * commands. Only a remote repository is cloned.
 */

export const GIT_URL_REFUSED_MESSAGE =
	"This git URL is not allowed; use an http(s), ssh, or user@host:path URL";

/**
 * Put before every clone of a user-supplied URL, in the same shell: git is
 * limited to remote protocols, submodules (whose URLs the repository chooses)
 * included. An SSH-key clone keeps working: it uses the `ssh` protocol.
 */
export const GIT_ALLOW_PROTOCOL_ENV =
	"export GIT_ALLOW_PROTOCOL=https:http:ssh;";

export class GitUrlRefusedError extends Error {
	constructor(message = GIT_URL_REFUSED_MESSAGE) {
		super(message);
		this.name = "GitUrlRefusedError";
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
const UNSAFE_URL_CHARACTER = /[\u0000- \u007f\\]/;
const URL_WITH_AUTHORITY = /^(https?|ssh):\/\/([^/?#]*)/i;
// `user@` and then `host:path`, the host a bracketed IPv6 address or not.
const SCP_ADDRESS = /^([^@/:]+)@(\[[^\]/]*\]|[^:/\]]+):/;
// A user name that starts with `-` could be read as an option.
const URL_USER = /^[A-Za-z0-9._-]+$/;
// A host name, or an IPv6 address in brackets (with an optional zone).
const URL_HOST =
	/^(\[[0-9A-Fa-f:.]+(%25[\w.~-]+)?\]|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
// A port after the host, or none.
const URL_PORT = /^(:[0-9]*)?$/;

const isSafeHost = (host: string) => URL_HOST.test(host);

/** Whether `authority` (`[user[:password]@]host[:port]`) names a safe host. */
const isSafeAuthority = (authority: string) => {
	if (authority.startsWith("-")) return false;
	const at = authority.lastIndexOf("@");
	const userinfo = at === -1 ? "" : authority.slice(0, at);
	if (userinfo.startsWith("-")) return false;
	const hostPort = authority.slice(at + 1);
	const bracketEnd = hostPort.startsWith("[") ? hostPort.indexOf("]") + 1 : 0;
	const hostEnd =
		bracketEnd > 0
			? bracketEnd
			: hostPort.indexOf(":") === -1
				? hostPort.length
				: hostPort.indexOf(":");
	return (
		isSafeHost(hostPort.slice(0, hostEnd)) &&
		URL_PORT.test(hostPort.slice(hostEnd))
	);
};

/**
 * Only a remote repository is cloned: http(s), `ssh://` or an SSH address
 * with a user (`git@host:owner/repo.git`). The host must be a host name
 * (letters, digits, `.`, `_`, `-`, starting with a letter or digit) or a
 * bracketed IPv6 address, and neither the authority nor the user name may
 * start with `-`. A `file://` URL, a local path, a transport helper (`ext::`,
 * `fd::`: no form above matches them) or a value git would read as an option
 * is refused.
 */
export const assertSafeGitUrl = (url: string | null | undefined) => {
	const value = url ?? "";
	const authority = URL_WITH_AUTHORITY.exec(value)?.[2];
	const scp = authority === undefined ? SCP_ADDRESS.exec(value) : null;
	const safe =
		authority !== undefined
			? isSafeAuthority(authority)
			: scp !== null &&
				URL_USER.test(scp[1] ?? "") &&
				!(scp[1] ?? "").startsWith("-") &&
				isSafeHost(scp[2] ?? "");
	if (!value || UNSAFE_URL_CHARACTER.test(value) || !safe) {
		throw new GitUrlRefusedError();
	}
};

export const isSafeGitUrl = (url: string | null | undefined) => {
	try {
		assertSafeGitUrl(url);
		return true;
	} catch {
		return false;
	}
};

/**
 * Save-time rule for `customGitUrl` in an update: checked only when the input
 * carries a non-empty value that differs from the stored one. A row that holds
 * a URL which is no longer allowed stays visible and editable, a save of an
 * unrelated field (or of the same value) does not fail for it, and the deploy
 * refuses it with the message above. Clearing the value is always allowed.
 */
export const assertGitUrlSaveable = (
	next: string | null | undefined,
	current: string | null | undefined,
) => {
	if (typeof next !== "string" || next === "" || next === current) return;
	try {
		assertSafeGitUrl(next);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : GIT_URL_REFUSED_MESSAGE,
		});
	}
};
