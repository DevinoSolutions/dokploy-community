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
	`'${value.replaceAll("'", "'\\''")}'`;

/**
 * Names that must not be sourced into the environment of a build tool. Setting
 * them changes how the tool itself runs rather than what it builds (`PATH`,
 * `HOME`, `DOCKER_HOST`, `LD_PRELOAD`, proxies, git's and pack's own settings such
 * as `GIT_SSH_COMMAND` and `PACK_HOME`, Go runtime and libc tunables, ...), or is
 * read-only in some `sh` (`UID`, `PPID`), which would fail the build. A build
 * argument with one of these names keeps being passed on the command line, as it
 * always was.
 */
const ENV_FILE_RESERVED_NAMES = new Set([
	"BASHOPTS",
	"BASHPID",
	"BASH_ENV",
	"CDPATH",
	"CONTAINER_HOST",
	"EGID",
	"ENV",
	"EUID",
	"GID",
	"GIT_ALLOW_PROTOCOL",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_ASKPASS",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_SYSTEM",
	"GIT_CURL_VERBOSE",
	"GIT_DIR",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_EDITOR",
	"GIT_EXEC_PATH",
	"GIT_EXTERNAL_DIFF",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_OBJECT_DIRECTORY",
	"GIT_OPTIONAL_LOCKS",
	"GIT_PAGER",
	"GIT_PROTOCOL_FROM_USER",
	"GIT_PROXY_COMMAND",
	"GIT_QUARANTINE_PATH",
	"GIT_REDACT_COOKIES",
	"GIT_REPLACE_REF_BASE",
	"GIT_SEQUENCE_EDITOR",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
	"GIT_SSH_VARIANT",
	"GIT_TEMPLATE_DIR",
	"GIT_TERMINAL_PROMPT",
	"GIT_WORK_TREE",
	"GLIBC_TUNABLES",
	"GLOBIGNORE",
	"GODEBUG",
	"GOGC",
	"GOMAXPROCS",
	"GOMEMLIMIT",
	"GOTRACEBACK",
	"GROUPS",
	"HISTFILE",
	"HOME",
	"HOSTALIASES",
	"IFS",
	"LANG",
	"LOCPATH",
	"LOGNAME",
	"MALLOC_ARENA_MAX",
	"NLSPATH",
	"OLDPWD",
	"OPTARG",
	"OPTIND",
	"PACK_HOME",
	"PACK_VOLUME_KEY",
	"PATH",
	"PPID",
	"PS1",
	"PS2",
	"PS4",
	"PWD",
	"RANDOM",
	"REGISTRY_AUTH_FILE",
	"RES_OPTIONS",
	"SECONDS",
	"SHELL",
	"SHELLOPTS",
	"SHLVL",
	"SSH_ASKPASS",
	"SSH_AUTH_SOCK",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"TERM",
	"TMPDIR",
	"TZ",
	"UID",
	"USER",
	"_",
]);

const ENV_FILE_RESERVED_PREFIXES = [
	"__dokploy",
	"BASH_",
	"BUILDKIT_",
	"BUILDX_",
	"DOCKER_",
	"GIT_CONFIG_KEY_",
	"GIT_CONFIG_VALUE_",
	"GIT_HTTP_",
	"GIT_SSL_",
	"GIT_TRACE",
	"LC_",
	"LD_",
	"XDG_",
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
 *
 * `consume` removes the file right after it is sourced, for a command that
 * runs the loader once: the secrets are then on disk only for the instant it
 * takes to read them, not for the whole build.
 */
export const getEnvFileLoader = (
	stagedPath: string,
	{ consume = false }: { consume?: boolean } = {},
) =>
	`sh -c '__dokploy_bin=$(command -v "$2") || exit 1; set -a; . "$1" || exit 1; set +a;${consume ? ' rm -f -- "$1";' : ""} shift 2; exec "$__dokploy_bin" "$@"' sh ${quote([stagedPath])}`;
