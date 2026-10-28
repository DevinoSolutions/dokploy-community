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

/**
 * The variable a build secret's value travels in when its own name is not one
 * the env file may carry (`isEnvFileName`): the secret keeps its id and docker
 * reads the value from this name (`--secret id=KEY,env=...`). No shell or tool
 * reads `__dokploy_*` names, and a user's name never has that prefix in the
 * file (T-8282).
 */
export const getBuildSecretAlias = (index: number) =>
	`__dokploy_secret_${index}`;

/**
 * Names of the reserved set that a stack's staged environment may still carry:
 * they change how a program formats text (locale, time zone, the user's name),
 * not what it loads or whom it talks to, and compose files interpolate them
 * (`TZ: ${TZ}`). The proxy variables are let through for the same reason.
 */
const STACK_ENV_INERT_NAMES = new Set(["LANG", "LOGNAME", "TZ", "USER"]);

/**
 * Whether `name` may be in the environment of the docker process a stack deploy
 * runs, which is also the whole of what `docker stack deploy` interpolates from.
 *
 * `docker` and `docker compose` read their own settings from the environment:
 * `DOCKER_HOST` and `DOCKER_CONTEXT` pick the daemon, `DOCKER_CONFIG` the
 * directory the CLI loads `cli-plugins/` (host binaries) and credentials from,
 * `COMPOSE_*` what compose reads. The shell that loads the file also resolves
 * `docker` after sourcing it, so `PATH`, `HOME` and the loader variables
 * (`LD_*`) would choose the program and what it loads. Those names are left
 * out, matched exactly as the programs read them: environment names are
 * case-sensitive on Linux, so `docker_host` is an ordinary variable. The set
 * is that of `isEnvFileName` (minus the inert names above) and every `COMPOSE_*`.
 */
export const isStackEnvName = (name: string) =>
	ENV_VARIABLE_NAME.test(name) &&
	!name.startsWith("COMPOSE_") &&
	(isEnvFileName(name) ||
		STACK_ENV_INERT_NAMES.has(name) ||
		name.startsWith("LC_") ||
		ENV_FILE_RESERVED_PROXY_NAME.test(name));

/**
 * `COMPOSE_*` settings that compose may read from a `.env` and that only tune
 * how it runs a project it already loaded: the profiles to start, parallelism,
 * orphan handling, progress output. `COMPOSE_PREFIX` is Dokploy's own variable
 * for a randomized compose, not a compose setting.
 */
const COMPOSE_DOTENV_NAMES = new Set([
	"COMPOSE_ANSI",
	"COMPOSE_BAKE",
	"COMPOSE_IGNORE_ORPHANS",
	"COMPOSE_MENU",
	"COMPOSE_PARALLEL_LIMIT",
	"COMPOSE_PREFIX",
	"COMPOSE_PROFILES",
	"COMPOSE_PROGRESS",
	"COMPOSE_REMOVE_ORPHANS",
	"COMPOSE_STATUS_STDOUT",
]);

/**
 * Settings of docker and its children that the docker process of a deploy gets
 * as an empty value (`env -i ... NAME= docker`, see `NEUTRALISED_CLI_ENV`).
 * Docker treats an empty one as unset (DOCKER_HOST, DOCKER_CONTEXT, DOCKER_TLS,
 * DOCKER_TLS_VERIFY and DOCKER_CERT_PATH are only used when non-empty, an empty
 * DOCKER_CONFIG falls back to `$HOME/.docker`, an empty DOCKER_API_VERSION
 * negotiates), and the loader ignores an empty LD_*, BASH_ENV, ENV and
 * GCONV_PATH. Compose before v2.39.3 copies every key of a `.env` into its own
 * environment unless the process environment already has it, empty or not
 * (`setEnvWithDotEnv`: `if _, ok := os.LookupEnv(k); !ok { os.Setenv(k, v) }`,
 * cmd/compose/compose.go at v2.39.2), and the children it starts (credential
 * helpers, buildx) inherit them; with the names set here a `.env` cannot
 * supply them. v2.39.3 only copies `COMPOSE_*`.
 */
export const NEUTRALISED_CLI_ENV_NAMES = [
	"BASH_ENV",
	"DOCKER_API_VERSION",
	"DOCKER_CERT_PATH",
	"DOCKER_CONFIG",
	"DOCKER_CONTEXT",
	"DOCKER_HOST",
	"DOCKER_TLS",
	"DOCKER_TLS_VERIFY",
	"ENV",
	"GCONV_PATH",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
];

/** `NAME=` assignments for `env -i`, placed before every docker or compose command. */
export const NEUTRALISED_CLI_ENV = NEUTRALISED_CLI_ENV_NAMES.map(
	(name) => `${name}=`,
).join(" ");

const NEUTRALISED_CLI_ENV_SET = new Set(NEUTRALISED_CLI_ENV_NAMES);

/**
 * Whether a user's variable may be written to the `.env` Dokploy creates for a
 * compose. Compose copies every `COMPOSE_*` it finds in a `.env` into its own
 * environment, where it steers the CLI like the real variable does
 * (`COMPOSE_FILE`, `COMPOSE_ENV_FILES`, `COMPOSE_PROJECT_NAME`,
 * `COMPOSE_PATH_SEPARATOR`, ...), so only the tuning settings above get
 * through. Before compose v2.39.3 it copies the other keys too, so a name that
 * docker, its loader or buildx read as a setting is left out unless the docker
 * process already has it empty (`NEUTRALISED_CLI_ENV`): `DOCKER_HOST`,
 * `DOCKER_CONFIG` and the rest of that list stay for interpolation and for
 * services that read them through `env_file`. Other `DOCKER_*` names are not
 * settings that aim the CLI or load code and stay as well.
 */
export const isComposeDotenvName = (name: string) => {
	if (name.startsWith("COMPOSE_")) return COMPOSE_DOTENV_NAMES.has(name);
	if (!ENV_VARIABLE_NAME.test(name)) return true;
	if (name.startsWith("DOCKER_") || NEUTRALISED_CLI_ENV_SET.has(name)) {
		return true;
	}
	return isStackEnvName(name);
};

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
