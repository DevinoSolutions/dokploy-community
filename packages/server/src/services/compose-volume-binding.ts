import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { ComposeNested } from "@dokploy/server/utils/builders/compose";
import {
	assertComposeFileInsideCodeDirectory,
	COMPOSE_FILE_NOT_REGULAR_MARKER,
	COMPOSE_FILE_NOT_REGULAR_MESSAGE,
	ComposeFileLinkError,
	getComposeCodeDirectory,
	getComposeFileRefusal,
	getGuardedReadCommand,
	isComposeFileLinkError,
	isComposeFileLinkMarker,
} from "@dokploy/server/utils/compose-file-guard";
import { randomizeDeployableSpecificationFile } from "@dokploy/server/utils/docker/collision";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	addDomainToCompose,
	getComposePath,
	readComposeFile,
} from "@dokploy/server/utils/docker/domain";
import {
	isComposeDotenvName,
	isStackEnvName,
} from "@dokploy/server/utils/docker/env-file";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import {
	getEnvironmentVariablesObject,
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "@dokploy/server/utils/docker/utils";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { withResolvedVaultRefs } from "@dokploy/server/utils/vault";
import {
	type ComposeVariables,
	type ComposeVolumeResolution,
	dockerVolumesDirectoryReach,
	parseDotenvVariables,
	resolveComposeFilesMountedVolumes,
	resolveEnvironmentReferences,
	UNKNOWN_VARIABLE_VALUE,
} from "@dokploy/server/utils/volume-backups/compose-volumes";
import { parse as parseShell, quote } from "shell-quote";
import { parse } from "yaml";
import { logger } from "../lib/logger";
import { findRefusedComposeVolumes } from "./volume-binding";

type ComposeForVolumeCheck = Pick<
	ComposeNested,
	| "composeId"
	| "appName"
	| "composeType"
	| "createEnvFile"
	| "env"
	| "randomize"
	| "suffix"
	| "environment"
	| "serverId"
	| "sourceType"
	| "composePath"
	| "isolatedDeployment"
	| "isolatedDeploymentsVolume"
>;

type Spec = Parameters<typeof resolveComposeFilesMountedVolumes>[0][number];

// The variables `docker compose` / `docker stack deploy` interpolate the
// compose file with, as Dokploy writes them (see getCreateEnvFileCommand and
// stageStackEnvFile). A compose that does not get an env file from Dokploy
// reads whatever `.env` sits in its project directory, which the repository
// can bring: that file is read from the host and parsed
// (getDotenvInterpolationVariables), and no variable is trusted only when it
// cannot be (`strict`).
//
// The two kinds differ on a variable that is set to an empty string:
// - docker compose reads it from the `.env` as set-but-empty, which
//   `${A-x}` and `${A+x}` tell apart from unset, so empty values are kept;
// - a stack's staged env file leaves a variable without a value out
//   (buildStackEnvFileContent), so for a stack it is unset.
// The deploy shell's own variables are set but unknown: PATH and HOME for
// docker compose (the process environment wins over the `.env`), and the
// shell's PWD and the like for a stack.
type InterpolationVariables = { env: ComposeVariables; strict: boolean };

const STRICT_VARIABLES: InterpolationVariables = { env: {}, strict: true };

// The variables of the env file Dokploy writes (or stages, for a stack).
const getInterpolationVariables = (
	compose: ComposeForVolumeCheck,
): InterpolationVariables => {
	const isStack = compose.composeType === "stack";
	try {
		const projectEnv = compose.environment.project.env;
		const environmentEnv = compose.environment.env;
		if (isStack) {
			// The staged file leaves out the names the docker CLI reads as its own
			// settings (isStackEnvName), so for `docker stack deploy` they are unset.
			const written = Object.fromEntries(
				Object.entries(
					getEnvironmentVariablesObject(
						compose.env ?? "",
						projectEnv,
						environmentEnv,
					),
				).filter(([name]) => isStackEnvName(name)),
			);
			const shellNames = ["PATH", "HOME", "PWD", "OLDPWD", "SHLVL", "_"].filter(
				(name) => !Object.hasOwn(written, name),
			);
			// The values refer to each other, as Compose expands them.
			const env = resolveEnvironmentReferences(written, shellNames);
			for (const name of shellNames) {
				env[name] = UNKNOWN_VARIABLE_VALUE;
			}
			return { env, strict: false };
		}
		const content = `APP_NAME=${compose.appName}\nCOMPOSE_PROJECT_NAME=${compose.appName}\n${compose.env ?? ""}${
			compose.randomize ? `\nCOMPOSE_PREFIX=${compose.suffix}` : ""
		}`;
		const written: Record<string, string> = {};
		for (const pair of prepareEnvironmentVariables(
			content,
			projectEnv,
			environmentEnv,
		)) {
			const [key, value] = parseEnvironmentKeyValuePair(pair);
			// getCreateEnvFileCommand leaves out the `COMPOSE_*` settings of the
			// Environment and always writes Dokploy's own project name.
			if (key === "COMPOSE_PROJECT_NAME") continue;
			if (isComposeDotenvName(key)) written[key] = value;
		}
		written.COMPOSE_PROJECT_NAME = compose.appName;
		// The values refer to each other, as Compose expands them.
		const env = resolveEnvironmentReferences(written, ["PATH", "HOME"]);
		env.PATH = UNKNOWN_VARIABLE_VALUE;
		env.HOME = UNKNOWN_VARIABLE_VALUE;
		return { env, strict: false };
	} catch {
		// Unresolved references: the variables are not known.
		return { env: null, strict: true };
	}
};

// Compose reads `.env` from the project directory (the `--project-directory`
// or the directory of the first compose file); with an `--env-file` it reads
// only that file. The process environment is `env -i PATH HOME` (see
// getCleanEnvPrefix), so the file is the whole of it. A file that is not there
// is no variable at all; one that cannot be read, or that the check does not
// understand, is not known (`strict`).
const MAX_DOTENV_BYTES = 1024 * 1024;

// The text of the `.env` of a directory: "" when there is none, null when
// there is something that is not a regular file of a size that is read (a
// FIFO, a device, a directory, a file over the limit) or that cannot be read.
// A symlink is followed, as Compose follows it, but only inside the code
// directory: a `.env` that leads out of the checkout is refused
// (ComposeFileLinkError, T-8413) instead of read, so what the file holds
// cannot reach a message or Compose's interpolation. The local file is opened
// without blocking and looked at through the handle, so a FIFO swapped in
// after a look cannot hang the check or be read; the remote one is read under
// a time limit.
const readDotenv = async (
	compose: ComposeForVolumeCheck,
	path: string,
): Promise<string | null> => {
	try {
		if (compose.serverId) {
			const quoted = quote([path]);
			const read = `head -c ${MAX_DOTENV_BYTES + 1} ${quoted}`;
			const { stdout } = await execAsyncRemote(
				compose.serverId,
				getGuardedReadCommand({
					codeDirectory: getCodeDirectory(compose),
					extraDirectory: getFilesDirectory(compose),
					file: path,
					read: `if [ -f ${quoted} ]; then if command -v timeout >/dev/null 2>&1; then timeout 10 ${read}; else ${read}; fi; elif [ -e ${quoted} ]; then exit 3; fi`,
				}),
			);
			if (isComposeFileLinkMarker(stdout)) throw getComposeFileRefusal(stdout);
			return Buffer.byteLength(stdout) > MAX_DOTENV_BYTES ? null : stdout;
		}
		assertComposeFileInsideCodeDirectory(
			getCodeDirectory(compose),
			path,
			getFilesDirectory(compose),
		);
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(
				path,
				constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
			);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
		}
		try {
			const stats = await handle.stat();
			if (!stats.isFile() || stats.size > MAX_DOTENV_BYTES) {
				return null;
			}
			// A read can return less than there is: read to the end of the file,
			// or to one byte over the limit.
			const buffer = Buffer.alloc(MAX_DOTENV_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					length,
					buffer.length - length,
					length,
				);
				if (bytesRead === 0) {
					break;
				}
				length += bytesRead;
			}
			return length > MAX_DOTENV_BYTES
				? null
				: buffer.toString("utf8", 0, length);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (isComposeFileLinkError(error)) throw error;
		return null;
	}
};

const getDotenvInterpolationVariables = async (
	compose: ComposeForVolumeCheck,
	directory: string,
): Promise<InterpolationVariables> => {
	const text = await readDotenv(compose, posix.join(directory, ".env"));
	const variables = text === null ? null : parseDotenvVariables(text);
	if (!variables) {
		return STRICT_VARIABLES;
	}
	// The values refer to each other, as Compose expands them. PATH and HOME are
	// the process's, which win over the file.
	const env = resolveEnvironmentReferences(variables, ["PATH", "HOME"]);
	env.PATH = UNKNOWN_VARIABLE_VALUE;
	env.HOME = UNKNOWN_VARIABLE_VALUE;
	return { env, strict: false };
};

// What a stack's command line puts in the process (the staged env file wins
// over a `.env` file for a variable of both).
const overlay = (
	base: InterpolationVariables,
	top: InterpolationVariables,
): InterpolationVariables =>
	base.strict || top.strict
		? STRICT_VARIABLES
		: { env: { ...base.env, ...top.env }, strict: false };

// Nothing but PATH and HOME: a `docker stack deploy` that runs without the
// staged env, or a chained command that does not get it.
const EMPTY_VARIABLES: InterpolationVariables = {
	env: { PATH: UNKNOWN_VARIABLE_VALUE, HOME: UNKNOWN_VARIABLE_VALUE },
	strict: false,
};

// Every set of variables the deployed command can interpolate with.
// - The generated command: Dokploy's own, when it writes the env file and
//   passes it (`--env-file`) or deploys a stack (which never reads a `.env`);
//   otherwise the `.env` of the project directory, whose directory depends on
//   `--project-directory` and the first file, so each one it can be is read.
// - A custom command, by the kind of each command it runs: `docker compose`
//   reads the `.env` of its project directory with the environment of the
//   process over it (a stack's staged variables), and `docker stack deploy`
//   reads none and sees the staged variables, or nothing.
// The compose is checked with each of them. An `--env-file` of a custom command
// is not read: nothing is trusted then.
const getInterpolationWorlds = async (
	compose: ComposeForVolumeCheck,
	{
		customEnvFile,
		hasCommand,
		commandKinds,
		directories,
		composeDirectory,
	}: {
		customEnvFile: boolean;
		hasCommand: boolean;
		commandKinds: { compose: boolean; stack: boolean; count: number };
		directories: string[];
		composeDirectory: string;
	},
): Promise<InterpolationVariables[]> => {
	if (customEnvFile) {
		return [STRICT_VARIABLES];
	}
	const isStack = compose.composeType === "stack";
	const written = getInterpolationVariables(compose);
	if (!hasCommand) {
		if (isStack || compose.createEnvFile) {
			return [written];
		}
		return await Promise.all(
			[...new Set(directories)].map((directory) =>
				getDotenvInterpolationVariables(compose, directory),
			),
		);
	}
	const worlds: InterpolationVariables[] = [];
	if (commandKinds.compose || !commandKinds.stack) {
		for (const directory of new Set(directories)) {
			// Dokploy writes its env file next to the compose file.
			const file =
				compose.createEnvFile && directory === composeDirectory
					? written
					: await getDotenvInterpolationVariables(compose, directory);
			worlds.push(isStack ? overlay(file, written) : file);
			// Every docker command of a custom command runs under the clean
			// environment (see withCleanEnvironment), but the .env alone is also
			// checked once there is more than one, should a later one not get it.
			if (isStack && commandKinds.count > 1) {
				worlds.push(file);
			}
		}
	}
	if (commandKinds.stack) {
		worlds.push(isStack ? written : EMPTY_VARIABLES, EMPTY_VARIABLES);
	}
	return worlds;
};

const mergeResolutions = (
	resolutions: ComposeVolumeResolution[],
): ComposeVolumeResolution => {
	const uses = new Map<string, ComposeVolumeResolution["uses"][number]>();
	const merged: ComposeVolumeResolution = {
		uses: [],
		unresolved: [],
		forbidden: [],
		forbiddenParents: [],
		providers: [],
		models: [],
	};
	for (const resolution of resolutions) {
		for (const use of resolution.uses) {
			uses.set(`${use.key}\u0000${use.volumeName}`, use);
		}
		for (const name of [
			"unresolved",
			"forbidden",
			"forbiddenParents",
			"providers",
			"models",
		] as const) {
			for (const entry of resolution[name]) {
				if (!merged[name].includes(entry)) {
					merged[name].push(entry);
				}
			}
		}
	}
	merged.uses = [...uses.values()];
	return merged;
};

const getCodeDirectory = (compose: ComposeForVolumeCheck) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	// Hosts are Linux; a drive letter only appears on a Windows dev machine.
	const root = COMPOSE_PATH.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
	return posix.join(root, compose.appName, "code");
};

// The directory of the compose's file mounts: override files and the project
// `.env` may be read from it too (`-f ../files/override.yml`, T-8413).
const getFilesDirectory = (compose: ComposeForVolumeCheck) =>
	posix.join(posix.dirname(getCodeDirectory(compose)), "files");

// Refuses (throws) when the compose files mount a named volume that is not
// the compose's own (T-6822). The first spec is the YAML that is deployed
// (domains, randomize and isolatedDeployment already applied); the others are
// the override files of a custom command.
export const assertComposeSpecVolumesBound = async (
	compose: ComposeForVolumeCheck,
	specs: Spec | Spec[],
	{
		commandVolumes = [],
		commandBaseDirs = [],
		customEnvFile = false,
		hasCommand = false,
		commandKinds = { compose: false, stack: false, count: 0 },
	}: {
		commandVolumes?: string[];
		commandBaseDirs?: string[];
		customEnvFile?: boolean;
		hasCommand?: boolean;
		// Which docker commands a custom command runs.
		commandKinds?: { compose: boolean; stack: boolean; count: number };
	} = {},
) => {
	const codeDirectory = getCodeDirectory(compose);
	const composeFile =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	const composeDirectory = posix.dirname(
		posix.resolve(codeDirectory, composeFile || "."),
	);
	const baseDirs = [codeDirectory, composeDirectory, ...commandBaseDirs];
	const worlds = await getInterpolationWorlds(compose, {
		customEnvFile,
		hasCommand,
		commandKinds,
		directories: baseDirs,
		composeDirectory,
	});
	const strict = worlds.some((world) => world.strict);
	const { uses, unresolved, forbidden, forbiddenParents, providers, models } =
		mergeResolutions(
			worlds.map((world) =>
				resolveComposeFilesMountedVolumes(
					Array.isArray(specs) ? specs : [specs],
					{
						appName: compose.appName,
						env: world.env,
						strict: world.strict,
						baseDirs,
						commandVolumes,
						// `down -v` (the fresh-volumes teardown or a custom command)
						// removes every declared non-external volume by name, mounted
						// or not, so each one is a use of that name (T-7135). Always:
						// a declared volume that is another compose's is never right.
						includeDeclaredVolumes: true,
					},
				),
			),
		);
	if (providers.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, providers },
			"[VolumeBinding] A compose file was refused: a service declares a provider",
		);
		throw new Error(
			`Compose refused: ${providers[0]} declares a provider, which makes Docker Compose run a program of the host it deploys on (a Docker CLI plugin, or any program that its type names as a path or finds on the PATH) instead of a container. Provider services are not allowed: remove "provider:" from the service and run it as a regular container service.`,
		);
	}
	if (models.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, models },
			"[VolumeBinding] A compose file was refused: it declares models",
		);
		throw new Error(
			`Compose refused: ${models[0]} uses \`models\`, which uses the host's shared Docker Model Runner (the model options reach \`docker model pull\` and \`docker model configure\`, and the runtime flags are shared by every tenant). Models are not allowed: remove "models:" from the compose file and run the model as a regular container service.`,
		);
	}
	if (forbidden.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, forbidden },
			"[VolumeBinding] A compose file volume was refused: it mounts Docker's volume storage",
		);
		throw new Error(
			`Compose volume refused: ${forbidden[0]} is Docker's own volume storage (/var/lib/docker/volumes), which holds every volume on the host.`,
		);
	}
	if (forbiddenParents.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, forbiddenParents },
			"[VolumeBinding] A compose file volume was refused: it mounts a directory that contains Docker's volume storage",
		);
		throw new Error(
			`Compose volume refused: ${forbiddenParents[0]} contains Docker's own volume storage (/var/lib/docker/volumes), which holds every volume on the host. Mount a directory of the compose's own instead.`,
		);
	}
	if (unresolved.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, unresolved },
			"[VolumeBinding] A compose file volume was refused: it could not be resolved",
		);
		const hint = strict
			? `Dokploy could not read the env file Compose uses for this compose (the .env in its project directory could not be read or understood, or a custom command passes --env-file), so the variables in its volume names and host paths cannot be resolved: turn on "Create env file" (and drop --env-file from the command), or write the volume names and paths out in the compose file.`
			: "Write the volume names and paths out in the compose file.";
		throw new Error(
			`Compose volume check failed: ${unresolved[0]} cannot be resolved before the deploy, so the volumes and host paths it uses cannot be checked. ${hint} Keep the volumes in the one compose file (no include, no extends from another file, no volumes_from a container).`,
		);
	}
	const [refused] = await findRefusedComposeVolumes(compose, uses);
	if (refused) {
		throw new Error(refused.message);
	}
};

// `docker` options that take a value, before the command (`-c` is --context).
const DOCKER_OPTIONS_WITH_VALUE = new Set([
	"--config",
	"-H",
	"--host",
	"--context",
	"-c",
	"--log-level",
	"-l",
	"--tlscacert",
	"--tlscert",
	"--tlskey",
]);

// The `docker compose` options before the subcommand, with their arity: the
// root command's own and addProjectFlags (docker/compose cmd/compose/compose.go,
// the hidden ones included), and the docker CLI's that the plugin inherits
// (`--debug`, `--log-level`, and the daemon ones findDaemonOption refuses).
// Any other option is refused (T-7135): one that takes a value would make
// Compose read the next word as that value while the parser took it for the
// subcommand (`--insecure-registry ps -p OTHER down -v` runs `down -v` on
// OTHER), and a later Compose may add one.
const COMPOSE_OPTIONS_WITH_VALUE = new Set([
	"-f",
	"--file",
	"-p",
	"--project-name",
	"--env-file",
	"--project-directory",
	// The deprecated spelling of --project-directory (docker/compose
	// cmd/compose/compose.go: `opts.ProjectDir = opts.WorkDir`).
	"--workdir",
	"--profile",
	"--parallel",
	"--ansi",
	"--progress",
	"--insecure-registry",
	"--log-level",
	"--host",
	"--context",
	"--config",
	"--tlscacert",
	"--tlscert",
	"--tlskey",
]);
const COMPOSE_BOOLEAN_OPTIONS = new Set([
	"--compatibility",
	"--all-resources",
	"--dry-run",
	"--version",
	"--no-ansi",
	"--verbose",
	"--help",
	"--debug",
	"--tls",
	"--tlsverify",
]);

const unknownComposeOption = (word: string) =>
	new Error(
		`Compose command refused: the docker compose option "${word}" is not understood, so the project name, compose files and env files it may hide cannot be checked. Use only the options Docker Compose documents before the subcommand (-f FILE, -p NAME, --env-file FILE, --project-directory DIR, --profile NAME, ...).`,
	);

// A value given as the next word that starts with `-` (`--profile -x ps
// config -o FILE`): the docker CLI's plugin pass reads that word as an option
// of its own and takes one more word, so the subcommand Compose runs is not
// the one the parser sees (T-7135). Such a value is only accepted attached
// (`--profile=-x`, `-f-x`); Dokploy never passes one.
const dashValueOption = (option: string, value: string) =>
	new Error(
		`Compose command refused: the docker compose option "${option}" is given the value "${value}", which starts with "-", so the subcommand Docker runs cannot be told from here. Attach the value instead (${option.startsWith("--") ? `${option}=${value}` : `${option}${value}`}).`,
	);

// Which `docker compose` subcommands load the compose files (T-7161), with
// their providers, volumes and host paths:
// - `version` loads nothing.
// - These work from the labels of the containers of the project when they get
//   a project name (`-p NAME`) and no `-f`: Compose loads no file then and the
//   project it builds has no provider (docker/compose `projectOrName` /
//   `toProjectName`). Without a name they load the default file like a loader.
//   Every `-f` that is given is read in any case.
// - Every other subcommand (build, config, create, pull, run, up, and one this
//   list does not know) loads the files, and must name them with `-f`. That
//   stays so when the default file would be the checked one: without `-f`
//   Compose also reads `COMPOSE_FILE` from a `.env` of the repository (with
//   "Create env file" off) and merges the `*.override.yml` next to the default
//   file, none of which is parsed here.
const PROJECT_FREE_SUBCOMMANDS = new Set(["version"]);
const LABEL_DRIVEN_SUBCOMMANDS = new Set([
	"down",
	"exec",
	"images",
	"kill",
	"logs",
	"pause",
	"port",
	"ps",
	"restart",
	"rm",
	"start",
	"stop",
	"top",
	"unpause",
	"wait",
]);

type CommandSegment = {
	kind: "compose" | "stack" | "other";
	subcommand?: string;
	files: string[];
	projectDirectories: string[];
	// A project name is given (`-p NAME`, `--project-name NAME`, `-pNAME`).
	hasProjectName?: boolean;
	// The project name that is given, as written: the last one wins and an empty
	// one is none (pflag keeps the last value of a string option).
	projectName?: string;
	// The stack names of a `docker stack` command (its non-option words after the
	// subcommand) and the first option that is not understood, which could take
	// a value that is a name.
	stackNames?: string[];
	stackUnknownOption?: string;
	// The `-v` / `--volume` values of a `docker compose run`.
	volumes: string[];
	// The `--env-file` values: they replace the `.env` Dokploy writes.
	envFiles: string[];
	// The `--env-from-file` values of a `docker compose run`.
	envFromFiles: string[];
	// The `-o` / `--output` option of a `docker compose config`, as written.
	outputOption?: string;
	// The `--watch` / `-w` option of a `docker compose up`, as written.
	watchOption?: string;
	// The first word of an `other` segment (`run`, `exec`, `cp`, ...).
	command?: string;
	// The `--mount` / `--volumes-from` options of a `docker compose run`, as
	// written. They are not read like `-v`, so a run that has one is refused.
	uncheckedMounts: string[];
	// The first docker global option that points the command at another
	// daemon, context or config (see findDaemonOption).
	daemonOption?: string;
};

// `docker compose run` options that take a value (the next word, or the rest
// of the word after a single-letter option). Without this list the value of
// `-e` or `--name` could be taken for an option.
const RUN_SHORT_OPTIONS_WITH_VALUE = new Set(["e", "l", "p", "u", "v", "w"]);
const RUN_LONG_OPTIONS_WITH_VALUE = new Set([
	"cap-add",
	"cap-drop",
	"entrypoint",
	"env",
	"env-from-file",
	"label",
	"name",
	"publish",
	"pull",
	"user",
	"volume",
	"workdir",
]);

// The `-v` / `--volume` values in the words after `run`. pflag reads
// `-v x`, `-vx`, `-v=x`, `--volume x`, `--volume=x`, and a short option can
// follow other short flags (`-Tv x`). The whole rest of the line is read, not
// only the words before the service name, because an unknown option that takes
// a value would otherwise hide a later `-v`; a `-v` after the service name is
// the service command's own, and is only ever checked more strictly.
const parseRunVolumes = (words: string[]) => {
	const volumes: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (word.startsWith("--")) {
			const [name = "", ...rest] = word.slice(2).split("=");
			if (!RUN_LONG_OPTIONS_WITH_VALUE.has(name)) {
				continue;
			}
			const value = rest.length > 0 ? rest.join("=") : words[i + 1];
			if (rest.length === 0) {
				i += 1;
			}
			if (name === "volume" && value !== undefined) {
				volumes.push(value);
			}
		} else if (/^-[^-]/.test(word)) {
			for (let j = 1; j < word.length; j++) {
				const letter = word[j] as string;
				if (!RUN_SHORT_OPTIONS_WITH_VALUE.has(letter)) {
					continue;
				}
				const attached = word.slice(j + 1).replace(/^=/, "");
				let value: string | undefined = attached;
				if (!attached) {
					value = words[i + 1];
					i += 1;
				}
				if (letter === "v" && value !== undefined) {
					volumes.push(value);
				}
				break;
			}
		}
	}
	return volumes;
};

const DAEMON_LONG_OPTION =
	/^--(?:host|context|config|tls|tlsverify|tlscacert|tlscert|tlskey)(?:=|$)/;

// The docker global options that change the daemon, the context or the
// config the command runs against (`-H`/`--host`, `-c`/`--context`,
// `--config`, `--tls*`). With one, `docker compose` talks to another
// daemon and the volumes it mounts are not this host's, or this host's under
// another config, so the check cannot say anything about them (T-7055). The
// docker CLI takes them before the subcommand and the compose plugin also
// takes them among its own options, so both are read. A short option is read
// letter by letter up to the first one that takes a value (`f`, `p`, `l`:
// the rest of the word is the value), so `-Dc ctx` and `-cctx` are seen.
// `-c` is only one before the subcommand: after `stack deploy` it is the
// compose file, and after a service name it is the service command's own.
const findDaemonOption = (words: string[], { allowShortC = false } = {}) => {
	for (const word of words) {
		if (DAEMON_LONG_OPTION.test(word)) {
			return word;
		}
		if (/^-[^-]/.test(word)) {
			for (const letter of word.slice(1)) {
				if (letter === "H" || (letter === "c" && !allowShortC)) {
					return word;
				}
				if ("fpl".includes(letter)) {
					break;
				}
			}
		}
	}
	return undefined;
};

// The same for the words after a `compose run` / `exec` subcommand, up to
// the service name: everything after it is the command that runs in the
// container (`run web rails s --host 0.0.0.0`), which docker does not read.
const RUN_AND_EXEC_LONG_OPTIONS_WITH_VALUE = new Set([
	"cap-add",
	"cap-drop",
	"entrypoint",
	"env",
	"env-from-file",
	"index",
	"label",
	"name",
	"publish",
	"pull",
	"user",
	"volume",
	"workdir",
]);

const findDaemonOptionBeforeService = (words: string[]) => {
	const before: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (word.startsWith("--")) {
			before.push(word);
			const name = word.slice(2).split("=")[0] ?? "";
			if (
				!word.includes("=") &&
				RUN_AND_EXEC_LONG_OPTIONS_WITH_VALUE.has(name)
			) {
				i += 1;
			}
		} else if (/^-[^-]/.test(word)) {
			before.push(word);
			for (let j = 1; j < word.length; j++) {
				if (RUN_SHORT_OPTIONS_WITH_VALUE.has(word[j] as string)) {
					if (j === word.length - 1) {
						i += 1;
					}
					break;
				}
			}
		} else {
			break;
		}
	}
	return findDaemonOption(before);
};

// The `--mount` and `--volumes-from` options in the words after `run`. They
// mount volumes and bind sources like `-v` does, but are not parsed: a run
// that has one is refused rather than guessed at. Like `-v`, the whole rest
// of the line is read, so one after the service name is refused too.
const parseRunUncheckedMounts = (words: string[]) =>
	words.filter((word) => /^--(?:mount|volumes-from)(?:=|$)/.test(word));

// The `--env-from-file` values in the words after `run`: the file is read by
// docker compose and its variables go into the container.
const parseRunEnvFromFiles = (words: string[]) => {
	const files: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (word === "--env-from-file") {
			const value = words[i + 1];
			if (value !== undefined) {
				files.push(value);
			}
			i += 1;
		} else if (word.startsWith("--env-from-file=")) {
			files.push(word.slice("--env-from-file=".length));
		}
	}
	return files;
};

// `docker compose config -o FILE` writes the rendered file to a path of the
// caller's choosing. `-o` is the only short `config` option with an o, also in a
// bundle (`-qo FILE`).
const OUTPUT_OPTION = /^(?:--output(?:=|$)|-[A-Za-z]*o)/;

// `docker compose up --watch` (`-w` on `up`; on `run` and `exec` it is --workdir) syncs
// the `develop.watch[].path` host paths of the compose file into the containers,
// and that path is not checked.
const WATCH_OPTION = /^(?:--watch(?:=|$)|-[A-Za-z]*w)/;

// The value of a path option that the shell or Docker would expand into
// something else: a variable, a substitution or a pattern. The path it ends
// up as cannot be known here, and the compose files, the project directory
// and the env file decide what the check reads and resolves from.
const NON_LITERAL = /[$`*?[\]{}]/;

const assertLiteralPathOptions = (
	segment: Pick<CommandSegment, "files" | "projectDirectories" | "envFiles"> &
		Partial<Pick<CommandSegment, "envFromFiles">>,
) => {
	const options: Array<[string, string[]]> = [
		["compose file", segment.files],
		["--project-directory", segment.projectDirectories],
		["--env-file", segment.envFiles],
		["--env-from-file", segment.envFromFiles ?? []],
	];
	for (const [name, values] of options) {
		const value = values.find((candidate) => NON_LITERAL.test(candidate));
		if (value !== undefined) {
			throw new Error(
				`Compose command refused: the ${name} "${value}" uses a variable, a substitution or a pattern, so the files and volumes it leads to cannot be checked. Write the path out.`,
			);
		}
	}
};

// pflag reads `-f=path` and `-fpath` as the path.
const shortOptionValue = (word: string) => word.slice(2).replace(/^=/, "");

// The options of `docker stack deploy|rm|ps|services` (docker/cli
// cli/command/stack/*), so that the words that are stack names can be told
// from option values. `-c` / `--compose-file`, `-f` / `--filter`, `--format`,
// `--resolve-image` (and the removed `--orchestrator`, `--namespace`,
// `--kubeconfig`) take a value; the others are booleans, and `--detach` only
// takes one as `--detach=false`. An option that is not here is reported:
// it could take a value that would be taken for a name.
const STACK_LONG_OPTIONS_WITH_VALUE = new Set([
	"compose-file",
	"filter",
	"format",
	"resolve-image",
	"orchestrator",
	"namespace",
	"kubeconfig",
]);
const STACK_LONG_BOOLEAN_OPTIONS = new Set([
	"prune",
	"with-registry-auth",
	"detach",
	"quiet",
	"no-resolve",
	"no-trunc",
	"all-namespaces",
]);

// The stack names in the words after the subcommand of a `docker stack`
// command: the words that are neither options nor their values.
const parseStackNames = (words: string[]) => {
	const names: string[] = [];
	let unknownOption: string | undefined;
	let afterDashes = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (afterDashes) {
			names.push(word);
		} else if (word === "--") {
			afterDashes = true;
		} else if (word.startsWith("--")) {
			const name = word.slice(2).split("=")[0] ?? "";
			if (STACK_LONG_OPTIONS_WITH_VALUE.has(name)) {
				if (!word.includes("=")) {
					i += 1;
				}
			} else if (!STACK_LONG_BOOLEAN_OPTIONS.has(name)) {
				unknownOption ??= word;
			}
		} else if (/^-[^-]/.test(word)) {
			// A bundle of short options: `c` and `f` take the rest of the word, or
			// the next word when nothing is left; `d` and `q` are booleans.
			for (let j = 1; j < word.length; j++) {
				const letter = word[j] as string;
				if (letter === "c" || letter === "f") {
					if (j === word.length - 1) {
						i += 1;
					}
					break;
				}
				if (letter !== "d" && letter !== "q") {
					unknownOption ??= word;
					break;
				}
			}
		} else {
			names.push(word);
		}
	}
	return { names, unknownOption };
};

// A custom command replaces the generated one, but it is still `docker
// <command>` chained with `docker compose ...` commands (sanitizeCommand).
// A compose file argument is only one in the global options before the
// subcommand (`rm -f` is not a file), `-c` only for `docker stack`, and the
// options of `docker` itself (`-H x`, `--context x`, ...) come first.
//
// `opaque` is true when the line has a word the shell would rewrite (a glob
// such as `A=*`) or an operator other than `&&`: what follows cannot be
// told from here. A glob is kept as its pattern so that the words around it
// keep their place.
const parseComposeCommand = (
	command: string,
): { segments: CommandSegment[]; opaque: boolean } => {
	const words: string[][] = [[]];
	let opaque = false;
	// A shell variable stays in the word as written (`$SRC`) so that a `-v`
	// value that uses one is seen as unknown, not as an empty string. For a
	// compose file it makes no difference: either way that file is not the
	// deployed one and cannot be read.
	for (const token of parseShell(command, (name) => `$${name}`)) {
		if (typeof token === "string") {
			words[words.length - 1]?.push(token);
			continue;
		}
		const { op, pattern } = token as { op?: string; pattern?: string };
		if (op === "glob" && pattern !== undefined) {
			words[words.length - 1]?.push(pattern);
			opaque = true;
		} else {
			words.push([]);
			opaque = opaque || op !== "&&";
		}
	}
	const segments = words
		.filter((tokens) => tokens.length > 0)
		.map((tokens, index): CommandSegment => {
			let words = tokens;
			let start = 0;
			if (index > 0 && words[0] === "docker-compose") {
				words = ["compose", ...words.slice(1)];
			} else {
				if (index > 0 && words[0] === "docker") {
					start = 1;
				}
				while (start < words.length && words[start]?.startsWith("-")) {
					start += DOCKER_OPTIONS_WITH_VALUE.has(words[start] as string)
						? 2
						: 1;
				}
			}
			const files: string[] = [];
			const projectDirectories: string[] = [];
			const volumes: string[] = [];
			const envFiles: string[] = [];
			const command = words[start];
			if (command === "compose") {
				let subcommand: string | undefined;
				let projectName: string | undefined;
				let i = start + 1;
				for (; i < words.length; ) {
					const word = words[i] as string;
					if (word.startsWith("--") && word.includes("=")) {
						const [name = "", ...rest] = word.split("=");
						if (
							!COMPOSE_OPTIONS_WITH_VALUE.has(name) &&
							!COMPOSE_BOOLEAN_OPTIONS.has(name)
						) {
							throw unknownComposeOption(word);
						}
						if (name === "--file") {
							files.push(rest.join("="));
						} else if (name === "--project-directory" || name === "--workdir") {
							projectDirectories.push(rest.join("="));
						} else if (name === "--env-file") {
							envFiles.push(rest.join("="));
						} else if (name === "--project-name") {
							// The last one wins, also an empty one.
							projectName = rest.join("=") || undefined;
						}
						i += 1;
					} else if (COMPOSE_OPTIONS_WITH_VALUE.has(word)) {
						const value = words[i + 1];
						if (value?.startsWith("-")) {
							throw dashValueOption(word, value);
						}
						if (value !== undefined) {
							if (word === "-f" || word === "--file") {
								files.push(value);
							} else if (
								word === "--project-directory" ||
								word === "--workdir"
							) {
								projectDirectories.push(value);
							} else if (word === "--env-file") {
								envFiles.push(value);
							} else if (word === "-p" || word === "--project-name") {
								// The last one wins, also an empty one.
								projectName = value || undefined;
							}
						}
						i += 2;
					} else if (/^-[^-]/.test(word)) {
						// A bundle of short flags (pflag): `-fFILE`, `-f=FILE`, `-pNAME`,
						// `-vfFILE` (`-v` and `-h` are booleans). `f` and `p` take the rest
						// of the word, or the next word when nothing is left; a letter
						// that is not known is refused, since it could hide a `-f`.
						let consumed = 1;
						for (let j = 1; j < word.length; j++) {
							const letter = word[j] as string;
							if (letter === "v" || letter === "h") {
								continue;
							}
							if (letter === "H" || letter === "c") {
								// A daemon or context option: findDaemonOption refuses it.
								break;
							}
							if (letter !== "f" && letter !== "p") {
								throw unknownComposeOption(word);
							}
							const rest = word.slice(j + 1).replace(/^=/, "");
							let value = rest;
							if (j === word.length - 1) {
								value = words[i + 1] ?? "";
								consumed = 2;
								if (value.startsWith("-")) {
									throw dashValueOption(word, value);
								}
							}
							if (letter === "f") {
								if (value) {
									files.push(value);
								}
							} else {
								// The last one wins, also an empty one.
								projectName = value || undefined;
							}
							break;
						}
						i += consumed;
					} else if (COMPOSE_BOOLEAN_OPTIONS.has(word)) {
						i += 1;
					} else if (word.startsWith("-")) {
						// Also `--` and `-`, which pflag does not read as an option.
						throw unknownComposeOption(word);
					} else {
						subcommand = word;
						break;
					}
				}
				const uncheckedMounts: string[] = [];
				const envFromFiles: string[] = [];
				const outputOption =
					subcommand === "config"
						? words.slice(i + 1).find((word) => OUTPUT_OPTION.test(word))
						: undefined;
				const watchOption =
					subcommand === "up"
						? words.slice(i + 1).find((word) => WATCH_OPTION.test(word))
						: undefined;
				const daemonOption =
					findDaemonOption(words.slice(0, i), { allowShortC: false }) ??
					(subcommand === "run" || subcommand === "exec"
						? findDaemonOptionBeforeService(words.slice(i + 1))
						: findDaemonOption(words.slice(i + 1), { allowShortC: true }));
				if (subcommand === "run") {
					volumes.push(...parseRunVolumes(words.slice(i + 1)));
					uncheckedMounts.push(...parseRunUncheckedMounts(words.slice(i + 1)));
					envFromFiles.push(...parseRunEnvFromFiles(words.slice(i + 1)));
				}
				assertLiteralPathOptions({
					files,
					projectDirectories,
					envFiles,
					envFromFiles,
				});
				return {
					kind: "compose",
					subcommand,
					files,
					projectDirectories,
					hasProjectName: projectName !== undefined,
					projectName,
					volumes,
					envFiles,
					envFromFiles,
					uncheckedMounts,
					outputOption,
					watchOption,
					daemonOption,
				};
			}
			if (command === "stack") {
				const rest = words.slice(start + 1);
				const subcommandIndex = rest.findIndex((word) => !word.startsWith("-"));
				const subcommand = rest[subcommandIndex];
				const cut = subcommandIndex < 0 ? rest.length : subcommandIndex;
				const daemonOption =
					findDaemonOption(words.slice(0, start + 1 + cut)) ??
					findDaemonOption(rest.slice(cut), { allowShortC: true });
				for (let i = 0; i < rest.length; i++) {
					const word = rest[i] as string;
					if (word === "-c" || word === "--compose-file") {
						const value = rest[i + 1];
						if (value !== undefined) {
							files.push(value);
						}
					} else if (word.startsWith("--compose-file=")) {
						files.push(word.slice("--compose-file=".length));
					} else if (/^-c.+/.test(word)) {
						files.push(shortOptionValue(word));
					}
				}
				assertLiteralPathOptions({ files, projectDirectories, envFiles });
				const { names: stackNames, unknownOption: stackUnknownOption } =
					parseStackNames(rest.slice(cut + 1));
				return {
					kind: "stack",
					subcommand,
					stackNames,
					stackUnknownOption,
					files,
					projectDirectories,
					volumes,
					envFiles,
					envFromFiles: [],
					uncheckedMounts: [],
					daemonOption,
				};
			}
			return {
				kind: "other",
				command,
				files,
				projectDirectories,
				volumes,
				envFiles,
				envFromFiles: [],
				uncheckedMounts: [],
				daemonOption: findDaemonOption(words.slice(0, start)),
			};
		});
	return { segments, opaque };
};

// The compose files a custom command passes besides the deployed one. A
// `docker compose` command that loads the project (a loader, or a label-driven
// subcommand without a project name; see LABEL_DRIVEN_SUBCOMMANDS) without
// naming a file would make Docker find a compose file (or an override) in the
// project directory by itself. Every `-f` a command does name is read.
export const getCommandOverrideFiles = (
	compose: ComposeForVolumeCheck & Pick<ComposeNested, "command">,
) => {
	if (!compose.command) {
		return [];
	}
	const codeDirectory = getCodeDirectory(compose);
	const deployed = posix.resolve(
		codeDirectory,
		compose.sourceType === "raw"
			? "docker-compose.yml"
			: compose.composePath || "docker-compose.yml",
	);
	const overrides = new Set<string>();
	for (const segment of parseComposeCommand(compose.command).segments) {
		const loadsFiles =
			segment.kind === "compose" &&
			segment.subcommand !== undefined &&
			!PROJECT_FREE_SUBCOMMANDS.has(segment.subcommand) &&
			!(
				LABEL_DRIVEN_SUBCOMMANDS.has(segment.subcommand) &&
				segment.hasProjectName
			);
		const readsFiles =
			loadsFiles ||
			(segment.kind === "stack" && segment.subcommand === "deploy");
		// A label-driven command with a project name and no `-f` reads nothing;
		// a `-f` it does get is parsed below like any other.
		if (!readsFiles && segment.files.length === 0) {
			continue;
		}
		if (readsFiles && segment.files.length === 0) {
			logger.warn(
				{ composeId: compose.composeId },
				"[VolumeBinding] A compose command was refused: it names no compose file",
			);
			throw new Error(
				`Compose command refused: it runs \`docker ${segment.kind} ${segment.subcommand}\` without naming a compose file, so Docker would pick one from the project directory and its volumes, host paths and providers would not be checked. Pass "-f ${compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath}" (or "-c" for a stack).`,
			);
		}
		// A relative file is read from the working directory, and possibly from
		// --project-directory: it counts as the deployed file only if every
		// reading of it is that file.
		const bases = [
			codeDirectory,
			...segment.projectDirectories.map((directory) =>
				posix.resolve(codeDirectory, directory),
			),
		];
		for (const file of segment.files) {
			const candidates = new Set(
				posix.isAbsolute(file)
					? [posix.normalize(file)]
					: bases.map((base) => posix.resolve(base, file)),
			);
			for (const candidate of candidates) {
				if (candidate !== deployed) {
					overrides.add(candidate);
				}
			}
		}
	}
	return [...overrides];
};

// A custom command is `docker <command>` followed by chained
// `docker compose ...` commands, and a deploy only needs `compose` and `stack`
// (T-7055). Any other docker command (`docker run -v ...`, `create`, `cp`,
// `exec`, `container run`, `service create --mount`, `volume`, ...) can mount,
// read or write a volume or a container that is not the compose's own, and
// its `-v` / `--mount` / `--volumes-from` are not parsed, so it is refused.
//
// What is left of `docker compose` and `docker stack` is limited to the
// subcommands a service needs, because the others reach host paths or other
// containers (`compose cp`, `export`, `config -o FILE`, ...); and the compose
// file, `--env-file`, `--env-from-file` and `--project-directory` may not lead
// into Docker's volume storage, which holds the data of every volume on the
// host.
const COMPOSE_SUBCOMMANDS = new Set([
	"build",
	"config",
	"create",
	"down",
	"exec",
	"images",
	"kill",
	"logs",
	"pause",
	"port",
	"ps",
	"pull",
	"restart",
	"rm",
	"run",
	"start",
	"stop",
	"top",
	"unpause",
	"up",
	"version",
	"wait",
]);
const STACK_SUBCOMMANDS = new Set(["deploy", "ps", "rm", "services"]);

// Whether a name a custom command gives (`-p`, a `name:`) is this compose's
// own project name: the appName every Dokploy command passes as `-p` (the
// preview and the isolated deployment keep it too; their suffix only renames
// the services, volumes and networks inside the project). Exactly, with no
// normalisation: older Compose versions lowercase a name and drop the
// characters outside [-_a-z0-9], so `my.app` or `MyApp` would be the project
// of another appName (`myapp`), and Dokploy itself always passes the appName
// as it is.
const isOwnProjectName = (compose: { appName: string }, name: string) =>
	name === compose.appName;

// A project name with a shell pattern or a path character: the shell can turn
// a pattern into a file name of the repository (`-p '*x*'` unquoted), and
// none of them is in an appName.
const UNSAFE_PROJECT_NAME = /[*?[\]{}/\\~$`]/;

// A preview deploys the base compose's custom command under its own appName,
// `preview-<base appName>-<id>` (createComposePreview), so a command written
// with `-p <base appName>` is not the preview's.
const previewBaseAppName = (appName: string) =>
	/^preview-(.+)-[^-]+$/.exec(appName)?.[1];

// `docker compose` subcommands that act on no containers, networks, volumes or
// images of a project, so the name they would use does not matter: `version`
// loads nothing, `config` only renders the files and `pull` pulls the images
// the services name. (`build` tags `<project>-<service>`, so it is not here.)
// What they read is another matter: their paths are held to the compose's own
// directory like every other subcommand's (assertCommandPathsInOwnDirectory).
const PROJECT_NAME_FREE_SUBCOMMANDS = new Set(["version", "config", "pull"]);

// The `docker compose` commands of a custom command that act on a project but
// give it no name: Compose then takes the name from `COMPOSE_PROJECT_NAME`
// (the `.env` of the project directory or an `--env-file`), else from the
// top-level `name:` of the files, else from the name of the project directory
// (docker/compose cmd/compose `projectOrName`, compose-go
// `withNamePrecedenceLoad`).
const getUnnamedProjectSegments = (segments: CommandSegment[]) =>
	segments.filter(
		(segment) =>
			segment.kind === "compose" &&
			segment.subcommand !== undefined &&
			!PROJECT_NAME_FREE_SUBCOMMANDS.has(segment.subcommand) &&
			segment.projectName === undefined,
	);

// A custom command may only act on this compose's own project (T-7135).
// `docker compose -p <another appName> down -v|stop|rm|up|logs|build ...` and
// `docker stack rm|deploy|ps|services <another stack>` act on the containers,
// services and images of another tenant's project through their labels, so:
// - a project name the command passes (`-p`, `--project-name`, every spelling,
//   the last one wins) must be the compose's own;
// - a stack name must be the compose's own appName;
// - a `docker compose` command that passes no name must get the compose's own
//   from the `.env` Dokploy writes next to the compose file, which sets
//   COMPOSE_PROJECT_NAME and is read when the project directory is that one
//   and no `--env-file` replaces it. Anywhere else the name comes from a
//   file the repository brings or from the name of a directory it names
//   (`-f <another appName>/docker-compose.yml`), and cannot be vouched for.
const assertCommandProjectNames = (
	compose: ComposeForVolumeCheck,
	segments: CommandSegment[],
) => {
	for (const segment of segments) {
		if (
			segment.kind === "compose" &&
			segment.projectName !== undefined &&
			UNSAFE_PROJECT_NAME.test(segment.projectName)
		) {
			throw new Error(
				`Compose command refused: the project name "${segment.projectName}" has a shell pattern or path character (* ? [ ] { } / \\ ~ $ \`), so the name Compose gets cannot be known. Use "-p ${compose.appName}".`,
			);
		}
		if (
			segment.kind === "compose" &&
			segment.projectName !== undefined &&
			!isOwnProjectName(compose, segment.projectName)
		) {
			logger.warn(
				{ composeId: compose.composeId, projectName: segment.projectName },
				"[VolumeBinding] A compose command was refused: a project name that is not the compose's own",
			);
			const preview =
				previewBaseAppName(compose.appName) === segment.projectName
					? ` This is a preview deployment, which runs the custom command of its compose: its project name is "${compose.appName}", not the compose's "${segment.projectName}". Leave -p out of the command (the .env Dokploy writes sets COMPOSE_PROJECT_NAME to the project name of each deployment).`
					: "";
			throw new Error(
				`Compose command refused: it passes the project name "${segment.projectName}", which is not this compose's own ("${compose.appName}"). A custom command can only act on its own project: use "-p ${compose.appName}" (or leave -p out).${preview}`,
			);
		}
		if (segment.kind === "stack") {
			if (segment.stackUnknownOption !== undefined) {
				throw new Error(
					`Compose command refused: the docker stack option "${segment.stackUnknownOption}" is not understood, so the stack name it is used with cannot be checked. Write the command with the options it needs only (\`docker stack ${segment.subcommand ?? "deploy"} -c FILE ${compose.appName}\`).`,
				);
			}
			const other = (segment.stackNames ?? []).find(
				(name) => name !== compose.appName,
			);
			if (other !== undefined) {
				logger.warn(
					{ composeId: compose.composeId, stack: other },
					"[VolumeBinding] A compose command was refused: a stack name that is not the compose's own",
				);
				throw new Error(
					`Compose command refused: \`docker stack ${segment.subcommand ?? ""}\` names the stack "${other}", which is not this compose's own ("${compose.appName}"). A custom command can only act on its own stack.`,
				);
			}
		}
	}
	const unnamed = getUnnamedProjectSegments(segments);
	if (unnamed.length === 0) {
		return;
	}
	const codeDirectory = getCodeDirectory(compose);
	// getCreateEnvFileCommand writes it next to composePath, whatever file the
	// command passes.
	const envDirectory = posix.dirname(
		posix.resolve(codeDirectory, compose.composePath || "docker-compose.yml"),
	);
	for (const segment of unnamed) {
		const reason = (() => {
			if (segment.envFiles.length > 0) {
				return `it passes --env-file "${segment.envFiles[0]}", which replaces the .env Dokploy writes and may set COMPOSE_PROJECT_NAME`;
			}
			if (!compose.createEnvFile) {
				return 'the compose does not write a .env ("Create env file" is off), so COMPOSE_PROJECT_NAME could come from a .env of the repository';
			}
			// `--project-directory` (or its older spelling) decides where the `.env`
			// is read from, else the directory of the first file (the last of a
			// repeated option wins). A relative file is resolved from the working
			// directory and, possibly, from the project directory.
			const projectDirectory = segment.projectDirectories.at(-1);
			const bases = [
				codeDirectory,
				...segment.projectDirectories.map((directory) =>
					posix.resolve(codeDirectory, directory),
				),
			];
			const first = segment.files[0];
			const directories = new Set(
				projectDirectory
					? [posix.resolve(codeDirectory, projectDirectory)]
					: first === undefined
						? [codeDirectory]
						: posix.isAbsolute(first)
							? [posix.dirname(posix.normalize(first))]
							: bases.map((base) => posix.dirname(posix.resolve(base, first))),
			);
			const elsewhere = [...directories].find(
				(directory) => directory !== envDirectory,
			);
			return elsewhere === undefined
				? undefined
				: `its project directory is "${elsewhere}", not the one with the .env Dokploy writes (${envDirectory}), so the project would take its name from a file or a directory of the repository`;
		})();
		if (reason !== undefined) {
			logger.warn(
				{ composeId: compose.composeId, subcommand: segment.subcommand },
				"[VolumeBinding] A compose command was refused: it names no project and its name cannot be vouched for",
			);
			throw new Error(
				`Compose command refused: \`docker compose ${segment.subcommand}\` passes no project name and ${reason}. Docker Compose could then act on the project of another compose. Pass "-p ${compose.appName}".`,
			);
		}
	}
};

// The top-level `name:` of the compose files (the deployed one and the files a
// custom command names) sets the project name when nothing else does, so a
// `docker compose` command that passes no name (see
// getUnnamedProjectSegments) would act on that project: a `name:` that is not
// this compose's own is refused then, also a name that comes from a variable.
// `-p` wins over a `name:` in Compose, so with a name given on every command
// (the default command always does) the file's `name:` has no effect and is not
// looked at. The `.env` Dokploy writes sets COMPOSE_PROJECT_NAME, which also
// wins over a `name:` in compose-go's withNamePrecedenceLoad, so with it a
// `name:` cannot take effect today; it is refused all the same rather than
// relying on that order.
const assertCommandActsOnOwnProject = (
	compose: ComposeForVolumeCheck & Pick<ComposeNested, "command">,
	specs: Spec[],
) => {
	if (!compose.command) {
		return;
	}
	const { segments } = parseComposeCommand(compose.command);
	assertCommandProjectNames(compose, segments);
	if (getUnnamedProjectSegments(segments).length === 0) {
		return;
	}
	for (const spec of specs) {
		const name = (spec as { name?: unknown } | null)?.name;
		if (name === undefined || name === null || name === "") {
			continue;
		}
		if (typeof name !== "string" || !isOwnProjectName(compose, name)) {
			logger.warn(
				{ composeId: compose.composeId },
				"[VolumeBinding] A compose file was refused: its name: is not the compose's project name",
			);
			throw new Error(
				`Compose refused: the compose file sets the project name with "name: ${String(name)}", which is not this compose's own ("${compose.appName}"), and a command of this compose passes no -p. Compose would take that project name and act on the containers, volumes and networks of the project of that name. Remove "name:" (or set it to "${compose.appName}"), or pass "-p ${compose.appName}" in every docker compose command of the custom command.`,
			);
		}
	}
};

export const assertCommandRunsComposeOnly = (
	compose: ComposeForVolumeCheck & Pick<ComposeNested, "command">,
) => {
	if (!compose.command) {
		return;
	}
	const { segments } = parseComposeCommand(compose.command);
	const daemon = segments.find((segment) => segment.daemonOption);
	if (daemon) {
		logger.warn(
			{ composeId: compose.composeId, option: daemon.daemonOption },
			"[VolumeBinding] A compose command was refused: a docker option that changes the daemon, context or config",
		);
		throw new Error(
			`Compose command refused: the docker option "${daemon.daemonOption}" is not allowed in a custom command. -H/--host, -c/--context, --config and --tls* point docker at another daemon or config, where the volumes it mounts cannot be checked.`,
		);
	}
	const other = segments.find((segment) => segment.kind === "other");
	if (other) {
		logger.warn(
			{ composeId: compose.composeId, command: other.command },
			"[VolumeBinding] A compose command was refused: it runs a docker command other than compose or stack",
		);
		throw new Error(
			`Compose command refused: it runs \`docker ${other.command ?? ""}\`, which can mount volumes or reach containers that are not this compose's own. A custom command can only run \`docker compose\` (chained: \`docker compose\` or \`docker-compose\`) or \`docker stack\`.`,
		);
	}
	for (const segment of segments) {
		const allowed =
			segment.kind === "compose" ? COMPOSE_SUBCOMMANDS : STACK_SUBCOMMANDS;
		if (segment.subcommand !== undefined && !allowed.has(segment.subcommand)) {
			logger.warn(
				{ composeId: compose.composeId, subcommand: segment.subcommand },
				"[VolumeBinding] A compose command was refused: a docker subcommand that is not allowed",
			);
			throw new Error(
				`Compose command refused: \`docker ${segment.kind} ${segment.subcommand}\` is not allowed in a custom command, because it can read or write host paths or reach containers that are not this compose's own. Allowed: ${[...allowed].join(", ")}.`,
			);
		}
		if (segment.watchOption !== undefined) {
			throw new Error(
				`Compose command refused: \`docker compose up ${segment.watchOption}\` syncs host paths named in the compose file into the containers, which is not allowed in a custom command.`,
			);
		}
		if (segment.outputOption !== undefined) {
			throw new Error(
				`Compose command refused: \`docker compose config ${segment.outputOption}\` writes a file to a path of the command's choosing, which is not allowed in a custom command.`,
			);
		}
	}
	const codeDirectory = getCodeDirectory(compose);
	for (const segment of segments) {
		const baseDirs = [
			codeDirectory,
			...segment.projectDirectories.map((directory) =>
				posix.resolve(codeDirectory, directory),
			),
		];
		const options: Array<[string, string[]]> = [
			["--project-directory", segment.projectDirectories],
			["--env-file", segment.envFiles],
			["--env-from-file", segment.envFromFiles],
			["compose file", segment.files],
		];
		for (const [name, values] of options) {
			// A project directory that only contains the storage (`/`) is
			// harmless unless a relative bind lands in it, which the bind rule
			// refuses; a file option must not lead there at all.
			const value = values.find((candidate) => {
				const reach = dockerVolumesDirectoryReach(candidate, baseDirs);
				return name === "--project-directory"
					? reach === "inside"
					: reach !== null;
			});
			if (value !== undefined) {
				logger.warn(
					{ composeId: compose.composeId, option: name, value },
					"[VolumeBinding] A compose command was refused: a path option that leads into Docker's volume storage",
				);
				throw new Error(
					`Compose command refused: the ${name} "${value}" is Docker's own volume storage (/var/lib/docker/volumes) or a directory that contains it, which holds every volume on the host. Use a path of the compose's own.`,
				);
			}
		}
	}
	assertCommandPathsInOwnDirectory(compose, segments, codeDirectory);
};

// Every path a custom command gives Docker must stay in this compose's own
// directory (`<COMPOSE_PATH>/<appName>`, which holds the code directory the
// deploy runs in), for every subcommand, `config`, `pull` and `version`
// included (T-7135). `--env-file <another compose's .env> config` prints that
// compose's secrets interpolated into the file, `pull` sends them to a
// registry in an image name, and a project directory or a compose file in
// another compose's directory reads its `.env`. Paths are resolved like the
// rest of the check: lexically, from the working directory (the code
// directory), the project directories and, for an env file, the directory of
// each compose file; a symlink of the repository is not followed (see
// dockerVolumesDirectoryReach). `~` is the home of the deploy's user, which
// the shell expands, so it is never the compose's own.
const assertCommandPathsInOwnDirectory = (
	compose: ComposeForVolumeCheck,
	segments: CommandSegment[],
	codeDirectory: string,
) => {
	const ownDirectory = posix.dirname(codeDirectory);
	const isOwn = (path: string) =>
		path === ownDirectory || path.startsWith(`${ownDirectory}/`);
	const readings = (path: string, bases: string[]) =>
		posix.isAbsolute(path)
			? [posix.normalize(path)]
			: bases.map((base) => posix.resolve(base, path));
	for (const segment of segments) {
		const projectDirectories = segment.projectDirectories.map((directory) =>
			posix.resolve(codeDirectory, directory),
		);
		const fileBases = [codeDirectory, ...projectDirectories];
		const envBases = [
			...fileBases,
			...segment.files.flatMap((file) =>
				readings(file, fileBases).map((path) => posix.dirname(path)),
			),
		];
		const options: Array<[string, string[], string[]]> = [
			[
				"--project-directory / --workdir",
				segment.projectDirectories,
				[codeDirectory],
			],
			["compose file", segment.files, fileBases],
			["--env-file", segment.envFiles, envBases],
			["--env-from-file", segment.envFromFiles, envBases],
		];
		for (const [name, values, bases] of options) {
			const value = values.find(
				(candidate) =>
					candidate.startsWith("~") || !readings(candidate, bases).every(isOwn),
			);
			if (value !== undefined) {
				logger.warn(
					{ composeId: compose.composeId, option: name },
					"[VolumeBinding] A compose command was refused: a path option outside the compose's own directory",
				);
				throw new Error(
					`Compose command refused: the ${name} "${value}" is outside this compose's own directory (${ownDirectory}), so it could read the files, env files or secrets of another compose. Use a path inside the compose's own code (relative paths are read from ${codeDirectory}).`,
				);
			}
		}
	}
};

// The volumes a custom command adds to `docker compose run` with `-v`.
//
// A line with a glob or a shell operator next to a `run` is refused: the
// shell may turn the glob into other words, so a `-v` could be hidden in or
// after it.
export const getCommandRunVolumes = (
	compose: Pick<ComposeNested, "command" | "composeId">,
) => {
	if (!compose.command) {
		return [];
	}
	const { segments, opaque } = parseComposeCommand(compose.command);
	const runs = segments.filter(
		(segment) => segment.kind === "compose" && segment.subcommand === "run",
	);
	if (runs.length > 0 && opaque) {
		logger.warn(
			{ composeId: compose.composeId },
			"[VolumeBinding] A compose command was refused: a glob or operator next to docker compose run",
		);
		throw new Error(
			"Compose command refused: it runs `docker compose run` next to a shell pattern (`*`, `?`, `[`) or operator that the shell may rewrite, so the volumes it mounts cannot be checked. Write the command without them.",
		);
	}
	const unchecked = runs.flatMap((segment) => segment.uncheckedMounts)[0];
	if (unchecked !== undefined) {
		logger.warn(
			{ composeId: compose.composeId },
			"[VolumeBinding] A compose command was refused: docker compose run with --mount or --volumes-from",
		);
		throw new Error(
			`Compose command refused: \`docker compose run\` uses "${unchecked}", and its mounts cannot be checked. Use -v with a volume of the compose's own instead.`,
		);
	}
	return runs.flatMap((segment) => segment.volumes);
};

// The directories a command makes relative paths of the compose files
// resolve from: `--project-directory`, and the directory of every file it
// names (the project directory defaults to the first file's).
export const getCommandBaseDirectories = (
	compose: ComposeForVolumeCheck & Pick<ComposeNested, "command">,
) => {
	if (!compose.command) {
		return [];
	}
	const codeDirectory = getCodeDirectory(compose);
	const directories = new Set<string>();
	for (const segment of parseComposeCommand(compose.command).segments) {
		const projectDirectories = segment.projectDirectories.map((directory) =>
			posix.resolve(codeDirectory, directory),
		);
		for (const directory of projectDirectories) {
			directories.add(directory);
		}
		for (const file of segment.files) {
			const candidates = posix.isAbsolute(file)
				? [posix.normalize(file)]
				: [codeDirectory, ...projectDirectories].map((base) =>
						posix.resolve(base, file),
					);
			for (const candidate of candidates) {
				directories.add(posix.dirname(candidate));
			}
		}
	}
	return [...directories];
};

// Which docker commands a custom command runs: `docker compose` reads a
// `.env`, `docker stack deploy` does not.
const getCommandKinds = (compose: Pick<ComposeNested, "command">) => {
	const segments = compose.command
		? parseComposeCommand(compose.command).segments
		: [];
	return {
		compose: segments.some((segment) => segment.kind === "compose"),
		stack: segments.some((segment) => segment.kind === "stack"),
		count: segments.length,
	};
};

// A command that names its own `--env-file` replaces the `.env` Dokploy
// writes, so the variables of the compose are not the ones Docker uses.
export const commandUsesEnvFile = (compose: Pick<ComposeNested, "command">) =>
	!!compose.command &&
	parseComposeCommand(compose.command).segments.some(
		(segment) => segment.envFiles.length > 0,
	);

// Compose (compose-go) loads every document of a multi-document YAML file and
// merges them, while the parser used here reads one, so the other documents
// would never be checked: such a file is refused wherever a compose is
// checked (T-7161).
const isMultiDocumentError = (error: unknown) =>
	(error as { code?: unknown } | null)?.code === "MULTIPLE_DOCS";

const multiDocumentError = (what: string) =>
	new Error(
		`Compose refused: ${what} has more than one YAML document (a "---" separator), and Docker Compose merges all of them, so they cannot be checked. Keep a single document in the compose file.`,
	);

// The text of a local override file, which has to be a regular file: it is
// opened without blocking and looked at through the descriptor, so a FIFO or a
// device cannot hang the check or be read, also when it is swapped in after a
// look. A file that is not there is left to the plain read, which reports it.
const readRegularFile = (path: string) => {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return readFileSync(path, "utf8");
		}
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile()) {
			throw new ComposeFileLinkError(COMPOSE_FILE_NOT_REGULAR_MESSAGE);
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
};

// An override file is read like the compose file: only a regular file inside
// the code directory, or the files directory of the compose where the file
// mounts live (`../files/override.yml`), so a link in the repository (or an
// absolute `-f` path) cannot make Dokploy read a file of the host or of
// another compose (T-8413).
const loadOverrideFile = async (
	compose: ComposeForVolumeCheck,
	path: string,
): Promise<Spec> => {
	let text: string;
	try {
		if (compose.serverId) {
			const qPath = quote([path]);
			const { stdout } = await execAsyncRemote(
				compose.serverId,
				getGuardedReadCommand({
					codeDirectory: getCodeDirectory(compose),
					extraDirectory: getFilesDirectory(compose),
					file: path,
					read: `if [ -f ${qPath} ]; then cat ${qPath}; elif [ -e ${qPath} ]; then printf '%s' ${COMPOSE_FILE_NOT_REGULAR_MARKER}; else cat ${qPath}; fi`,
				}),
			);
			if (isComposeFileLinkMarker(stdout)) throw getComposeFileRefusal(stdout);
			text = stdout;
		} else {
			assertComposeFileInsideCodeDirectory(
				getCodeDirectory(compose),
				path,
				getFilesDirectory(compose),
			);
			text = readRegularFile(path);
		}
		return parse(text, { maxAliasCount: 10000, merge: true }) as Spec;
	} catch (error) {
		if (isComposeFileLinkError(error)) {
			logger.warn(
				{ composeId: compose.composeId, path },
				"[VolumeBinding] A compose command was refused: an override file leaves the code directory",
			);
			throw error;
		}
		if (isMultiDocumentError(error)) {
			throw multiDocumentError(
				`the compose file "${path}" a custom command uses`,
			);
		}
		throw new Error(
			`Compose command refused: the compose file "${path}" it uses could not be read, so its volumes cannot be checked.`,
		);
	}
};

// Deploy, redeploy and preview: checks the final compose file (the one
// `writeDomainsToCompose` stages), and the override files of a custom command,
// before anything is built, torn down or started. A file that cannot be
// rendered is left to the render step, which reports it and stops the script
// before any docker command.
export const assertComposeVolumesBound = async (rawCompose: ComposeNested) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	assertCommandRunsComposeOnly(compose);
	const overrideFiles = getCommandOverrideFiles(compose);
	const commandVolumes = getCommandRunVolumes(compose);
	let spec: Awaited<ReturnType<typeof addDomainToCompose>>;
	try {
		spec = await addDomainToCompose(compose, compose.domains);
	} catch (error) {
		if (isMultiDocumentError(error)) {
			throw multiDocumentError("the compose file");
		}
		// A compose file that leads out of the checkout is refused, and the
		// previous release's files are put back by the caller (T-7857).
		if (isComposeFileLinkError(error)) throw error;
		return;
	}
	if (!spec) {
		return;
	}
	const overrides = await Promise.all(
		overrideFiles.map((path) => loadOverrideFile(compose, path)),
	);
	await assertComposeSpecVolumesBound(compose, [spec as Spec, ...overrides], {
		commandVolumes,
		commandBaseDirs: getCommandBaseDirectories(compose),
		customEnvFile: commandUsesEnvFile(compose),
		hasCommand: !!compose.command,
		commandKinds: getCommandKinds(compose),
	});
	// Last, so that a command that also breaks a volume or path rule is refused
	// for that one first.
	assertCommandActsOnOwnProject(compose, [spec as Spec, ...overrides]);
};

// The compose file on disk as text, or null when there is none (then `up -d`
// has nothing to start either). Anything else that goes wrong reading it
// throws: the file is not checked, so it must not be started.
const readComposeFileOnDisk = async (compose: ComposeNested) => {
	const path = getComposePath(compose);
	try {
		if (compose.serverId) {
			const { stdout } = await execAsyncRemote(
				compose.serverId,
				getGuardedReadCommand({
					codeDirectory: getComposeCodeDirectory(compose),
					file: path,
					read: `if [ -f ${quote([path])} ]; then cat ${quote([path])}; fi`,
				}),
			);
			// A link out of the checkout is a refusal of its own (T-7857).
			if (isComposeFileLinkMarker(stdout)) throw getComposeFileRefusal(stdout);
			return stdout ? stdout : null;
		}
		return await readComposeFile(compose);
	} catch (error) {
		if (isComposeFileLinkError(error)) throw error;
		throw new Error(
			"Compose refused: the compose file on disk could not be read, so it cannot be checked before it is started. Redeploy the compose.",
		);
	}
};

// Start (`docker compose up -d` from the files on disk): checks the compose
// file that is there, which is already the final one of the last deploy. A file
// that cannot be parsed is refused, not skipped: Compose may read what this
// parser does not.
export const assertComposeFileOnDiskVolumesBound = async (
	rawCompose: ComposeNested,
) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	const text = await readComposeFileOnDisk(compose);
	if (text === null) {
		return;
	}
	let spec: unknown;
	try {
		spec = parse(text, { maxAliasCount: 10000, merge: true });
	} catch (error) {
		if (isMultiDocumentError(error)) {
			throw multiDocumentError("the compose file on disk");
		}
		throw new Error(
			"Compose refused: the compose file on disk is not valid YAML, so it cannot be checked before it is started. Fix the compose file and redeploy.",
		);
	}
	if (!spec || typeof spec !== "object") {
		return;
	}
	await assertComposeSpecVolumesBound(compose, spec as Spec);
};

// Save time, raw compose files only: the text the user typed with the same
// randomize / isolated renames a deploy applies (domain labels do not touch
// volumes), so explicit names, external keys and derived names are the ones
// Docker will see. A deploy checks again.
export const assertComposeFileVolumesBound = async (
	compose: ComposeForVolumeCheck,
	composeFile: string,
) => {
	let spec: unknown;
	try {
		spec = parse(composeFile, { maxAliasCount: 10000, merge: true });
	} catch (error) {
		if (isMultiDocumentError(error)) {
			throw multiDocumentError("the compose file");
		}
		// Not valid YAML: nothing deploys from it, and the editor reports it.
		return;
	}
	if (!spec || typeof spec !== "object") {
		return;
	}
	let renamed = spec as ComposeSpecification;
	if (compose.isolatedDeployment) {
		renamed = randomizeDeployableSpecificationFile(
			renamed,
			compose.isolatedDeploymentsVolume,
			compose.suffix || compose.appName,
		);
	} else if (compose.randomize) {
		renamed = randomizeSpecificationFile(renamed, compose.suffix);
	}
	await assertComposeSpecVolumesBound(compose, renamed as Spec);
};
