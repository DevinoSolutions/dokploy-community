import { posix } from "node:path";

// The Docker volume names a compose file really mounts, worked out from the
// YAML Dokploy deploys (T-6822). A compose file can name any volume on the
// host: a top-level entry with `external: true` or an explicit `name:` is used
// as is, so `name: <someone else's volume>` mounts it. Only the default,
// `<project>_<key>`, is the compose's own.
//
// From the compose spec and the docker CLI:
// - `external: true` (or the older `external: { name }`): the volume is not
//   created or scoped; its name is `name:` when given, else the key;
// - `name:` without `external`: the name is used as is, not scoped with the
//   project name;
// - anything else: `<project>_<key>`. `docker compose -p <appName>` sets the
//   project name and `docker stack deploy <appName>` the stack namespace, so
//   both prefix with the compose appName (`compose-go` lowercases a project
//   name and drops characters outside [a-z0-9_-], so both spellings are
//   returned when they differ);
// - isolatedDeployment and randomize only rename keys (`<key>-<suffix>`), so
//   the final YAML is what has to be resolved, not the one the user typed.
// Bind mounts (host paths), tmpfs and anonymous volumes are not named volumes,
// except that a bind of Docker's own volume directory is refused (see
// reachesDockerVolumesDirectory).

export type ComposeVariables = Record<string, string> | null;

type InterpolationOptions = {
	// Variables Dokploy writes for the deploy. null: unknown.
	env: ComposeVariables;
	// Variables may also come from a file Dokploy does not see (a `.env`
	// committed to the repository), so no variable can be trusted.
	strict?: boolean;
};

const VARIABLE =
	/\$(?:\$|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])((?:[^{}]|\{[^{}]*\})*))?\})/g;
const ESCAPED_DOLLAR = "\u0000";

// The value of a variable that is set at deploy time but that Dokploy cannot
// know (PATH and HOME of the deploy shell). A value that contains it cannot be
// resolved; `${HOME+x}` and `${HOME:-x}` still see the variable as set.
export const UNKNOWN_VARIABLE_VALUE = "\u0001";

// Compose's `${VAR}`, `$VAR`, `${VAR:-default}`, `${VAR-default}`,
// `${VAR:+alt}`, `${VAR+alt}`, `${VAR:?err}` and `$$`. null means the value
// cannot be known from here (a variable Dokploy does not provide, an error
// form or invalid syntax), so the caller has to refuse it.
export const interpolateComposeValue = (
	value: string,
	{ env, strict = false }: InterpolationOptions,
): string | null => {
	if (!value.includes("$")) {
		return value;
	}
	let unresolved = false;
	const substitute = (text: string) => {
		const result = interpolateComposeValue(text, { env, strict });
		if (result === null) {
			unresolved = true;
			return "";
		}
		return result;
	};
	const result = value.replace(
		VARIABLE,
		(match, bare?: string, braced?: string, operator?: string, arg = "") => {
			if (match === "$$") {
				return ESCAPED_DOLLAR;
			}
			if (!env || strict) {
				unresolved = true;
				return "";
			}
			const key = (bare ?? braced) as string;
			const current = Object.hasOwn(env, key) ? env[key] : undefined;
			const isSet = current !== undefined;
			const isNonEmpty = isSet && current !== "";
			switch (operator) {
				case undefined:
					return current ?? "";
				case ":-":
					return isNonEmpty ? (current as string) : substitute(arg);
				case "-":
					return isSet ? (current as string) : substitute(arg);
				case ":+":
					return isNonEmpty ? substitute(arg) : "";
				case "+":
					return isSet ? substitute(arg) : "";
				case ":?":
					if (isNonEmpty) return current as string;
					unresolved = true;
					return "";
				default:
					if (isSet) return current as string;
					unresolved = true;
					return "";
			}
		},
	);
	if (
		unresolved ||
		result.includes("$") ||
		result.includes(UNKNOWN_VARIABLE_VALUE)
	) {
		return null;
	}
	return result.replaceAll(ESCAPED_DOLLAR, "$");
};

// What `docker compose -p <name>` makes of a project name (compose-go
// `NormalizeProjectName`).
export const normalizeComposeProjectName = (name: string) =>
	name.toLowerCase().replace(/[^-_a-z0-9]+/g, "");

export type ComposeVolumeUse = {
	// The top-level key the services reference.
	key: string;
	// The Docker volume name the key ends up as.
	volumeName: string;
	// The name is `<project>_<key>`: the compose's own default.
	derived: boolean;
};

export type ComposeVolumeResolution = {
	uses: ComposeVolumeUse[];
	// Things the effective volume cannot be worked out for (an unresolved
	// variable in a name or in a service's volume source).
	unresolved: string[];
	// Mounts of Docker's own volume storage directory, by path.
	forbidden: string[];
};

type LooseSpec = {
	include?: unknown;
	services?: Record<string, unknown> | null;
	volumes?: Record<string, unknown> | null;
} | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

// Long-syntax types that are not named volumes.
const NON_VOLUME_TYPES = new Set(["tmpfs", "npipe", "cluster", "image"]);

const isFilePathSource = (source: string) =>
	/^[./~]/.test(source) || /^[A-Za-z]:/.test(source);

// Docker keeps every local volume's data here. A bind mount of this directory
// (or of a path under it) is a named volume by another name.
const DOCKER_VOLUMES_DIRECTORY = "/var/lib/docker/volumes";

// `baseDirs` are the directories a relative path may be resolved from; a
// path is also resolved from `/`, so a `..` chain cannot hide it. `~` is the
// home of an unknown user.
export const reachesDockerVolumesDirectory = (
	path: string,
	baseDirs: string[] = [],
) => {
	const normalized = path.replace(/\\/g, "/");
	const homes = ["/root", "/home/user/a"];
	const candidates = normalized.startsWith("~")
		? ["/", ...homes].map((base) =>
				posix.resolve(base, `.${normalized.slice(1)}`),
			)
		: ["/", ...baseDirs].map((base) => posix.resolve(base, normalized));
	return candidates.some(
		(candidate) =>
			candidate === DOCKER_VOLUMES_DIRECTORY ||
			candidate.startsWith(`${DOCKER_VOLUMES_DIRECTORY}/`),
	);
};

// An empty value is not a boolean: Docker fails on it.
const FALSE_VALUES = new Set(["false", "0", "f", "n", "no", "off"]);
const TRUE_VALUES = new Set(["true", "1", "t", "y", "yes", "on"]);

type ResolveOptions = {
	appName: string;
	// Where a relative bind source may be resolved from.
	baseDirs?: string[];
} & InterpolationOptions;

type MountedKeys = {
	keys: Set<string>;
	unresolved: string[];
	forbidden: string[];
	anyKey: boolean;
};

// The top-level keys the services mount by name, plus what cannot be checked.
const collectMounts = (
	services: Record<string, unknown>,
	options: ResolveOptions,
	into: MountedKeys,
) => {
	const checkPath = (rawPath: string, what: string) => {
		const path = interpolateComposeValue(rawPath, options);
		if (path === null) {
			return;
		}
		if (path && reachesDockerVolumesDirectory(path, options.baseDirs)) {
			into.forbidden.push(`${what} "${rawPath}"`);
		}
	};
	const addSource = (rawSource: string) => {
		const source = interpolateComposeValue(rawSource, options);
		if (source === null) {
			// It can name any declared volume, or a path.
			into.anyKey = true;
			return;
		}
		if (!source) {
			return;
		}
		if (isFilePathSource(source)) {
			checkPath(source, "bind mount");
			return;
		}
		into.keys.add(source);
	};
	for (const [serviceName, service] of Object.entries(services)) {
		if (!isRecord(service)) {
			continue;
		}
		// `volumes_from: container:<name>` mounts every volume of any container
		// on the host, and `extends.file` reads a file the check cannot see.
		if (Array.isArray(service.volumes_from)) {
			for (const entry of service.volumes_from) {
				if (typeof entry === "string" && entry.startsWith("container:")) {
					into.unresolved.push(
						`service "${serviceName}" (volumes_from a container)`,
					);
				}
			}
		}
		if (isRecord(service.extends) && service.extends.file) {
			into.unresolved.push(
				`service "${serviceName}" (extends from another file)`,
			);
		}
		const volumes = service.volumes;
		if (!Array.isArray(volumes)) {
			continue;
		}
		for (const entry of volumes) {
			if (typeof entry === "string") {
				// `[SOURCE:]TARGET[:MODE]`: without a colon it is an anonymous volume.
				const separator = entry.indexOf(":");
				if (separator > 0) {
					addSource(entry.slice(0, separator));
				}
			} else if (isRecord(entry)) {
				const type = typeof entry.type === "string" ? entry.type : "";
				if (NON_VOLUME_TYPES.has(type)) {
					continue;
				}
				if (typeof entry.source === "string" && entry.source) {
					if (type === "bind") {
						checkPath(entry.source, "bind mount");
					} else {
						addSource(entry.source);
					}
				}
			}
		}
	}
};

// The volume names a set of compose files (the file Dokploy deploys plus the
// override files of a custom command) mounts. A key is checked with the
// definition of every file that declares it, because the merge order of the
// definitions is not worth reproducing.
export const resolveComposeFilesMountedVolumes = (
	specs: LooseSpec[],
	options: ResolveOptions,
): ComposeVolumeResolution => {
	const uses: ComposeVolumeUse[] = [];
	const unresolved: string[] = [];
	const forbidden: string[] = [];
	const mounted: MountedKeys = {
		keys: new Set<string>(),
		unresolved,
		forbidden,
		anyKey: false,
	};
	for (const spec of specs) {
		if (spec?.include) {
			unresolved.push("include (volumes from another file)");
		}
		if (spec && isRecord(spec.services)) {
			collectMounts(spec.services, options, mounted);
		}
	}
	const definitionSets = specs.map((spec) =>
		spec && isRecord(spec.volumes) ? spec.volumes : {},
	);
	if (mounted.anyKey) {
		for (const definitions of definitionSets) {
			for (const key of Object.keys(definitions)) {
				mounted.keys.add(key);
			}
		}
	}
	const prefixes = [
		...new Set([options.appName, normalizeComposeProjectName(options.appName)]),
	];

	const seen = new Set<string>();
	const addUse = (use: ComposeVolumeUse) => {
		const id = `${use.key}\u0000${use.volumeName}`;
		if (!seen.has(id)) {
			seen.add(id);
			uses.push(use);
		}
	};

	for (const key of mounted.keys) {
		// A key that is not declared makes compose fail on its own.
		const declaring = definitionSets.filter((definitions) =>
			Object.hasOwn(definitions, key),
		);
		for (const definitions of declaring) {
			const definition = isRecord(definitions[key]) ? definitions[key] : {};

			const device = isRecord(definition.driver_opts)
				? definition.driver_opts.device
				: undefined;
			if (typeof device === "string" && device) {
				const resolvedDevice = interpolateComposeValue(device, options);
				if (resolvedDevice === null) {
					unresolved.push(`volume "${key}"`);
					continue;
				}
				if (
					isFilePathSource(resolvedDevice) &&
					reachesDockerVolumesDirectory(resolvedDevice, options.baseDirs)
				) {
					forbidden.push(`volume "${key}" (device "${device}")`);
					continue;
				}
			}

			// `external` may be a boolean, a string that Docker reads as one (also
			// from a variable, in any case) or the older `{ name }` object.
			let external = false;
			let legacyName: unknown;
			if (isRecord(definition.external)) {
				external = true;
				legacyName = definition.external.name;
			} else if (typeof definition.external === "boolean") {
				external = definition.external;
			} else if (
				typeof definition.external === "string" ||
				typeof definition.external === "number"
			) {
				const text = interpolateComposeValue(
					String(definition.external),
					options,
				);
				if (text === null) {
					unresolved.push(`volume "${key}"`);
					continue;
				}
				const normalized = text.trim().toLowerCase();
				if (TRUE_VALUES.has(normalized)) {
					external = true;
				} else if (!FALSE_VALUES.has(normalized)) {
					unresolved.push(`volume "${key}"`);
					continue;
				}
			}

			let rawName: unknown = definition.name;
			if (external && !rawName) {
				rawName = legacyName;
			}
			if (rawName !== undefined && rawName !== null && rawName !== "") {
				if (typeof rawName !== "string") {
					unresolved.push(`volume "${key}"`);
					continue;
				}
				const name = interpolateComposeValue(rawName, options);
				if (name === null || !name) {
					unresolved.push(`volume "${key}"`);
					continue;
				}
				addUse({ key, volumeName: name, derived: false });
				continue;
			}
			if (external) {
				addUse({ key, volumeName: key, derived: false });
				continue;
			}
			for (const prefix of prefixes) {
				addUse({ key, volumeName: `${prefix}_${key}`, derived: true });
			}
		}
	}
	return { uses, unresolved, forbidden };
};

export const resolveComposeMountedVolumes = (
	spec: LooseSpec,
	options: ResolveOptions,
): ComposeVolumeResolution =>
	resolveComposeFilesMountedVolumes([spec], options);
