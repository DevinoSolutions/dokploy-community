import { quote } from "shell-quote";

/**
 * Environment variables handed to a command through a staged 0600 file instead
 * of its command line: the file holds `KEY='value'` lines, a loader sources it
 * with every assignment exported and then execs the command, which finds its
 * variables in its environment. No value is on any command line, so none shows
 * in the host's process list or counts toward the 128 KB limit on one shell
 * argument (see `staging.ts`).
 */

export const ENV_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single quotes: the only quoting that leaves `$`, backticks and newlines alone. */
export const singleQuote = (value: string) =>
	`'${value.replaceAll("'", "'\''")}'`;

/**
 * Names that must not be sourced into the environment of a build tool. Setting
 * them changes how the tool itself runs rather than what it builds (`PATH`,
 * `HOME`, `DOCKER_HOST`, `LD_PRELOAD`, proxies, ...), or is read-only in some
 * `sh` (`UID`, `PPID`), which would fail the build. A build argument with one of
 * these names keeps being passed on the command line, as it always was.
 */
const ENV_FILE_RESERVED_NAMES = new Set([
	"_",
	"BASH_ENV",
	"BASHOPTS",
	"BASHPID",
	"CDPATH",
	"EGID",
	"ENV",
	"EUID",
	"GID",
	"GLOBIGNORE",
	"GROUPS",
	"HISTFILE",
	"HOME",
	"IFS",
	"LANG",
	"LOGNAME",
	"OLDPWD",
	"OPTARG",
	"OPTIND",
	"PATH",
	"PPID",
	"PS1",
	"PS2",
	"PS4",
	"PWD",
	"RANDOM",
	"SECONDS",
	"SHELL",
	"SHELLOPTS",
	"SHLVL",
	"TERM",
	"TMPDIR",
	"TZ",
	"UID",
	"USER",
	"XDG_CONFIG_HOME",
	"XDG_RUNTIME_DIR",
]);

const ENV_FILE_RESERVED_PREFIXES = [
	"__dokploy",
	"BASH_",
	"BUILDKIT_",
	"BUILDX_",
	"DOCKER_",
	"LC_",
	"LD_",
	"SSH_",
	"SSL_",
];

const ENV_FILE_RESERVED_PROXY_NAME = /^(?:http|https|ftp|all|no)_proxy$/i;

/** Whether `name` can travel in an env file without changing how the tool runs. */
export const isEnvFileName = (name: string) =>
	ENV_VARIABLE_NAME.test(name) &&
	!ENV_FILE_RESERVED_NAMES.has(name) &&
	!ENV_FILE_RESERVED_PROXY_NAME.test(name) &&
	!ENV_FILE_RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

/** One `KEY='value'` per line, in the order given. Names are the caller's to vet. */
export const buildEnvFileContent = (entries: Iterable<[string, string]>) => {
	let content = "";
	for (const [key, value] of entries) {
		content += `${key}=${singleQuote(value)}\n`;
	}
	return content;
};

/**
 * Words that run the command following them with the staged file's variables in
 * its environment: `sh` sources the file with every assignment exported, then
 * `exec`s the command. Only the file's path is on the command line.
 *
 * The command is resolved before the file is sourced, so a file that sets
 * `PATH` cannot redirect it. `|| exit 1` keeps a missing or unreadable file
 * fatal on every `sh`, so the tool never runs without its variables.
 */
export const getEnvFileLoader = (stagedPath: string) =>
	`sh -c '__dokploy_bin=$(command -v "$2") || exit 1; set -a; . "$1" || exit 1; set +a; shift 2; exec "$__dokploy_bin" "$@"' sh ${quote([stagedPath])}`;
