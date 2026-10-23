import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { ComposeNested } from "@dokploy/server/utils/builders/compose";
import { randomizeDeployableSpecificationFile } from "@dokploy/server/utils/docker/collision";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	addDomainToCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@dokploy/server/utils/docker/domain";
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
			const written = getEnvironmentVariablesObject(
				compose.env ?? "",
				projectEnv,
				environmentEnv,
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
			written[key] = value;
		}
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
// A symlink is followed, as Compose follows it. The local file is opened
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
				`if [ -f ${quoted} ]; then if command -v timeout >/dev/null 2>&1; then timeout 10 ${read}; else ${read}; fi; elif [ -e ${quoted} ]; then exit 3; fi`,
			);
			return Buffer.byteLength(stdout) > MAX_DOTENV_BYTES ? null : stdout;
		}
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
			const buffer = Buffer.alloc(MAX_DOTENV_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return bytesRead > MAX_DOTENV_BYTES
				? null
				: buffer.toString("utf8", 0, bytesRead);
		} finally {
			await handle.close();
		}
	} catch {
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
		commandKinds: { compose: boolean; stack: boolean };
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
	};
	for (const resolution of resolutions) {
		for (const use of resolution.uses) {
			uses.set(`${use.key}\u0000${use.volumeName}`, use);
		}
		for (const name of [
			"unresolved",
			"forbidden",
			"forbiddenParents",
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
		commandKinds = { compose: false, stack: false },
	}: {
		commandVolumes?: string[];
		commandBaseDirs?: string[];
		customEnvFile?: boolean;
		hasCommand?: boolean;
		// Which docker commands a custom command runs.
		commandKinds?: { compose: boolean; stack: boolean };
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
	const { uses, unresolved, forbidden, forbiddenParents } = mergeResolutions(
		worlds.map((world) =>
			resolveComposeFilesMountedVolumes(
				Array.isArray(specs) ? specs : [specs],
				{
					appName: compose.appName,
					env: world.env,
					strict: world.strict,
					baseDirs,
					commandVolumes,
				},
			),
		),
	);
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

// `docker compose` options that take a value, before the subcommand.
const COMPOSE_OPTIONS_WITH_VALUE = new Set([
	"-f",
	"--file",
	"-p",
	"--project-name",
	"--env-file",
	"--project-directory",
	"--profile",
	"--parallel",
	"--ansi",
	"--progress",
]);

// The subcommands that create containers from the compose files.
const FILE_READING_SUBCOMMANDS = new Set(["up", "run", "create"]);

type CommandSegment = {
	kind: "compose" | "stack" | "other";
	subcommand?: string;
	files: string[];
	projectDirectories: string[];
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
			if (!word.includes("=") && RUN_AND_EXEC_LONG_OPTIONS_WITH_VALUE.has(name)) {
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
				let i = start + 1;
				for (; i < words.length; ) {
					const word = words[i] as string;
					if (word.startsWith("--") && word.includes("=")) {
						const [name, ...rest] = word.split("=");
						if (name === "--file") {
							files.push(rest.join("="));
						} else if (name === "--project-directory") {
							projectDirectories.push(rest.join("="));
						} else if (name === "--env-file") {
							envFiles.push(rest.join("="));
						}
						i += 1;
					} else if (COMPOSE_OPTIONS_WITH_VALUE.has(word)) {
						const value = words[i + 1];
						if (value !== undefined) {
							if (word === "-f" || word === "--file") {
								files.push(value);
							} else if (word === "--project-directory") {
								projectDirectories.push(value);
							} else if (word === "--env-file") {
								envFiles.push(value);
							}
						}
						i += 2;
					} else if (/^-f.+/.test(word)) {
						files.push(shortOptionValue(word));
						i += 1;
					} else if (word.startsWith("-")) {
						i += 1;
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
				return {
					kind: "stack",
					subcommand,
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
// command that starts containers without naming a file would make Docker find
// a compose file (or an override) in the project directory by itself.
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
		const startsContainers =
			(segment.kind === "compose" &&
				segment.subcommand !== undefined &&
				FILE_READING_SUBCOMMANDS.has(segment.subcommand)) ||
			(segment.kind === "stack" && segment.subcommand === "deploy");
		if (!startsContainers) {
			continue;
		}
		if (segment.files.length === 0) {
			logger.warn(
				{ composeId: compose.composeId },
				"[VolumeBinding] A compose command was refused: it names no compose file",
			);
			throw new Error(
				`Compose command refused: it starts containers without naming a compose file, so Docker would pick one from the project directory and its volumes would not be checked. Pass "-f ${compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath}" (or "-c" for a stack).`,
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
	};
};

// A command that names its own `--env-file` replaces the `.env` Dokploy
// writes, so the variables of the compose are not the ones Docker uses.
export const commandUsesEnvFile = (compose: Pick<ComposeNested, "command">) =>
	!!compose.command &&
	parseComposeCommand(compose.command).segments.some(
		(segment) => segment.envFiles.length > 0,
	);

const loadOverrideFile = async (
	compose: ComposeForVolumeCheck,
	path: string,
): Promise<Spec> => {
	let text: string;
	try {
		if (compose.serverId) {
			const { stdout } = await execAsyncRemote(
				compose.serverId,
				`cat ${quote([path])}`,
			);
			text = stdout;
		} else {
			text = readFileSync(path, "utf8");
		}
		return parse(text, { maxAliasCount: 10000, merge: true }) as Spec;
	} catch {
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
	} catch {
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
};

// Start (`docker compose up -d` from the files on disk): checks the compose
// file that is there, which is already the final one of the last deploy.
export const assertComposeFileOnDiskVolumesBound = async (
	rawCompose: ComposeNested,
) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	let spec: Awaited<ReturnType<typeof loadDockerCompose>>;
	try {
		spec = compose.serverId
			? await loadDockerComposeRemote(compose)
			: await loadDockerCompose(compose);
	} catch {
		// Nothing readable on disk: `up -d` has nothing to start either.
		return;
	}
	if (!spec) {
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
	} catch {
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
