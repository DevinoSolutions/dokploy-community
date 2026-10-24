import { posix } from "node:path";
import { parse as parseShell } from "shell-quote";
import { parseAllDocuments } from "yaml";
import {
	COMPOSE_LEVEL_SERVICE,
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
 * parser messages) is never copied: it shows as `<redacted>`. Interpolated
 * values (`${VAR}`) are not looked up at all.
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
	/** The directory of the compose file: relative paths resolve from it. */
	composeDirectory: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// An interpolated value (`privileged: ${X}`) cannot be known here, so it counts.
const isTrue = (value: unknown) =>
	value === true ||
	(typeof value === "string" &&
		(/^(true|yes|on|1)$/i.test(value.trim()) || value.includes("$")));

const hasEntries = (value: unknown) =>
	(Array.isArray(value) && value.length > 0) ||
	(isRecord(value) && Object.keys(value).length > 0) ||
	(typeof value === "string" && value.length > 0);

/** A name that is safe to print in a log line and a table: no control chars, no spaces. */
export const sanitizeName = (name: unknown) =>
	String(name)
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 64) || "_";

const isInside = (path: string, root: string) =>
	path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

const hasVariable = (value: string) => value.includes("$");

// Hosts are Linux; a drive letter only appears on a Windows dev machine.
const toPosix = (path: string) =>
	path.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "");

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
	if (hasVariable(raw) || raw.startsWith("~")) {
		return { ruleId: "foreign-host-bind", shown: `${REDACTED} (unresolved)` };
	}
	const resolved = posix.resolve(toPosix(context.composeDirectory), raw);
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
		{ serviceName: string; ruleId: ComposePolicyRuleId; details: string[] }
	>();
	return {
		add(serviceName, ruleId, detail) {
			const key = `${serviceName}|${ruleId}`;
			const entry = grouped.get(key) ?? { serviceName, ruleId, details: [] };
			if (!entry.details.includes(detail)) entry.details.push(detail);
			grouped.set(key, entry);
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

const NAMESPACE_KEYS = ["network_mode", "pid", "ipc", "uts"] as const;

/** Rule 1: keys that give a service the privileges of the host. */
const evaluateHostPrivilege = (
	name: string,
	service: Record<string, unknown>,
	collector: Collector,
) => {
	const at = `services.${name}`;
	if (isTrue(service.privileged)) {
		collector.add(name, "host-privilege", `${at}.privileged`);
	}
	if (isTrue(service.use_api_socket)) {
		collector.add(name, "host-privilege", `${at}.use_api_socket`);
	}
	for (const key of [
		"cap_add",
		"devices",
		"security_opt",
		"userns_mode",
		"cgroup_parent",
	] as const) {
		if (hasEntries(service[key])) {
			collector.add(name, "host-privilege", `${at}.${key}`);
		}
	}
	for (const key of NAMESPACE_KEYS) {
		const value = service[key];
		if (typeof value !== "string") continue;
		const mode = value.trim();
		if (mode === "host") {
			collector.add(name, "host-privilege", `${at}.${key}=host`);
		} else if (/^(service|container):/.test(mode)) {
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

/** The mounts of one service, short and long syntax. Anonymous volumes and tmpfs are skipped. */
const readMounts = (
	name: string,
	service: Record<string, unknown>,
): Mount[] => {
	if (!Array.isArray(service.volumes)) return [];
	const mounts: Mount[] = [];
	service.volumes.forEach((entry, index) => {
		const path = `services.${name}.volumes[${index}]`;
		if (typeof entry === "string") {
			const parts = entry.split(":");
			const source = parts[0] ?? "";
			if (parts.length < 2 || source.length === 0) return;
			if (looksLikePath(source) || hasVariable(source)) {
				mounts.push({ kind: "bind", source, path });
			} else {
				mounts.push({ kind: "named", key: source });
			}
			return;
		}
		if (!isRecord(entry)) return;
		const source = typeof entry.source === "string" ? entry.source : "";
		if (!source) return;
		if (entry.type === "bind") {
			mounts.push({ kind: "bind", source, path });
		} else if (entry.type === "volume") {
			mounts.push({ kind: "named", key: source });
		} else if (entry.type === undefined) {
			mounts.push(
				looksLikePath(source)
					? { kind: "bind", source, path }
					: { kind: "named", key: source },
			);
		}
	});
	return mounts;
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
		const found = classifyHostPath(mount.source, context);
		if (found) {
			collector.add(name, found.ruleId, `${mount.path}: ${found.shown}`);
		}
	}
};

const isExternal = (definition: Record<string, unknown>) =>
	isTrue(definition.external) || isRecord(definition.external);

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
	mountsByService: ReadonlyMap<string, readonly Mount[]>,
	context: ComposePolicyContext,
	collector: Collector,
) => {
	if (!isRecord(spec.volumes)) return;
	const owners = (key: string) =>
		[...mountsByService.entries()]
			.filter(([, mounts]) =>
				mounts.some((mount) => mount.kind === "named" && mount.key === key),
			)
			.map(([service]) => service);
	for (const [key, raw] of Object.entries(spec.volumes)) {
		const definition = isRecord(raw) ? raw : {};
		const at = `volumes.${sanitizeName(key)}`;
		const record = (ruleId: ComposePolicyRuleId, detail: string) => {
			const names = owners(key);
			for (const service of names.length > 0
				? names
				: [COMPOSE_LEVEL_SERVICE]) {
				collector.add(service, ruleId, detail);
			}
		};
		if (isExternal(definition)) {
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

/** Rule 4: build contexts, dockerfiles and additional contexts of a service. */
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
	const composeDirectory = toPosix(context.composeDirectory);
	// Returns the directory the path resolves to (the base of the next path).
	const checkPath = (value: unknown, base: string, keyPath: string) => {
		if (typeof value !== "string" || value.length === 0) return base;
		if (isRemoteContext(value)) return base;
		if (hasVariable(value)) {
			collector.add(
				name,
				"build-context-outside",
				`${keyPath}: ${REDACTED} (unresolved)`,
			);
			return base;
		}
		const resolved = posix.resolve(base, toPosix(value));
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
		checkPath(build, composeDirectory, at);
		return;
	}
	if (!isRecord(build)) return;
	const contextDirectory = checkPath(
		build.context ?? ".",
		composeDirectory,
		`${at}.context`,
	);
	checkPath(build.dockerfile, contextDirectory, `${at}.dockerfile`);
	const additional = build.additional_contexts;
	if (isRecord(additional)) {
		for (const [key, value] of Object.entries(additional)) {
			checkPath(
				value,
				composeDirectory,
				`${at}.additional_contexts.${sanitizeName(key)}`,
			);
		}
	} else if (Array.isArray(additional)) {
		additional.forEach((entry, index) => {
			if (typeof entry !== "string") return;
			const value = entry.includes("=")
				? entry.slice(entry.indexOf("=") + 1)
				: entry;
			checkPath(value, composeDirectory, `${at}.additional_contexts[${index}]`);
		});
	}
};

/** Rules 1 to 4 on a parsed compose file. Never throws on a strange shape. */
export const evaluateComposeSpec = (
	spec: unknown,
	context: ComposePolicyContext,
): ComposePolicyFinding[] => {
	if (!isRecord(spec)) return [];
	const collector = createCollector();
	const services = isRecord(spec.services) ? spec.services : {};
	const mountsByService = new Map<string, Mount[]>();
	for (const [rawName, rawService] of Object.entries(services)) {
		if (!isRecord(rawService)) continue;
		const name = sanitizeName(rawName);
		evaluateHostPrivilege(name, rawService, collector);
		const mounts = readMounts(name, rawService);
		mountsByService.set(name, mounts);
		evaluateBinds(name, mounts, context, collector);
		evaluateBuild(name, rawService, context, collector);
	}
	evaluateVolumeDefinitions(spec, mountsByService, context, collector);
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
	const flags = new Set<string>();
	const subcommands = new Set<string>();
	let chained = 0;
	try {
		for (const word of parseShell(command)) {
			if (typeof word === "string") {
				const flag = flagName(word);
				if (flag) flags.add(flag);
				else if (REPORTED_SUBCOMMANDS.has(word)) subcommands.add(word);
			} else if (word && typeof word === "object" && "op" in word) {
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

/**
 * Everything the audit evaluates for one deploy: the compose text (checked for
 * rule 6, and evaluated unless the caller has the final spec the deploy uses),
 * and the custom command.
 */
export const evaluateComposePolicy = ({
	text,
	spec,
	command,
	context,
}: {
	text: string | null;
	/** The spec the deploy actually uses (domains, randomize, patches applied). */
	spec?: unknown;
	command?: string | null;
	context: ComposePolicyContext;
}): ComposePolicyFinding[] => {
	const findings: ComposePolicyFinding[] = [];
	if (command?.trim()) {
		findings.push({
			serviceName: COMPOSE_LEVEL_SERVICE,
			ruleId: "custom-command",
			detail: describeCustomCommand(command),
		});
	}
	let evaluated = spec;
	if (text !== null) {
		const parsed = parseComposeText(text);
		if (!parsed.ok) {
			findings.push({
				serviceName: COMPOSE_LEVEL_SERVICE,
				ruleId: "unparseable-compose",
				detail: parsed.detail,
			});
			return findings;
		}
		if (evaluated === undefined) evaluated = parsed.spec;
	}
	if (evaluated !== undefined) {
		findings.push(...evaluateComposeSpec(evaluated, context));
	}
	return findings;
};
