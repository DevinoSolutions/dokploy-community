import { posix } from "node:path";
import { parse as parseShell } from "shell-quote";
import { parseAllDocuments } from "yaml";
import {
	COMPOSE_LEVEL_SERVICE,
	COMPOSE_POLICY_MAX_BYTES,
	type ComposePolicyRuleId,
	REDACTED,
} from "./config";

/**
 * The pure evaluator of the "restricted compose" audit (T-7455): given a
 * compose file, it lists what a sandbox WOULD refuse. It decides nothing and
 * changes nothing; the caller records the findings.
 *
 * SECRET SAFETY. A finding is a fixed rule id, the (sanitized) service name, a
 * YAML key path, and a path ONLY when it is a literal known system root from
 * the lists below. Everything else that came from the file or the environment
 * (host paths of a project, build contexts, volume names, command arguments,
 * parser messages) is never copied: it shows as `<redacted>`. The environment
 * is never read: a `${VAR}` only resolves through a literal default written in
 * the file (`${VAR:-default}`) or `$PWD`, which is the project directory.
 *
 * COST. Everything is linear in the size of the file, and a file above
 * COMPOSE_POLICY_MAX_BYTES is not parsed at all (one `compose-too-large`
 * finding), so a large compose cannot hold the event loop.
 */

export interface ComposePolicyFinding {
	serviceName: string;
	ruleId: ComposePolicyRuleId;
	detail: string;
}

export interface ComposePolicyContext {
	/** The compose appName: `docker compose -p <appName>` scopes its volumes with it. */
	appName: string;
	/** `<COMPOSE_PATH>/<appName>`: the compose's own Dokploy directory. */
	projectDirectory: string;
	/** `<projectDirectory>/code`: where the source is checked out. */
	codeDirectory: string;
	/**
	 * The directory relative paths resolve from. A deploy passes
	 * `--project-directory <codeDirectory>` (see getComposeBaseArgs), so this is
	 * the code directory even for a compose file in a subdirectory (`composePath`
	 * `deploy/docker-compose.yml`). A custom command that moves the project
	 * directory itself is not followed.
	 */
	baseDirectory: string;
}

export const DOCKER_SOCKET_PATHS = [
	"/var/run/docker.sock",
	"/run/docker.sock",
] as const;

/** A bind of one of these, or of anything under one, is a system bind. */
const SYSTEM_ROOTS = [
	"/etc",
	"/proc",
	"/sys",
	"/dev",
	"/root",
	"/boot",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/run",
	"/var/run",
	"/var/lib/docker",
] as const;

/** A bind of exactly one of these (they hold every other system path). */
const SYSTEM_EXACT = ["/", "/var", "/var/lib"] as const;

const DOCKER_STORAGE = "/var/lib/docker";

const MAX_DETAIL_LENGTH = 300;
const MAX_FINDINGS = 200;
const MAX_COMMAND_LENGTH = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasEntries = (value: unknown) =>
	(Array.isArray(value) && value.length > 0) ||
	(isRecord(value) && Object.keys(value).length > 0) ||
	(typeof value === "string" && value.length > 0);

/**
 * A name that is safe to print in a log line and a table: no control chars, no
 * spaces. Two names that differ only in characters it replaces (`a b` and
 * `a_b`) end up as one name, and their findings merge: acceptable for an audit
 * that never shows the original name, which could hold anything.
 */
export const sanitizeName = (name: unknown) =>
	String(name)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 64) || "_";

const isInside = (path: string, root: string) =>
	path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

// Hosts are Linux; a drive letter only appears on a Windows dev machine.
const toPosix = (path: string) =>
	path.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "");

// The same grammar docker compose interpolates with.
const VARIABLE =
	/\$(?:\$|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])((?:[^{}]|\{[^{}]*\})*))?\})/g;

// Stands for the `$` of a `$$` while the rest of the text is resolved.
const DOLLAR = "\uE000";

/**
 * Resolves the variables of a value WITHOUT reading any environment: `$$` is a
 * `$`, `$PWD` is the project directory, `${X:-lit}` and `${X-lit}` are `lit`
 * (resolved the same way). Anything else (`${X}`, `${X:?msg}`, `${X:+alt}`)
 * has no literal value: `null`. When X is set in the environment compose would
 * use it instead of `lit`; the audit deliberately does not look.
 */
export const resolveLiteral = (
	value: string,
	baseDirectory: string,
	depth = 0,
): string | null => {
	if (!value.includes("$")) return value;
	if (depth > 5) return null;
	let failed = false;
	const resolved = value.replace(
		VARIABLE,
		(
			match,
			bare?: string,
			braced?: string,
			operator?: string,
			rest?: string,
		) => {
			if (match === "$$") return DOLLAR;
			const name = bare ?? braced;
			if (name === "PWD") return baseDirectory;
			if (operator === "-" || operator === ":-") {
				const fallback = resolveLiteral(rest ?? "", baseDirectory, depth + 1);
				if (fallback !== null) return fallback;
			}
			failed = true;
			return "";
		},
	);
	// A variable the pattern did not match (nested deeper than one level, or
	// malformed) is still in the text: it has no literal value either.
	if (failed || /\$[{A-Za-z_]/.test(resolved)) return null;
	return resolved.split(DOLLAR).join("$");
};

/** A boolean key: a value with no literal (`${X}`) counts as true, it cannot be known. */
const isTrue = (value: unknown, baseDirectory: string) => {
	if (value === true) return true;
	if (typeof value !== "string") return false;
	const resolved = resolveLiteral(value, baseDirectory);
	if (resolved === null) return true;
	return /^(true|yes|on|1)$/i.test(resolved.trim());
};

type PathClass = {
	ruleId: Extract<
		ComposePolicyRuleId,
		"docker-socket-bind" | "system-path-bind" | "foreign-host-bind"
	>;
	/** Only ever a literal from the lists above, or the redaction. */
	shown: string;
};

/**
 * Where a host path points, worked out from the text only. `null`: inside the
 * compose's own directory, which is what a sandbox allows.
 */
const classifyHostPath = (
	raw: string,
	context: ComposePolicyContext,
): PathClass | null => {
	const base = toPosix(context.baseDirectory);
	const literal = resolveLiteral(raw, base);
	if (literal === null || literal.startsWith("~")) {
		return { ruleId: "foreign-host-bind", shown: `${REDACTED} (unresolved)` };
	}
	const resolved = posix.resolve(base, toPosix(literal));
	for (const socket of DOCKER_SOCKET_PATHS) {
		if (resolved === socket) {
			return { ruleId: "docker-socket-bind", shown: socket };
		}
	}
	// Before the system roots: the compose directory itself lives under /etc.
	if (isInside(resolved, toPosix(context.projectDirectory))) return null;
	for (const root of SYSTEM_ROOTS) {
		if (isInside(resolved, root)) {
			return { ruleId: "system-path-bind", shown: root };
		}
	}
	for (const exact of SYSTEM_EXACT) {
		if (resolved === exact) {
			return { ruleId: "system-path-bind", shown: exact };
		}
	}
	return { ruleId: "foreign-host-bind", shown: REDACTED };
};

/** Compose names a project like `compose-go`: lowercase, [a-z0-9_-] only. */
const normalizeProjectName = (name: string) =>
	name.toLowerCase().replace(/[^a-z0-9_-]/g, "");

/** `<project>_<key>` is the default; an explicit name has to start the same way. */
const isNamespacedVolumeName = (name: string, appName: string) => {
	const lower = name.toLowerCase();
	return [appName.toLowerCase(), normalizeProjectName(appName)].some(
		(prefix) =>
			prefix.length > 0 &&
			(lower === prefix ||
				lower.startsWith(`${prefix}_`) ||
				lower.startsWith(`${prefix}-`)),
	);
};

type Collector = {
	add: (
		serviceName: string,
		ruleId: ComposePolicyRuleId,
		detail: string,
	) => void;
	result: () => ComposePolicyFinding[];
};

/** One finding per (service, rule): the details of the same pair are joined. */
const createCollector = (): Collector => {
	const grouped = new Map<
		string,
		{
			serviceName: string;
			ruleId: ComposePolicyRuleId;
			details: string[];
			size: number;
		}
	>();
	return {
		add(serviceName, ruleId, detail) {
			const key = `${serviceName}|${ruleId}`;
			const entry = grouped.get(key) ?? {
				serviceName,
				ruleId,
				details: [],
				size: 0,
			};
			grouped.set(key, entry);
			// Once the text is as long as a finding may be, more details cannot
			// show: skip them (keeps a huge file from costing a long scan here).
			if (entry.size >= MAX_DETAIL_LENGTH) return;
			if (entry.details.includes(detail)) return;
			entry.details.push(detail);
			entry.size += detail.length + 2;
		},
		result() {
			return [...grouped.values()]
				.slice(0, MAX_FINDINGS)
				.map(({ serviceName, ruleId, details }) => ({
					serviceName,
					ruleId,
					detail: details.join("; ").slice(0, MAX_DETAIL_LENGTH),
				}));
		},
	};
};

/** Keys whose value `host` shares a namespace of the host. */
const NAMESPACE_KEYS = ["network_mode", "pid", "ipc", "uts", "cgroup"] as const;

/**
 * A `security_opt` entry that weakens confinement: seccomp off or custom,
 * apparmor unconfined, SELinux labels disabled, systempaths unconfined.
 * `no-new-privileges` and the like are hardening and never a finding. An entry
 * with no literal value (`${X}`) is not flagged: it cannot be known.
 */
const weakensConfinement = (entry: unknown, baseDirectory: string) => {
	if (typeof entry !== "string") return false;
	const text = resolveLiteral(entry, baseDirectory);
	if (text === null) return false;
	const match = /^([a-z-]+)\s*[=:]\s*(.*)$/i.exec(text.trim());
	if (!match) return false;
	const key = (match[1] ?? "").toLowerCase();
	const value = (match[2] ?? "").trim().toLowerCase();
	if (key === "seccomp") return value !== "";
	if (key === "apparmor" || key === "systempaths")
		return value === "unconfined";
	if (key === "label") return value === "disable";
	return false;
};

/** Rule 1: keys that give a service the privileges of the host. */
const evaluateHostPrivilege = (
	name: string,
	service: Record<string, unknown>,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	const at = `services.${name}`;
	const base = toPosix(context.baseDirectory);
	if (isTrue(service.privileged, base)) {
		collector.add(name, "host-privilege", `${at}.privileged`);
	}
	if (isTrue(service.use_api_socket, base)) {
		collector.add(name, "host-privilege", `${at}.use_api_socket`);
	}
	for (const key of [
		"cap_add",
		"devices",
		"userns_mode",
		"cgroup_parent",
		"sysctls",
		"device_cgroup_rules",
	] as const) {
		if (hasEntries(service[key])) {
			collector.add(name, "host-privilege", `${at}.${key}`);
		}
	}
	if (
		Array.isArray(service.security_opt) &&
		service.security_opt.some((entry) => weakensConfinement(entry, base))
	) {
		collector.add(name, "host-privilege", `${at}.security_opt`);
	}
	// GPUs and other devices reserved through the deploy section.
	const deploy = isRecord(service.deploy) ? service.deploy : {};
	const resources = isRecord(deploy.resources) ? deploy.resources : {};
	const reservations = isRecord(resources.reservations)
		? resources.reservations
		: {};
	if (hasEntries(reservations.devices)) {
		collector.add(
			name,
			"host-privilege",
			`${at}.deploy.resources.reservations.devices`,
		);
	}
	for (const key of NAMESPACE_KEYS) {
		const value = service[key];
		if (typeof value !== "string") continue;
		const mode = (resolveLiteral(value, base) ?? "").trim();
		if (mode === "host") {
			collector.add(name, "host-privilege", `${at}.${key}=host`);
		} else if (key !== "cgroup" && /^(service|container):/.test(mode)) {
			collector.add(name, "namespace-join", `${at}.${key}`);
		}
	}
	if (Array.isArray(service.volumes_from)) {
		const joins = service.volumes_from.some(
			(entry) => typeof entry === "string" && entry.startsWith("container:"),
		);
		if (joins) collector.add(name, "namespace-join", `${at}.volumes_from`);
	}
};

type Mount =
	| { kind: "bind"; source: string; path: string }
	| { kind: "named"; key: string };

const looksLikePath = (source: string) => /^(\/|\.|~)/.test(source);

/** Splits a short volume entry on `:` outside `${...}` (a default can hold one). */
const splitOutsideBraces = (entry: string) => {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of entry) {
		if (char === "{") depth += 1;
		else if (char === "}" && depth > 0) depth -= 1;
		if (char === ":" && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	parts.push(current);
	return parts;
};

/**
 * A mount source: a host path (`bind`) or the key of a named volume. A source
 * with no literal value (`${X}`) cannot be told apart: it counts as a bind.
 */
const readSource = (
	source: string,
	path: string,
	forced: "bind" | "volume" | undefined,
	baseDirectory: string,
): Mount => {
	const literal = resolveLiteral(source, baseDirectory);
	if (forced === "bind") return { kind: "bind", source, path };
	if (literal === null) {
		return forced === "volume"
			? { kind: "named", key: source }
			: { kind: "bind", source, path };
	}
	if (forced === "volume") return { kind: "named", key: literal };
	return looksLikePath(literal)
		? { kind: "bind", source, path }
		: { kind: "named", key: literal };
};

/** The mounts of one service, short and long syntax. Anonymous volumes and tmpfs are skipped. */
const readMounts = (
	name: string,
	service: Record<string, unknown>,
	baseDirectory: string,
): Mount[] => {
	if (!Array.isArray(service.volumes)) return [];
	const mounts: Mount[] = [];
	service.volumes.forEach((entry, index) => {
		const path = `services.${name}.volumes[${index}]`;
		if (typeof entry === "string") {
			const parts = splitOutsideBraces(entry);
			const source = parts[0] ?? "";
			if (parts.length < 2 || source.length === 0) return;
			mounts.push(readSource(source, path, undefined, baseDirectory));
			return;
		}
		if (!isRecord(entry)) return;
		const source = typeof entry.source === "string" ? entry.source : "";
		if (!source) return;
		if (entry.type === "bind") {
			mounts.push(readSource(source, path, "bind", baseDirectory));
		} else if (entry.type === "volume") {
			mounts.push(readSource(source, path, "volume", baseDirectory));
		} else if (entry.type === undefined) {
			mounts.push(readSource(source, path, undefined, baseDirectory));
		}
	});
	return mounts;
};

/** Records a host path at `keyPath` when a sandbox would refuse it. */
const checkHostPath = (
	service: string,
	keyPath: string,
	raw: unknown,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	if (typeof raw !== "string" || raw.length === 0) return;
	const found = classifyHostPath(raw, context);
	if (found) collector.add(service, found.ruleId, `${keyPath}: ${found.shown}`);
};

/** Rule 2 for the bind mounts of a service. */
const evaluateBinds = (
	name: string,
	mounts: readonly Mount[],
	context: ComposePolicyContext,
	collector: Collector,
) => {
	for (const mount of mounts) {
		if (mount.kind !== "bind") continue;
		checkHostPath(name, mount.path, mount.source, context, collector);
	}
};

const isExternal = (
	definition: Record<string, unknown>,
	baseDirectory: string,
) =>
	isTrue(definition.external, baseDirectory) || isRecord(definition.external);

/** `driver_opts: { type: none, o: bind, device: <path> }`: a bind in disguise. */
const readDeviceBind = (definition: Record<string, unknown>) => {
	const options = definition.driver_opts;
	if (!isRecord(options)) return null;
	if (String(options.type ?? "") !== "none") return null;
	const flags = String(options.o ?? "")
		.split(",")
		.map((flag) => flag.trim());
	if (!flags.includes("bind") && !flags.includes("rbind")) return null;
	return typeof options.device === "string" ? options.device : null;
};

/** Rules 2 and 3 for the top-level volumes, attributed to the services that mount them. */
const evaluateVolumeDefinitions = (
	spec: Record<string, unknown>,
	ownersByKey: ReadonlyMap<string, readonly string[]>,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	if (!isRecord(spec.volumes)) return;
	const base = toPosix(context.baseDirectory);
	for (const [key, raw] of Object.entries(spec.volumes)) {
		const definition = isRecord(raw) ? raw : {};
		const at = `volumes.${sanitizeName(key)}`;
		const record = (ruleId: ComposePolicyRuleId, detail: string) => {
			const names = ownersByKey.get(key);
			for (const service of names && names.length > 0
				? names
				: [COMPOSE_LEVEL_SERVICE]) {
				collector.add(service, ruleId, detail);
			}
		};
		if (isExternal(definition, base)) {
			record("external-volume", `${at}: external`);
		} else if (
			typeof definition.name === "string" &&
			!isNamespacedVolumeName(definition.name, context.appName)
		) {
			record(
				"foreign-volume-name",
				`${at}.name: not namespaced to this compose`,
			);
		}
		const device = readDeviceBind(definition);
		if (device !== null) {
			const found = classifyHostPath(device, context);
			if (found) {
				record(found.ruleId, `${at}.driver_opts.device: ${found.shown}`);
			}
		}
	}
};

/** A context that is not a directory of this host (a URL, an image, another service). */
const isRemoteContext = (value: string) =>
	/^[a-z][a-z0-9+.-]*:(\/\/)?/i.test(value) ||
	/^(github\.com|git@)/.test(value);

/**
 * Rule 4: build contexts, dockerfiles and additional contexts of a service,
 * and the host paths of `build.ssh` (`build.secrets` names the top-level
 * secrets, whose `file:` is checked with them).
 */
const evaluateBuild = (
	name: string,
	service: Record<string, unknown>,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	const build = service.build;
	if (build === undefined || build === null || build === false) return;
	const at = `services.${name}.build`;
	const code = toPosix(context.codeDirectory);
	const baseDirectory = toPosix(context.baseDirectory);
	// Returns the directory the path resolves to (the base of the next path).
	const checkPath = (value: unknown, base: string, keyPath: string) => {
		if (typeof value !== "string" || value.length === 0) return base;
		const literal = resolveLiteral(value, baseDirectory);
		if (literal === null) {
			collector.add(
				name,
				"build-context-outside",
				`${keyPath}: ${REDACTED} (unresolved)`,
			);
			return base;
		}
		if (isRemoteContext(literal)) return base;
		const resolved = posix.resolve(base, toPosix(literal));
		if (isInside(resolved, DOCKER_STORAGE)) {
			collector.add(
				name,
				"build-context-docker-storage",
				`${keyPath}: ${DOCKER_STORAGE}`,
			);
		} else if (!isInside(resolved, code)) {
			collector.add(name, "build-context-outside", `${keyPath}: ${REDACTED}`);
		}
		return resolved;
	};
	if (typeof build === "string") {
		checkPath(build, baseDirectory, at);
		return;
	}
	if (!isRecord(build)) return;
	const contextDirectory = checkPath(
		build.context ?? ".",
		baseDirectory,
		`${at}.context`,
	);
	checkPath(build.dockerfile, contextDirectory, `${at}.dockerfile`);
	const additional = build.additional_contexts;
	if (isRecord(additional)) {
		for (const [key, value] of Object.entries(additional)) {
			checkPath(
				value,
				baseDirectory,
				`${at}.additional_contexts.${sanitizeName(key)}`,
			);
		}
	} else if (Array.isArray(additional)) {
		additional.forEach((entry, index) => {
			if (typeof entry !== "string") return;
			const value = entry.includes("=")
				? entry.slice(entry.indexOf("=") + 1)
				: entry;
			checkPath(value, baseDirectory, `${at}.additional_contexts[${index}]`);
		});
	}
	// `ssh: [default]`, `ssh: ["id=/path/to/key"]` or `ssh: { id: /path }`.
	const ssh = build.ssh;
	if (isRecord(ssh)) {
		for (const [key, value] of Object.entries(ssh)) {
			checkHostPath(
				name,
				`${at}.ssh.${sanitizeName(key)}`,
				value,
				context,
				collector,
			);
		}
	} else if (Array.isArray(ssh)) {
		ssh.forEach((entry, index) => {
			if (typeof entry !== "string" || !entry.includes("=")) return;
			checkHostPath(
				name,
				`${at}.ssh[${index}]`,
				entry.slice(entry.indexOf("=") + 1),
				context,
				collector,
			);
		});
	}
};

/** The `env_file` and `extends.file` paths of a service. */
const evaluateServiceFiles = (
	name: string,
	service: Record<string, unknown>,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	const at = `services.${name}`;
	const envFile = service.env_file;
	if (typeof envFile === "string") {
		checkHostPath(name, `${at}.env_file`, envFile, context, collector);
	} else if (Array.isArray(envFile)) {
		envFile.forEach((entry, index) => {
			const path = isRecord(entry) ? entry.path : entry;
			checkHostPath(name, `${at}.env_file[${index}]`, path, context, collector);
		});
	}
	if (isRecord(service.extends)) {
		checkHostPath(
			name,
			`${at}.extends.file`,
			service.extends.file,
			context,
			collector,
		);
	}
};

/** Top-level `configs:` and `secrets:` with a `file:`, and `include:`. */
const evaluateTopLevelFiles = (
	spec: Record<string, unknown>,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	for (const section of ["configs", "secrets"] as const) {
		const entries = spec[section];
		if (!isRecord(entries)) continue;
		for (const [key, definition] of Object.entries(entries)) {
			if (!isRecord(definition)) continue;
			checkHostPath(
				COMPOSE_LEVEL_SERVICE,
				`${section}.${sanitizeName(key)}.file`,
				definition.file,
				context,
				collector,
			);
		}
	}
	const include = spec.include;
	const entries = typeof include === "string" ? [include] : include;
	if (!Array.isArray(entries)) return;
	entries.forEach((entry, index) => {
		const at = `include[${index}]`;
		if (typeof entry === "string") {
			checkHostPath(COMPOSE_LEVEL_SERVICE, at, entry, context, collector);
			return;
		}
		if (!isRecord(entry)) return;
		const paths = Array.isArray(entry.path) ? entry.path : [entry.path];
		for (const path of paths) {
			checkHostPath(
				COMPOSE_LEVEL_SERVICE,
				`${at}.path`,
				path,
				context,
				collector,
			);
		}
		checkHostPath(
			COMPOSE_LEVEL_SERVICE,
			`${at}.project_directory`,
			entry.project_directory,
			context,
			collector,
		);
		const envFiles = Array.isArray(entry.env_file)
			? entry.env_file
			: [entry.env_file];
		for (const path of envFiles) {
			checkHostPath(
				COMPOSE_LEVEL_SERVICE,
				`${at}.env_file`,
				path,
				context,
				collector,
			);
		}
	});
};

const addSpecFindings = (
	spec: unknown,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	if (!isRecord(spec)) return;
	const base = toPosix(context.baseDirectory);
	const services = isRecord(spec.services) ? spec.services : {};
	// volume key -> the services that mount it, built once (linear).
	const ownersByKey = new Map<string, string[]>();
	for (const [rawName, rawService] of Object.entries(services)) {
		if (!isRecord(rawService)) continue;
		const name = sanitizeName(rawName);
		evaluateHostPrivilege(name, rawService, context, collector);
		const mounts = readMounts(name, rawService, base);
		for (const mount of mounts) {
			if (mount.kind !== "named") continue;
			const owners = ownersByKey.get(mount.key);
			if (!owners) ownersByKey.set(mount.key, [name]);
			else if (!owners.includes(name)) owners.push(name);
		}
		evaluateBinds(name, mounts, context, collector);
		evaluateBuild(name, rawService, context, collector);
		evaluateServiceFiles(name, rawService, context, collector);
	}
	evaluateVolumeDefinitions(spec, ownersByKey, context, collector);
	evaluateTopLevelFiles(spec, context, collector);
};

/** Rules 1 to 4 on a parsed compose file. Never throws on a strange shape. */
export const evaluateComposeSpec = (
	spec: unknown,
	context: ComposePolicyContext,
): ComposePolicyFinding[] => {
	const collector = createCollector();
	addSpecFindings(spec, context, collector);
	return collector.result();
};

/** Flags of a custom command that change which files and project it runs. */
const REPORTED_FLAGS = new Set([
	"-f",
	"--file",
	"-p",
	"--project-name",
	"--project-directory",
	"--env-file",
	"--profile",
	"-c",
	"--compose-file",
	"--context",
	"-H",
	"--host",
]);

const REPORTED_SUBCOMMANDS = new Set([
	"compose",
	"stack",
	"up",
	"down",
	"run",
	"exec",
	"config",
	"build",
	"pull",
	"push",
	"create",
	"start",
	"stop",
	"restart",
	"kill",
	"rm",
	"cp",
	"logs",
	"ps",
	"deploy",
	"service",
	"swarm",
	"network",
	"volume",
	"system",
	"container",
	"image",
]);

/** The shell operators that chain one command after another. A glob is not one. */
const CHAINING_OPERATORS = new Set(["&&", "||", ";", "|", "&", "|&", ";;"]);

const flagName = (word: string) => {
	if (word.startsWith("--")) {
		const name = word.split("=")[0] ?? word;
		return REPORTED_FLAGS.has(name) ? name : null;
	}
	if (word.startsWith("-") && word.length >= 2) {
		const short = word.slice(0, 2);
		if (!REPORTED_FLAGS.has(short)) return null;
		// `-f./x.yml`: the flag glued to a path. `-fx` is another option.
		return word.length === 2 || word[2] === "=" || /[./]/.test(word.slice(2))
			? short
			: null;
	}
	return null;
};

/**
 * Rule 5: the custom command of the compose, as a finding detail with ONLY the
 * names of what it uses (flags, subcommands, how many commands are chained),
 * never a value. Only words from the lists above are ever printed.
 */
export const describeCustomCommand = (command: string) => {
	if (command.length > MAX_COMMAND_LENGTH) {
		return "custom command (too long to analyse)";
	}
	const flags = new Set<string>();
	const subcommands = new Set<string>();
	let chained = 0;
	try {
		for (const word of parseShell(command)) {
			if (typeof word === "string") {
				const flag = flagName(word);
				if (flag) flags.add(flag);
				else if (REPORTED_SUBCOMMANDS.has(word)) subcommands.add(word);
			} else if (
				word &&
				typeof word === "object" &&
				"op" in word &&
				CHAINING_OPERATORS.has(String(word.op))
			) {
				chained += 1;
			}
		}
	} catch {
		return "custom command";
	}
	const part = (label: string, values: Iterable<string>) => {
		const list = [...values].sort();
		return list.length > 0 ? `${label}: ${list.join(", ")}` : "";
	};
	const parts = [
		part("flags", flags),
		part("subcommands", subcommands),
		chained > 0 ? `chained: ${chained}` : "",
	].filter(Boolean);
	return parts.length > 0
		? `custom command (${parts.join("; ")})`
		: "custom command";
};

export type ParsedComposeText =
	| { ok: true; spec: unknown }
	| { ok: false; detail: string };

/**
 * Rule 6: parses the text of a compose file. A file that does not parse, or
 * that holds more than one YAML document, is a finding and is never an
 * exception. The parser's message is not kept: it quotes the file.
 */
export const parseComposeText = (text: string): ParsedComposeText => {
	try {
		const documents = parseAllDocuments(text, { merge: true });
		const list = Array.isArray(documents) ? documents : [documents];
		const nonEmpty = list.filter(
			(document) => document.contents !== null || document.errors.length > 0,
		);
		if (nonEmpty.length > 1) {
			return { ok: false, detail: "multi-document YAML" };
		}
		const document = nonEmpty[0];
		if (!document) return { ok: true, spec: null };
		if (document.errors.length > 0) {
			return { ok: false, detail: "YAML parse error" };
		}
		const spec = document.toJS({ maxAliasCount: 10000 });
		if (spec !== null && !isRecord(spec)) {
			return { ok: false, detail: "compose file is not a mapping" };
		}
		return { ok: true, spec };
	} catch {
		return { ok: false, detail: "YAML parse error" };
	}
};

/** Checks the size, parses the text once and records rule 6 or the rules 1 to 4. */
const evaluateFileText = (
	text: string,
	label: string | null,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	const prefix = label ? `${label}: ` : "";
	if (Buffer.byteLength(text, "utf8") > COMPOSE_POLICY_MAX_BYTES) {
		collector.add(
			COMPOSE_LEVEL_SERVICE,
			"compose-too-large",
			`${prefix}larger than ${COMPOSE_POLICY_MAX_BYTES / 1024} KB, not evaluated`,
		);
		return;
	}
	const parsed = parseComposeText(text);
	if (!parsed.ok) {
		collector.add(
			COMPOSE_LEVEL_SERVICE,
			"unparseable-compose",
			`${prefix}${parsed.detail}`,
		);
		return;
	}
	addSpecFindings(parsed.spec, context, collector);
};

/**
 * Everything the audit evaluates for one deploy: the custom command (rule 5),
 * the compose text and the override files of the command, each size-checked
 * and parsed once. Pure: the caller reads the files.
 */
export const evaluateComposePolicy = ({
	text,
	overrides = [],
	command,
	context,
}: {
	/** The compose file as the deploy uses it; `null` when there is none to read. */
	text: string | null;
	/** The texts of the `-f` override files of a custom command. */
	overrides?: readonly string[];
	command?: string | null;
	context: ComposePolicyContext;
}): ComposePolicyFinding[] => {
	const collector = createCollector();
	if (command?.trim()) {
		collector.add(
			COMPOSE_LEVEL_SERVICE,
			"custom-command",
			describeCustomCommand(command),
		);
	}
	if (text !== null) evaluateFileText(text, null, context, collector);
	for (const override of overrides) {
		evaluateFileText(override, "override file", context, collector);
	}
	return collector.result();
};
