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
// Bind mounts (host paths), tmpfs and anonymous volumes are not named volumes.

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
	if (unresolved || result.includes("$")) {
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
};

type LooseSpec = {
	include?: unknown;
	services?: Record<string, unknown> | null;
	volumes?: Record<string, unknown> | null;
} | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

// Long-syntax types that are not named volumes.
const NON_VOLUME_TYPES = new Set([
	"bind",
	"tmpfs",
	"npipe",
	"cluster",
	"image",
]);

const isFilePathSource = (source: string) =>
	/^[./~]/.test(source) || /^[A-Za-z]:/.test(source);

// The top-level keys the services mount by name, plus the sources whose
// variables could not be resolved.
const collectMountedKeys = (
	services: Record<string, unknown>,
	options: InterpolationOptions,
) => {
	const keys = new Set<string>();
	const unresolved: string[] = [];
	// A source that cannot be resolved can name any declared volume, or a path.
	let anyKey = false;
	const addSource = (rawSource: string) => {
		const source = interpolateComposeValue(rawSource, options);
		if (source === null) {
			anyKey = true;
			return;
		}
		if (source && !isFilePathSource(source)) {
			keys.add(source);
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
					unresolved.push(`service "${serviceName}" (volumes_from a container)`);
				}
			}
		}
		if (isRecord(service.extends) && service.extends.file) {
			unresolved.push(`service "${serviceName}" (extends from another file)`);
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
					addSource(entry.source);
				}
			}
		}
	}
	return { keys, unresolved, anyKey };
};

export const resolveComposeMountedVolumes = (
	spec: LooseSpec,
	{
		appName,
		env,
		strict,
	}: { appName: string } & InterpolationOptions,
): ComposeVolumeResolution => {
	const uses: ComposeVolumeUse[] = [];
	const options = { env, strict };
	if (!spec || !isRecord(spec.services)) {
		return { uses, unresolved: [] };
	}
	const { keys, unresolved, anyKey } = collectMountedKeys(
		spec.services,
		options,
	);
	if (spec.include) {
		unresolved.push("include (volumes from another file)");
	}
	const definitions = isRecord(spec.volumes) ? spec.volumes : {};
	if (anyKey) {
		for (const key of Object.keys(definitions)) {
			keys.add(key);
		}
	}
	const prefixes = [...new Set([appName, normalizeComposeProjectName(appName)])];

	for (const key of keys) {
		// A key that is not declared makes compose fail on its own.
		if (!Object.hasOwn(definitions, key)) {
			continue;
		}
		const definition = isRecord(definitions[key]) ? definitions[key] : {};
		const { external } = definition;
		const isExternal =
			external === true ||
			external === "true" ||
			(external !== null && typeof external === "object");
		const legacyName = isRecord(external) ? external.name : undefined;

		let rawName: unknown = definition.name;
		if (isExternal && !rawName) {
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
			uses.push({ key, volumeName: name, derived: false });
			continue;
		}
		if (isExternal) {
			uses.push({ key, volumeName: key, derived: false });
			continue;
		}
		for (const prefix of prefixes) {
			uses.push({ key, volumeName: `${prefix}_${key}`, derived: true });
		}
	}
	return { uses, unresolved };
};
