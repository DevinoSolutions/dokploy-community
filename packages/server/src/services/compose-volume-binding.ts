import { readFileSync } from "node:fs";
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
import {
	getEnvironmentVariablesObject,
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "@dokploy/server/utils/docker/utils";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { withResolvedVaultRefs } from "@dokploy/server/utils/vault";
import {
	type ComposeVariables,
	resolveComposeFilesMountedVolumes,
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
// reads whatever `.env` sits next to the file, which Dokploy cannot see, so no
// variable is trusted then (`strict`).
//
// The two kinds differ on a variable that is set to an empty string:
// - docker compose reads it from the `.env` as set-but-empty, which
//   `${A-x}` and `${A+x}` tell apart from unset, so empty values are kept;
// - a stack's staged env file leaves a variable without a value out
//   (buildStackEnvFileContent), so for a stack it is unset.
// The deploy shell's own variables are set but unknown: PATH and HOME for
// docker compose (the process environment wins over the `.env`), and the
// shell's PWD and the like for a stack.
const getInterpolationVariables = (
	compose: ComposeForVolumeCheck,
): { env: ComposeVariables; strict: boolean } => {
	const isStack = compose.composeType === "stack";
	if (!isStack && !compose.createEnvFile) {
		return { env: {}, strict: true };
	}
	try {
		const projectEnv = compose.environment.project.env;
		const environmentEnv = compose.environment.env;
		if (isStack) {
			const env = getEnvironmentVariablesObject(
				compose.env ?? "",
				projectEnv,
				environmentEnv,
			);
			for (const name of ["PATH", "HOME", "PWD", "OLDPWD", "SHLVL", "_"]) {
				if (!Object.hasOwn(env, name)) {
					env[name] = UNKNOWN_VARIABLE_VALUE;
				}
			}
			return { env, strict: false };
		}
		const content = `APP_NAME=${compose.appName}\nCOMPOSE_PROJECT_NAME=${compose.appName}\n${compose.env ?? ""}${
			compose.randomize ? `\nCOMPOSE_PREFIX=${compose.suffix}` : ""
		}`;
		const env: Record<string, string> = {};
		for (const pair of prepareEnvironmentVariables(
			content,
			projectEnv,
			environmentEnv,
		)) {
			const [key, value] = parseEnvironmentKeyValuePair(pair);
			env[key] = value;
		}
		env.PATH = UNKNOWN_VARIABLE_VALUE;
		env.HOME = UNKNOWN_VARIABLE_VALUE;
		return { env, strict: false };
	} catch {
		// Unresolved references: the variables are not known.
		return { env: null, strict: true };
	}
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
) => {
	const { env, strict } = getInterpolationVariables(compose);
	const codeDirectory = getCodeDirectory(compose);
	const composeFile =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	const { uses, unresolved, forbidden } = resolveComposeFilesMountedVolumes(
		Array.isArray(specs) ? specs : [specs],
		{
			appName: compose.appName,
			env,
			strict,
			baseDirs: [
				codeDirectory,
				posix.dirname(posix.resolve(codeDirectory, composeFile || ".")),
			],
		},
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
	if (unresolved.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, unresolved },
			"[VolumeBinding] A compose file volume was refused: it could not be resolved",
		);
		const hint =
			strict && compose.composeType !== "stack"
				? `Dokploy does not write a .env for this compose ("Create env file" is off), so its variables cannot be resolved: turn on "Create env file", or write the volume names out in the compose file.`
				: "Write the volume names out in the compose file.";
		throw new Error(
			`Compose volume check failed: ${unresolved[0]} cannot be resolved before the deploy, so the volumes it uses cannot be checked. ${hint} Keep the volumes in the one compose file (no include, no extends from another file, no volumes_from a container).`,
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
};

// pflag reads `-f=path` and `-fpath` as the path.
const shortOptionValue = (word: string) => word.slice(2).replace(/^=/, "");

// A custom command replaces the generated one, but it is still `docker
// <command>` chained with `docker compose ...` commands (sanitizeCommand).
// A compose file argument is only one in the global options before the
// subcommand (`rm -f` is not a file), `-c` only for `docker stack`, and the
// options of `docker` itself (`-H x`, `--context x`, ...) come first.
const parseComposeCommand = (command: string): CommandSegment[] => {
	const segments: string[][] = [[]];
	for (const token of parseShell(command)) {
		if (typeof token === "string") {
			segments[segments.length - 1]?.push(token);
		} else {
			segments.push([]);
		}
	}
	return segments
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
			const command = words[start];
			if (command === "compose") {
				let subcommand: string | undefined;
				for (let i = start + 1; i < words.length; ) {
					const word = words[i] as string;
					if (word.startsWith("--") && word.includes("=")) {
						const [name, ...rest] = word.split("=");
						if (name === "--file") {
							files.push(rest.join("="));
						} else if (name === "--project-directory") {
							projectDirectories.push(rest.join("="));
						}
						i += 1;
					} else if (COMPOSE_OPTIONS_WITH_VALUE.has(word)) {
						const value = words[i + 1];
						if (value !== undefined) {
							if (word === "-f" || word === "--file") {
								files.push(value);
							} else if (word === "--project-directory") {
								projectDirectories.push(value);
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
				return { kind: "compose", subcommand, files, projectDirectories };
			}
			if (command === "stack") {
				const rest = words.slice(start + 1);
				const subcommand = rest.find((word) => !word.startsWith("-"));
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
				return { kind: "stack", subcommand, files, projectDirectories };
			}
			return { kind: "other", files, projectDirectories };
		});
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
	for (const segment of parseComposeCommand(compose.command)) {
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
	const overrideFiles = getCommandOverrideFiles(compose);
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
	await assertComposeSpecVolumesBound(compose, [spec as Spec, ...overrides]);
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
