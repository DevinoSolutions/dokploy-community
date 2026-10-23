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
// except that a bind of Docker's own volume directory, or of a directory that
// contains it (`/`, `/var`, `/var/lib`, `/var/lib/docker`), is refused (see
// dockerVolumesDirectoryReach).

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
		result.includes(UNKNOWN_VARIABLE_VALUE) ||
		result.includes(UNRESOLVED_VARIABLE_VALUE)
	) {
		return null;
	}
	return result.replaceAll(ESCAPED_DOLLAR, "$");
};

// The value of a variable whose own value refers to a variable that cannot be
// followed (see resolveEnvironmentReferences). Unlike an unknown one, its use
// in a bind source is refused.
export const UNRESOLVED_VARIABLE_VALUE = "\u0002";

// Compose expands `$VAR`, `${VAR}` and the default forms inside the values of
// the `.env` it reads, and Dokploy writes the Environment tab as that file.
// This does the same to the map, in file order, so that a value is what
// Docker will use. A reference is followed only to a variable defined EARLIER
// (and to an absent one, which is unset); a reference to a later line, to the
// variable itself (a cycle), or an error form (`${X:?}`) cannot be told from
// here, and makes the whole value UNRESOLVED. The deploy shell's own variables
// (`unknownNames`) are set but unknown: they leave UNKNOWN_VARIABLE_VALUE in
// the text, so the rest of the value is kept. `$$` is a literal `$`.
export const resolveEnvironmentReferences = (
	env: Record<string, string>,
	unknownNames: string[] = [],
): Record<string, string> => {
	const resolved: Record<string, string> = {};
	const expand = (text: string): string =>
		text.replace(
			VARIABLE,
			(match, bare?: string, braced?: string, operator?: string, arg = "") => {
				if (match === "$$") {
					return "$";
				}
				const key = (bare ?? braced) as string;
				if (unknownNames.includes(key)) {
					return UNKNOWN_VARIABLE_VALUE;
				}
				if (Object.hasOwn(resolved, key)) {
					const current = resolved[key] as string;
					switch (operator) {
						case ":-":
							return current ? current : expand(arg);
						case ":+":
							return current ? expand(arg) : "";
						case "+":
							return expand(arg);
						default:
							return current;
					}
				}
				if (Object.hasOwn(env, key)) {
					// Defined on a later line, or this very variable.
					return UNRESOLVED_VARIABLE_VALUE;
				}
				switch (operator) {
					case ":-":
					case "-":
						return expand(arg);
					case ":?":
					case "?":
						return UNRESOLVED_VARIABLE_VALUE;
					default:
						return "";
				}
			},
		);
	for (const [key, value] of Object.entries(env)) {
		const text = expand(value);
		resolved[key] = text.includes(UNRESOLVED_VARIABLE_VALUE)
			? UNRESOLVED_VARIABLE_VALUE
			: text;
	}
	return resolved;
};

// A variable the source names whose value could not be resolved.
const referencesUnresolvedVariable = (
	text: string,
	{ env, strict }: InterpolationOptions,
) =>
	!!env &&
	!strict &&
	[...text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some(
		(match) =>
			Object.hasOwn(env, match[1] as string) &&
			(env[match[1] as string] as string).includes(UNRESOLVED_VARIABLE_VALUE),
	);

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
	// Mounts of Docker's own volume storage directory (or of a path under it),
	// by path.
	forbidden: string[];
	// Mounts of a directory that contains Docker's volume storage (`/`,
	// `/var/lib/docker`, ...), by path.
	forbiddenParents: string[];
};

type LooseSpec = {
	include?: unknown;
	services?: Record<string, unknown> | null;
	volumes?: Record<string, unknown> | null;
	secrets?: Record<string, unknown> | null;
	configs?: Record<string, unknown> | null;
} | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

// Long-syntax types that are not named volumes.
const NON_VOLUME_TYPES = new Set(["tmpfs", "npipe", "cluster", "image"]);

const isFilePathSource = (source: string) =>
	/^[./~]/.test(source) || /^[A-Za-z]:/.test(source);

// Docker keeps every local volume's data here. A bind mount of this directory
// (or of a path under it) is a named volume by another name, and a bind of a
// directory that contains it (`/`, `/var`, `/var/lib`, `/var/lib/docker`)
// reaches every volume as well.
const DOCKER_VOLUMES_DIRECTORY = "/var/lib/docker/volumes";

// `/proc/<pid>/root` and `/proc/<pid>/cwd` are links to the root and the
// working directory of a process, so a bind of one (or of a path under it) is
// a bind of the host's `/` when the process is on the host. They are
// recognised by their shape alone: the check never looks at the host, so any
// other symlink (one that only exists on the host, such as `/srv/docker` ->
// `/var/lib/docker`) cannot be seen from here and is not refused.
const PROC_LINK = /^\/proc\/[^/]+\/(?:task\/[^/]+\/)?(?:root|cwd)$/;

// Walks the segments of a path and looks at every prefix, so that
// `/proc/self/root/..` is seen even though it collapses to `/proc/self`.
const passesThroughProcLink = (path: string) => {
	const stack: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}
		if (segment === "..") {
			stack.pop();
			continue;
		}
		stack.push(segment);
		if (PROC_LINK.test(`/${stack.join("/")}`)) {
			return true;
		}
	}
	return false;
};

export type DockerVolumesReach = "inside" | "parent" | null;

const DOCKER_ROOT_DIRECTORY = "/var/lib/docker";

const reachOfAbsolutePath = (candidate: string): DockerVolumesReach => {
	if (
		candidate === DOCKER_VOLUMES_DIRECTORY ||
		candidate.startsWith(`${DOCKER_VOLUMES_DIRECTORY}/`)
	) {
		return "inside";
	}
	if (
		candidate === "/" ||
		DOCKER_VOLUMES_DIRECTORY.startsWith(`${candidate}/`)
	) {
		return "parent";
	}
	return null;
};

// The absolute paths a bind source can mean, not yet resolved: `inputs` are
// all of them (a relative path also from `/`, so a `..` chain cannot hide
// it), `parentInputs` the ones that count for the parent rule (a relative
// path from `/` is not one: `.` and `..` from `/` would make every relative
// bind of the compose's own directory a bind of `/`). `~` is the home of an
// unknown user.
const bindSourceInputs = (path: string, baseDirs: string[]) => {
	const normalized = path.replace(/\\/g, "/");
	if (normalized.startsWith("~")) {
		const rest = `.${normalized.slice(1)}`;
		const parentInputs = ["/root", "/home/user/a"].map(
			(home) => `${home}/${rest}`,
		);
		return { inputs: [`/${rest}`, ...parentInputs], parentInputs };
	}
	if (posix.isAbsolute(normalized)) {
		return { inputs: [normalized], parentInputs: [normalized] };
	}
	const parentInputs = baseDirs.map((base) => `${base}/${normalized}`);
	return { inputs: [`/${normalized}`, ...parentInputs], parentInputs };
};

// How a bind source relates to Docker's volume storage: "inside" (the
// directory or a path under it), "parent" (a directory that contains it, or a
// `/proc` link to a root), or null. Paths are normalised with POSIX rules
// first (repeated slashes, `.`, `..`, a trailing slash), and "inside" wins.
// `baseDirs` are the directories a relative path may be resolved from: the
// compose's own, and the ones a custom command sets (`--project-directory`).
export const dockerVolumesDirectoryReach = (
	path: string,
	baseDirs: string[] = [],
): DockerVolumesReach => {
	const { inputs, parentInputs } = bindSourceInputs(path, baseDirs);
	if (
		inputs.some(
			(input) => reachOfAbsolutePath(posix.resolve("/", input)) === "inside",
		)
	) {
		return "inside";
	}
	if (
		parentInputs.some(
			(input) =>
				passesThroughProcLink(input) ||
				reachOfAbsolutePath(posix.resolve("/", input)) === "parent",
		)
	) {
		return "parent";
	}
	return null;
};

export const reachesDockerVolumesDirectory = (
	path: string,
	baseDirs: string[] = [],
) => dockerVolumesDirectoryReach(path, baseDirs) !== null;

// Where the first variable of a value that is not an escaped `$$` starts.
const firstVariableIndex = (raw: string) => {
	for (const match of raw.matchAll(VARIABLE)) {
		if (match[0] !== "$$") {
			return match.index;
		}
	}
	return -1;
};

// A source with a `${VAR}` that cannot be resolved can still be known to be
// a problem by what is written before the variable: a path inside Docker's
// volume storage (`/var/lib/docker/volumes/${NAME}/_data`) or Docker's own
// directory (`/var/lib/docker/${NAME}`, which is the storage when NAME is
// `volumes`). Only whole path segments count: `/var/lib/docker/volumes${S}`
// may be another directory. What a variable could add up to elsewhere
// (`/var/lib/${X}`, `${X}`) is not known and not refused here; the caller
// decides what an unresolved source is.
export const unresolvedSourceReachesDockerVolumes = (
	rawSource: string,
	baseDirs: string[] = [],
) => {
	const index = firstVariableIndex(rawSource);
	if (index < 0) {
		return false;
	}
	const written = rawSource.slice(0, index).replaceAll("$$", "$");
	const prefix = written.slice(0, written.lastIndexOf("/") + 1);
	if (!isFilePathSource(prefix)) {
		return false;
	}
	if (dockerVolumesDirectoryReach(prefix, baseDirs) === "inside") {
		return true;
	}
	return bindSourceInputs(prefix, baseDirs).parentInputs.some(
		(input) => posix.resolve("/", input) === DOCKER_ROOT_DIRECTORY,
	);
};

// A `..` segment anywhere in a source that depends on a variable that cannot
// be resolved (`${HOME}/../..`, `${A}${U:-/../..}`, `${X:-${HOME}/..}`):
// the variable can be any directory, and a default can hold the climb, so the
// path can end up anywhere above where it starts. Inside or outside any
// `${...}`, in any default.
export const unresolvedSourceClimbs = (rawSource: string) =>
	/\.\.(?:[/}$]|$)/.test(rawSource);

// The worst case of a source that depends on a variable that cannot be
// resolved: every variable Dokploy knows is replaced by its value, every other
// one by an empty string (or its default), so that a `..` that comes from a
// known variable next to an unknown one (`${HOME}/${UP}`, UP=../..), or is
// put together around one (`.${U}.`), is seen. Nothing is left to the
// resolver, so this never gives up.
const substituteVariables = (
	text: string,
	{ env, strict }: InterpolationOptions,
): string =>
	text.replace(
		VARIABLE,
		(match, bare?: string, braced?: string, operator?: string, arg = "") => {
			if (match === "$$") {
				return "$";
			}
			const key = (bare ?? braced) as string;
			const current =
				env && !strict && Object.hasOwn(env, key) ? env[key] : undefined;
			// A value can hold the marks of the deploy shell's variables or of
			// something unresolved: they count as empty, and a value that is
			// only marks counts as unset.
			const stripped = current
				?.replaceAll(UNKNOWN_VARIABLE_VALUE, "")
				.replaceAll(UNRESOLVED_VARIABLE_VALUE, "");
			const value = stripped === "" && current !== "" ? undefined : stripped;
			const more = () => substituteVariables(arg, { env, strict });
			switch (operator) {
				case ":-":
					return value ? value : more();
				case "-":
					return value ?? more();
				case ":+":
				case "+":
					return more();
				default:
					return value ?? "";
			}
		},
	);

const SOLE_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^${}]*)\}$/;

// The one source with a `..` that is not refused for it: exactly one variable
// with a plain literal default (`${DATA_DIR:-../data}`), nothing before or
// after, no `$` or braces in the default. The default is the path it falls
// back to and is judged with the normal rules, so `${X:-../../..}` that
// reaches `/` is still refused. undefined when the source is not that form.
export const soleDefaultReach = (
	rawSource: string,
	baseDirs: string[] = [],
): DockerVolumesReach | undefined => {
	const fallback = SOLE_DEFAULT.exec(rawSource)?.[1];
	if (fallback === undefined) {
		return undefined;
	}
	return isFilePathSource(fallback)
		? dockerVolumesDirectoryReach(fallback, baseDirs)
		: null;
};

// An empty value is not a boolean: Docker fails on it.
const FALSE_VALUES = new Set(["false", "0", "f", "n", "no", "off"]);
const TRUE_VALUES = new Set(["true", "1", "t", "y", "yes", "on"]);

type ResolveOptions = {
	appName: string;
	// Where a relative bind source may be resolved from.
	baseDirs?: string[];
	// The `-v` / `--volume` values of `docker compose run` commands in a custom
	// command (`SOURCE:TARGET[:MODE]`). They are read as written: the shell
	// has expanded them and Compose does not interpolate command-line values.
	commandVolumes?: string[];
} & InterpolationOptions;

type MountedKeys = {
	keys: Set<string>;
	unresolved: string[];
	forbidden: string[];
	forbiddenParents: string[];
	anyKey: boolean;
};

// Where the source of a short-syntax volume (`SOURCE:TARGET[:MODE]`) ends in
// the text as written: the first colon that is not inside a `${...}`, which
// may hold one (`${DATA:-/srv}:/data`). -1 when there is none.
const shortVolumeSourceEnd = (entry: string) => {
	let depth = 0;
	for (let i = 0; i < entry.length; i++) {
		const character = entry[i];
		if (character === "$" && entry[i + 1] === "$") {
			i += 1;
		} else if (character === "$" && entry[i + 1] === "{") {
			depth += 1;
			i += 1;
		} else if (character === "}" && depth > 0) {
			depth -= 1;
		} else if (character === ":" && depth === 0) {
			return i;
		}
	}
	return -1;
};

type PathChecks = Pick<
	MountedKeys,
	"unresolved" | "forbidden" | "forbiddenParents"
>;

// The checks a host path gets, for a bind source and for the paths of the
// other compose keys that Compose reads from the host (T-7142): where it ends
// up relative to Docker's volume storage once resolved, and what to do with one
// that depends on a variable that cannot be resolved.
const createPathChecks = (options: ResolveOptions, into: PathChecks) => {
	const checkResolvedPath = (path: string, label: string, what: string) => {
		if (!path) {
			return;
		}
		const reach = dockerVolumesDirectoryReach(path, options.baseDirs);
		if (reach === "inside") {
			into.forbidden.push(`${what} "${label}"`);
		} else if (reach === "parent") {
			into.forbiddenParents.push(`${what} "${label}"`);
		}
	};
	// A path that depends on a variable Dokploy does not provide. What is
	// written before the variable may already put it in Docker's volume
	// storage, and a `..` anywhere in it can climb out of anywhere; both are
	// refused, except for a lone variable with a literal default, which is
	// judged as that default. Returns whether it was refused.
	const refuseUnresolvedPath = (rawPath: string, what: string) => {
		if (unresolvedSourceReachesDockerVolumes(rawPath, options.baseDirs)) {
			into.forbidden.push(`${what} "${rawPath}"`);
			return true;
		}
		if (referencesUnresolvedVariable(rawPath, options)) {
			into.unresolved.push(
				`${what} "${rawPath}" (a variable whose value refers to a variable that cannot be followed)`,
			);
			return true;
		}
		const fallback = soleDefaultReach(rawPath, options.baseDirs);
		if (fallback === "inside") {
			into.forbidden.push(`${what} "${rawPath}"`);
			return true;
		}
		if (fallback === "parent") {
			into.forbiddenParents.push(`${what} "${rawPath}"`);
			return true;
		}
		if (
			fallback === undefined &&
			(unresolvedSourceClimbs(rawPath) ||
				substituteVariables(rawPath, options).split("/").includes(".."))
		) {
			into.unresolved.push(
				`${what} "${rawPath}" (a ".." in a path that depends on a variable)`,
			);
			return true;
		}
		return false;
	};
	const checkPath = (rawPath: string, what: string) => {
		const path = interpolateComposeValue(rawPath, options);
		if (path === null) {
			refuseUnresolvedPath(rawPath, what);
			return;
		}
		checkResolvedPath(path, rawPath, what);
	};
	return { checkResolvedPath, refuseUnresolvedPath, checkPath };
};

// The top-level keys the services mount by name, plus what cannot be checked.
const collectMounts = (
	services: Record<string, unknown>,
	options: ResolveOptions,
	into: MountedKeys,
) => {
	const { checkResolvedPath, refuseUnresolvedPath, checkPath } =
		createPathChecks(options, into);
	const addResolvedSource = (source: string, label: string) => {
		if (!source) {
			return;
		}
		if (isFilePathSource(source)) {
			checkResolvedPath(source, label, "bind mount");
			return;
		}
		into.keys.add(source);
	};
	// `cutAtColon`: a short-syntax source is the part before the first colon
	// of the interpolated text, which a variable can bring.
	const addSource = (rawSource: string, cutAtColon = false) => {
		const source = interpolateComposeValue(rawSource, options);
		if (source === null) {
			// It can name any declared volume, or a path. Besides what
			// refuseUnresolvedPath refuses, it is not refused for being unresolved,
			// unlike a volume name or an `external` value: a service source that is
			// a path (`${DATA_DIR}:/data`) is common and cannot be told from a
			// name, so every declared volume is checked instead.
			if (!refuseUnresolvedPath(rawSource, "bind mount")) {
				into.anyKey = true;
			}
			return;
		}
		const colon = cutAtColon ? source.indexOf(":") : -1;
		addResolvedSource(colon >= 0 ? source.slice(0, colon) : source, rawSource);
	};
	// Compose interpolates the whole entry and splits it after that, so a
	// variable can bring the colon (`${X:-/:/h}`, `${VOL}` with VOL=/:/h).
	const addShortEntry = (entry: string) => {
		const end = shortVolumeSourceEnd(entry);
		const label = end >= 0 ? entry.slice(0, end) : entry;
		const resolved = interpolateComposeValue(entry, options);
		if (resolved !== null) {
			// `[SOURCE:]TARGET[:MODE]`: without a colon it is an anonymous volume.
			const colon = resolved.indexOf(":");
			if (colon > 0) {
				addResolvedSource(resolved.slice(0, colon), label);
			}
			return;
		}
		if (end < 0) {
			// Nothing but text that depends on a variable Dokploy does not
			// provide, and no colon written: it can be a whole `SOURCE:TARGET`.
			into.unresolved.push(`volume "${entry}"`);
			return;
		}
		if (end > 0) {
			addSource(entry.slice(0, end), true);
		}
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
				addShortEntry(entry);
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

// A build context Compose hands to the builder as it is instead of reading it
// from the host (compose-go `isRemoteContext`, case-sensitive): a git or http(s)
// URL. The rest of a value is a path of the host. A remote-looking value is not
// trusted blindly: Compose keeps it as written (`github.com/../../x`,
// `https://x/../..`), and a directory of that name in the build tree makes it a
// local path, so one with a `..` segment is checked as a path too.
const REMOTE_BUILD_CONTEXT =
	/^(?:https?:\/\/|git:\/\/|ssh:\/\/|github\.com\/|git@)/;

// An `additional_contexts` value that names no host path either: another
// service's build or an image.
const BUILDER_REFERENCE = /^(?:service:|docker-image:\/\/)/;

const OCI_LAYOUT = "oci-layout://";
const FILE_SCHEME = "file://";

const HAS_CLIMB = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

// The fields of a `cache_from` / `cache_to` entry, read like buildx does (CSV:
// quotes and `""`), with the keys and values trimmed and the keys lowercased.
// A quote is taken wherever it stands, so a malformed entry is read as the most
// paths it could mean.
const parseCacheFields = (entry: string) => {
	const fields: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < entry.length; i++) {
		const character = entry[i] as string;
		if (character === '"') {
			if (quoted && entry[i + 1] === '"') {
				current += '"';
				i += 1;
			} else {
				quoted = !quoted;
			}
		} else if (character === "," && !quoted) {
			fields.push(current);
			current = "";
		} else {
			current += character;
		}
	}
	fields.push(current);
	return fields.map((field) => {
		const separator = field.indexOf("=");
		return separator < 0
			? { key: field.trim().toLowerCase(), value: "" }
			: {
					key: field.slice(0, separator).trim().toLowerCase(),
					// Quotes left around a value (`""x""`) are not part of a path, but are
					// not trusted to be a different one.
					value: field
						.slice(separator + 1)
						.trim()
						.replace(/^"+|"+$/g, ""),
				};
	});
};

// Compose reads these keys of a service and of the top level from the HOST
// (T-7142), resolved from the project directory, so the paths get the same
// rules as the source of a bind mount:
// - `build.context`, `build.additional_contexts` and a `build.dockerfile` that
//   leaves the context, `build.ssh` key files and local `cache_from` /
//   `cache_to` directories (also with the default `up -d --build`);
// - `develop.watch[].path`, synced into the container by `up --watch`;
// - `env_file` and `label_file`, in the string, list and `path:` forms;
// - the `file:` of the top-level `secrets` and `configs`.
// A remote build context without a `..`, `docker-image://` and `service:` are
// not host paths and are left alone.
const collectHostPaths = (
	spec: NonNullable<LooseSpec>,
	options: ResolveOptions,
	into: PathChecks,
) => {
	const { checkPath } = createPathChecks(options, into);
	const checkEach = (value: unknown, what: string) => {
		for (const entry of Array.isArray(value) ? value : [value]) {
			const path = isRecord(entry) ? entry.path : entry;
			if (typeof path === "string" && path) {
				checkPath(path, what);
			}
		}
	};

	// A build context (the main one, or an `additional_contexts` value).
	// Returns whether it is a host directory (not a URL, a layout or a
	// reference), which decides how a dockerfile is read.
	const checkContext = (
		raw: string,
		what: string,
		allowReferences: boolean,
	) => {
		const text = interpolateComposeValue(raw, options) ?? raw;
		if (allowReferences && BUILDER_REFERENCE.test(text)) {
			return false;
		}
		if (text.startsWith(OCI_LAYOUT)) {
			// `oci-layout://PATH[:TAG][@DIGEST]` reads a layout directory.
			checkPath(
				text
					.slice(OCI_LAYOUT.length)
					.replace(/@[^/]*$/, "")
					.replace(/:[^/]*$/, ""),
				what,
			);
			return false;
		}
		if (raw.startsWith(FILE_SCHEME)) {
			checkPath(raw.slice(FILE_SCHEME.length), what);
			return true;
		}
		if (text.startsWith(FILE_SCHEME)) {
			checkPath(text.slice(FILE_SCHEME.length), what);
			return true;
		}
		if (REMOTE_BUILD_CONTEXT.test(text)) {
			if (HAS_CLIMB.test(text) || HAS_CLIMB.test(raw)) {
				checkPath(raw, what);
			}
			return false;
		}
		checkPath(raw, what);
		return true;
	};

	const checkAdditionalContext = (raw: string) =>
		checkContext(raw, "additional build context", true);

	// `type=local,src=DIR` (cache_from) and `type=local,dest=DIR` (cache_to).
	// An entry that is not read as local but has the word or a quote in it is
	// checked as well, since it cannot be told from here what buildx makes of it.
	const checkCacheEntry = (entry: unknown, what: string) => {
		if (typeof entry !== "string") {
			return;
		}
		const text = interpolateComposeValue(entry, options) ?? entry;
		const fields = parseCacheFields(text);
		const local = fields.some(
			(field) => field.key === "type" && field.value.toLowerCase() === "local",
		);
		if (!local && !/local|"/i.test(text)) {
			return;
		}
		for (const field of fields) {
			if ((field.key === "src" || field.key === "dest") && field.value) {
				checkPath(field.value, what);
			}
		}
	};

	// The default of a lone `${X:-default}` stands for the variable, as it does
	// for a bind source (soleDefaultReach), also in the path built from it.
	const withSoleDefault = (raw: string) => {
		const text = interpolateComposeValue(raw, options);
		return text === null ? (SOLE_DEFAULT.exec(raw)?.[1] ?? raw) : text;
	};

	const checkBuild = (build: unknown) => {
		if (typeof build === "string") {
			checkContext(build, "build context", false);
			return;
		}
		if (!isRecord(build)) {
			return;
		}
		const context = typeof build.context === "string" ? build.context : ".";
		const local = checkContext(context, "build context", false);
		const dockerfile = build.dockerfile;
		if (typeof dockerfile === "string" && dockerfile) {
			// Relative to the context. A value that starts with a variable can
			// resolve to an absolute path, so it is judged on its own as well.
			// Next to a context that is not a host directory it is only read
			// when it climbs, since a directory of that name may be the context.
			if (
				!dockerfile.startsWith("/") &&
				(local || HAS_CLIMB.test(dockerfile))
			) {
				checkPath(
					`${local ? withSoleDefault(context) : context}/${dockerfile}`,
					"build dockerfile",
				);
			}
			if (dockerfile.startsWith("/") || dockerfile.startsWith("$")) {
				checkPath(dockerfile, "build dockerfile");
			}
		}
		const additional = build.additional_contexts;
		if (Array.isArray(additional)) {
			for (const entry of additional) {
				if (typeof entry === "string" && entry.includes("=")) {
					checkAdditionalContext(entry.slice(entry.indexOf("=") + 1));
				}
			}
		} else if (isRecord(additional)) {
			for (const value of Object.values(additional)) {
				if (typeof value === "string") {
					checkAdditionalContext(value);
				}
			}
		}
		// `ID=PATH[,PATH]`: a bare `default` or id is the SSH agent.
		const ssh = build.ssh;
		const sshValues = Array.isArray(ssh)
			? ssh.map((entry) =>
					typeof entry === "string" && entry.includes("=")
						? entry.slice(entry.indexOf("=") + 1)
						: "",
				)
			: isRecord(ssh)
				? Object.values(ssh)
				: [];
		for (const value of sshValues) {
			if (typeof value !== "string") {
				continue;
			}
			for (const key of value.split(",")) {
				if (key.trim() && key.trim() !== "default") {
					checkPath(key.trim(), "build ssh key");
				}
			}
		}
		for (const entry of Array.isArray(build.cache_from) ? build.cache_from : []) {
			checkCacheEntry(entry, "build cache_from directory");
		}
		for (const entry of Array.isArray(build.cache_to) ? build.cache_to : []) {
			checkCacheEntry(entry, "build cache_to directory");
		}
	};

	if (isRecord(spec.services)) {
		for (const service of Object.values(spec.services)) {
			if (!isRecord(service)) {
				continue;
			}
			checkBuild(service.build);
			checkEach(service.env_file, "env_file");
			checkEach(service.label_file, "label_file");
			if (isRecord(service.develop) && Array.isArray(service.develop.watch)) {
				checkEach(service.develop.watch, "develop watch path");
			}
		}
	}
	for (const [section, what] of [
		["secrets", "secret file"],
		["configs", "config file"],
	] as const) {
		const definitions = spec[section];
		if (!isRecord(definitions)) {
			continue;
		}
		for (const [name, definition] of Object.entries(definitions)) {
			if (isRecord(definition) && typeof definition.file === "string") {
				checkPath(definition.file, `${what} of "${name}"`);
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
	const forbiddenParents: string[] = [];
	const mounted: MountedKeys = {
		keys: new Set<string>(),
		unresolved,
		forbidden,
		forbiddenParents,
		anyKey: false,
	};
	for (const spec of specs) {
		if (spec?.include) {
			unresolved.push("include (volumes from another file)");
		}
		if (spec && isRecord(spec.services)) {
			collectMounts(spec.services, options, mounted);
		}
		if (spec) {
			collectHostPaths(spec, options, mounted);
		}
	}
	const definitionSets = specs.map((spec) =>
		spec && isRecord(spec.volumes) ? spec.volumes : {},
	);
	// `docker compose run -v SOURCE:TARGET`: a path is a bind mount; a name is
	// the key of a declared volume, or, when no file declares it, the Docker
	// volume of that name itself.
	const commandVolumeNames = new Set<string>();
	for (const volume of options.commandVolumes ?? []) {
		if (/[$`*?[\]{}]/.test(volume)) {
			// A shell variable, substitution or glob: the value is not known here.
			unresolved.push(`command volume "${volume}"`);
			continue;
		}
		const separator = volume.indexOf(":");
		// Without a colon it is an anonymous volume.
		const source = separator > 0 ? volume.slice(0, separator) : "";
		if (!source) {
			continue;
		}
		if (isFilePathSource(source)) {
			const reach = dockerVolumesDirectoryReach(source, options.baseDirs);
			if (reach === "inside") {
				forbidden.push(`command bind mount "${source}"`);
			} else if (reach === "parent") {
				forbiddenParents.push(`command bind mount "${source}"`);
			}
		} else if (
			definitionSets.some((definitions) => Object.hasOwn(definitions, source))
		) {
			mounted.keys.add(source);
		} else {
			commandVolumeNames.add(source);
		}
	}
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

	for (const name of commandVolumeNames) {
		addUse({ key: name, volumeName: name, derived: false });
	}

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
				if (isFilePathSource(resolvedDevice)) {
					const reach = dockerVolumesDirectoryReach(
						resolvedDevice,
						options.baseDirs,
					);
					if (reach === "inside") {
						forbidden.push(`volume "${key}" (device "${device}")`);
						continue;
					}
					if (reach === "parent") {
						forbiddenParents.push(`volume "${key}" (device "${device}")`);
						continue;
					}
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
	return { uses, unresolved, forbidden, forbiddenParents };
};

export const resolveComposeMountedVolumes = (
	spec: LooseSpec,
	options: ResolveOptions,
): ComposeVolumeResolution =>
	resolveComposeFilesMountedVolumes([spec], options);
