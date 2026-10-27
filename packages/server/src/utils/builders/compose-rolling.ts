import { quote } from "shell-quote";
import {
	type ComposeRollingReplace,
	composeRollingReplaceSchema,
	ROLLING_HEALTH_TIMEOUT_MAX_SECONDS,
	ROLLING_MAX_REPLICAS,
} from "../../db/validations/compose-rolling";
import { NEUTRALISED_CLI_ENV } from "../docker/env-file";
import {
	type ComposeVariableLookup,
	interpolateComposeValue,
} from "./compose-interpolate";

export type { ComposeRollingReplace };

/**
 * Opt-in rolling replace for the services of a `docker-compose` type compose.
 *
 * Instead of `docker compose up` stopping the old container before the new one
 * exists, each selected service is replaced like this: record the ids of its
 * containers, start a second replica from the new release (`--scale svc=2
 * --no-recreate`), wait until that replica is healthy, then stop and remove the
 * old container by id. A replica that never becomes healthy is removed and the
 * old container, which was never touched, keeps serving.
 *
 * Stored as one nullable jsonb column (`compose.rollingReplace`); `null`, a
 * disabled setting or an empty service list means off, and the generated deploy
 * script is byte-identical to what it was before the feature existed.
 *
 * Design and open questions: docs/design/compose-zero-downtime.md (option a).
 */

export const ROLLING_POLL_INTERVAL_SECONDS = 2;

/**
 * Normalizes whatever is stored in the column. Anything that does not parse
 * (a hand-edited row) counts as "off": a deploy must never fail because of a
 * malformed optional setting.
 */
export const resolveComposeRolling = (
	raw: unknown,
): ComposeRollingReplace | null => {
	if (!raw) return null;
	const parsed = composeRollingReplaceSchema.safeParse(raw);
	if (!parsed.success) return null;
	if (!parsed.data.enabled || parsed.data.services.length === 0) return null;
	return parsed.data;
};

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

export type RollingBlockerCode =
	| "stack"
	| "custom-command"
	| "fresh-volumes"
	| "service-missing"
	| "container-name"
	| "published-ports"
	| "network-mode"
	| "replicas"
	| "static-address"
	| "namespace-dependent"
	| "no-healthcheck"
	| "healthcheck-disabled"
	| "stateful-image"
	| "health-timeout-too-short";

export interface RollingBlocker {
	code: RollingBlockerCode;
	message: string;
}

type SpecObject = Record<string, unknown>;

/** The part of the rendered compose spec eligibility looks at. */
export interface RollingSpec {
	services?: Record<string, SpecObject | null | undefined> | null;
}

export interface RollingEligibilityInput {
	/** The spec the deploy runs (domains, randomize and isolated deployment applied). */
	spec: RollingSpec;
	service: string;
	composeType: string;
	/** The compose has a custom command: Dokploy does not control what runs. */
	hasCustomCommand?: boolean;
	/** A fresh-volumes deploy is destructive by design. */
	freshVolumes?: boolean;
}

/**
 * Image names that are datastores. Only a guard: the explicit per-service
 * opt-in is the real control, this stops the obvious mistake.
 */
export const STATEFUL_IMAGE_NAMES: ReadonlySet<string> = new Set([
	"postgres",
	"postgresql",
	"postgis",
	"timescaledb",
	"pgvector",
	"mysql",
	"mariadb",
	"percona",
	"mongo",
	"mongodb",
	"redis",
	"valkey",
	"keydb",
	"dragonfly",
	"memcached",
	"etcd",
	"rabbitmq",
	"kafka",
	"zookeeper",
	"cassandra",
	"couchdb",
	"influxdb",
	"clickhouse",
	"elasticsearch",
	"opensearch",
	"minio",
	"neo4j",
	"cockroach",
	"libsql",
	"sqld",
	"redis-stack",
	"redis-stack-server",
	"mssql",
	"meilisearch",
	"qdrant",
	"typesense",
	"weaviate",
	"surrealdb",
	"nats",
]);

const isObject = (value: unknown): value is SpecObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toStringList = (value: unknown): string[] =>
	Array.isArray(value) ? value.map((item) => String(item)) : [];

/** Base name of an image reference: registry, tag and digest removed. */
export const getImageBaseName = (image: string) => {
	const withoutDigest = image.split("@")[0] ?? "";
	const lastSegment = withoutDigest.split("/").pop() ?? "";
	return (lastSegment.split(":")[0] ?? "").toLowerCase();
};

/** `a-b` with a <= b, as host port numbers. `undefined` for anything else. */
const parsePortRange = (value: string) => {
	const match = /^(\d+)-(\d+)$/.exec(value.trim());
	if (!match) return undefined;
	const first = Number(match[1]);
	const last = Number(match[2]);
	if (first < 1 || last > 65535 || first > last) return undefined;
	return { first, last, size: last - first + 1 };
};

/**
 * What one port entry publishes on the host: nothing (`none`: only a container
 * port, or `ip::container`, a random host port), a host port range with one
 * container port (`range`, with its size), or anything else (`fixed`: one host
 * port, a container port range, a value that is still a variable).
 */
type PublishedPort =
	| { kind: "none" }
	| { kind: "range"; size: number }
	| { kind: "fixed" };

const describePublishedPort = (port: unknown): PublishedPort => {
	if (isObject(port)) {
		const published = port.published;
		if (published === undefined || published === null) return { kind: "none" };
		const text = String(published).trim();
		if (text === "") return { kind: "none" };
		const range = parsePortRange(text);
		const target = String(port.target ?? "").trim();
		if (!range || !/^\d+$/.test(target)) return { kind: "fixed" };
		return { kind: "range", size: range.size };
	}
	// The protocol suffix and a bracketed IPv6 host address are not ports.
	let value = String(port)
		.replace(/\/[a-z]+$/i, "")
		.replace(/^\[[^\]]*\]:/, "");
	value = value.trim();
	const parts = value.split(":");
	if (parts.length === 1) return { kind: "none" };
	// `host:container` or `ip:host:container`; `ip::container` publishes a random port.
	const host = (parts[parts.length - 2] ?? "").trim();
	if (host.length === 0) return { kind: "none" };
	const container = (parts[parts.length - 1] ?? "").trim();
	const range = parsePortRange(host);
	if (!range || !/^\d+$/.test(container)) return { kind: "fixed" };
	return { kind: "range", size: range.size };
};

/**
 * Why the published ports of a service with `replicas` containers cannot roll,
 * or `undefined`. During the rollout the old and the new replicas run side by
 * side, so a host port range must hold at least 2 x replicas ports (Docker
 * gives each container a free port of the range); a single host port cannot be
 * bound twice.
 */
const getPublishedPortsProblem = (ports: unknown, replicas: number) => {
	if (!Array.isArray(ports)) return undefined;
	const needed = 2 * replicas;
	const described = ports.map(describePublishedPort);
	if (described.some((port) => port.kind === "fixed")) {
		return `A fixed host port is published: the second replica could not bind it. Use expose and Traefik, or publish a host port range for one container port; the range must hold at least 2 x replicas ports (${needed} here).`;
	}
	const small = described.find(
		(port): port is { kind: "range"; size: number } =>
			port.kind === "range" && port.size < needed,
	);
	if (small) {
		return `A published host port range holds ${small.size} ports, but the range must hold at least 2 x replicas ports (${needed} here): the old and the new replicas run side by side during the rollout.`;
	}
	return undefined;
};

/** A whole number as Compose takes it for `scale` / `deploy.replicas`, or `undefined`. */
const parseReplicaValue = (value: unknown) => {
	if (typeof value === "number") {
		return Number.isInteger(value) ? value : undefined;
	}
	if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
		return Number(value.trim());
	}
	return undefined;
};

/**
 * How many containers the service runs (`scale` or `deploy.replicas`, 1 when
 * neither is set), or why that cannot be rolled: a value that is not a whole
 * number from 1 to `ROLLING_MAX_REPLICAS` (after interpolation), or `scale` and
 * `deploy.replicas` that disagree.
 */
export const getRollingReplicaCount = (
	definition: SpecObject,
): { count: number } | { problem: string } => {
	const deploy = isObject(definition.deploy) ? definition.deploy : undefined;
	const values: Array<[string, unknown]> = [];
	if (definition.scale !== undefined && definition.scale !== null) {
		values.push(["scale", definition.scale]);
	}
	if (deploy?.replicas !== undefined && deploy.replicas !== null) {
		values.push(["deploy.replicas", deploy.replicas]);
	}
	let count: number | undefined;
	for (const [key, raw] of values) {
		const parsed = parseReplicaValue(raw);
		if (parsed === undefined || parsed < 1 || parsed > ROLLING_MAX_REPLICAS) {
			return {
				problem: `${key} is "${String(raw)}": only a whole number from 1 to ${ROLLING_MAX_REPLICAS} can be rolled.`,
			};
		}
		if (count !== undefined && count !== parsed) {
			return {
				problem: `scale (${count}) and deploy.replicas (${parsed}) disagree.`,
			};
		}
		count = parsed;
	}
	return { count: count ?? 1 };
};

/** True when a port entry binds a host address (`127.0.0.1:80:80`, `host_ip`). */
const bindsHostIp = (port: unknown) => {
	if (isObject(port))
		return typeof port.host_ip === "string" && port.host_ip !== "";
	const value = String(port)
		.replace(/\/[a-z]+$/i, "")
		.trim();
	if (/^\[[^\]]*\]:/.test(value)) return true;
	const parts = value.split(":");
	return parts.length === 3 && /^[\d.]+$/.test(parts[0] ?? "");
};

const hasStaticAddress = (service: SpecObject) => {
	if (service.mac_address) return true;
	const networks = service.networks;
	if (!isObject(networks)) return false;
	return Object.values(networks).some(
		(entry) =>
			isObject(entry) &&
			Boolean(entry.ipv4_address || entry.ipv6_address || entry.mac_address),
	);
};

const sharesNamespaceWith = (other: SpecObject, target: string) => {
	const ref = `service:${target}`;
	if (other.network_mode === ref || other.pid === ref || other.ipc === ref) {
		return true;
	}
	return toStringList(other.volumes_from).some(
		(entry) => entry.split(":")[0] === target,
	);
};

/**
 * Go-style duration as Compose accepts it (`30s`, `1m30s`, `500ms`, `1.5h`) in
 * seconds. `undefined` for anything else.
 */
export const parseComposeDurationSeconds = (value: unknown) => {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const pattern = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
	const unitSeconds: Record<string, number> = {
		ns: 1e-9,
		us: 1e-6,
		µs: 1e-6,
		ms: 1e-3,
		s: 1,
		m: 60,
		h: 3600,
	};
	let total = 0;
	let consumed = 0;
	for (const match of value.trim().matchAll(pattern)) {
		total += Number(match[1]) * (unitSeconds[match[2] ?? ""] ?? 0);
		consumed += match[0].length;
	}
	if (consumed !== value.trim().length) return undefined;
	return total;
};

const HEALTHCHECK_DEFAULT_INTERVAL_SECONDS = 30;
const HEALTHCHECK_DEFAULT_RETRIES = 3;
const HEALTHCHECK_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Time Docker can need to judge a new replica: `start_period + retries *
 * (interval + timeout)`. A failing probe runs up to its `timeout` before the
 * next one is scheduled, so the last of the `retries` failures lands that late.
 * The health timeout has to exceed it, otherwise a replica would be removed
 * before Docker has even finished judging it.
 */
export const getHealthcheckSettleSeconds = (healthcheck: SpecObject) => {
	// Docker reads a zero (or unset) interval, timeout or retries as its default.
	const positive = (value: number | undefined, fallback: number) =>
		value !== undefined && value > 0 ? value : fallback;
	const interval = positive(
		parseComposeDurationSeconds(healthcheck.interval),
		HEALTHCHECK_DEFAULT_INTERVAL_SECONDS,
	);
	const startPeriod =
		parseComposeDurationSeconds(healthcheck.start_period) ?? 0;
	// An interpolated value (`retries: ${RETRIES:-3}`) is a string of digits.
	const retries = positive(
		parseReplicaValue(healthcheck.retries),
		HEALTHCHECK_DEFAULT_RETRIES,
	);
	const probeTimeout = positive(
		parseComposeDurationSeconds(healthcheck.timeout),
		HEALTHCHECK_DEFAULT_TIMEOUT_SECONDS,
	);
	return startPeriod + retries * (interval + probeTimeout);
};

const isNoneTest = (test: unknown) =>
	test === "NONE" || (Array.isArray(test) && test[0] === "NONE");

// ---------------------------------------------------------------------------
// Taking the old container out of rotation (T-9197)
// ---------------------------------------------------------------------------

/**
 * Traefik's docker provider only lists containers again on the `start`, `die`
 * and `health_status` events, and it keeps a container that is running and
 * healthy. The old container of a rolling replace carries the same labels as
 * the new replica, so it stays a backend of the same load balancer until it
 * dies: an app that ignores SIGTERM is SIGKILLed at the stop grace with Traefik
 * still routing to it.
 *
 * So the old container is made unhealthy first. The healthcheck of a rolled
 * service is wrapped at deploy time so that it fails while this file exists;
 * the script puts the file there with `docker cp` (no binary needed in the
 * image), waits for `unhealthy` (a `health_status` event, so Traefik drops the
 * container), waits past the providers throttle, and only then stops it.
 */
export const ROLLING_DRAIN_MARKER_PATH = "/tmp/.dokploy-drain";

/**
 * Wait after the old container is unhealthy, before it is stopped: Traefik's
 * `providersThrottleDuration` (2 s unless set; Dokploy does not set it) plus
 * one second of margin.
 */
export const ROLLING_ROUTE_SETTLE_SECONDS = 3;

/** Slack added to the bound of the wait for `unhealthy`, which is capped at the longest health timeout. */
const ROLLING_UNHEALTHY_SLACK_SECONDS = 3;

/** Slack added to the wait for the old container to be healthy again (interval + timeout + this). */
const ROLLING_RECOVER_SLACK_SECONDS = 5;

const DRAIN_WRAP_PREFIX = `[ ! -s ${ROLLING_DRAIN_MARKER_PATH} ] && (`;

/** The shell command of a healthcheck test, when the test is shell form. */
const getShellTestCommand = (test: unknown): string | undefined => {
	if (typeof test === "string") {
		return test.trim() === "" || test === "NONE" ? undefined : test;
	}
	if (
		Array.isArray(test) &&
		test.length === 2 &&
		test[0] === "CMD-SHELL" &&
		typeof test[1] === "string" &&
		test[1].trim() !== ""
	) {
		return test[1];
	}
	return undefined;
};

/**
 * The healthcheck test of a rolled service, made to fail while the drain marker
 * exists. A string test is CMD-SHELL and stays a string; a `["CMD-SHELL", cmd]`
 * test stays that. Exec-form (`["CMD", ...]`), NONE and anything else come back
 * untouched (same reference): their old container is stopped as before.
 *
 * `[ ! -s <marker> ] && ( <original> )`: `[` is a shell builtin, the marker is
 * judged by size so an empty file undoes the drain, and the subshell keeps an
 * original with `||` or `;` a single command. No `$` is added, so Compose's
 * interpolation (`$$` for a literal `$`) has nothing to change and the user's own
 * `$` stay exactly as written. The original goes on lines of its own when it
 * could hide the closing parenthesis (a `#` comment, several lines).
 *
 * Pure and idempotent: the same test always gives the same text (the service's
 * config hash is stable across deploys), and a test that is already wrapped is
 * returned as it is.
 */
export const wrapHealthcheckTestForDrain = (test: unknown): unknown => {
	const command = getShellTestCommand(test);
	if (command === undefined) return test;
	if (command.startsWith(DRAIN_WRAP_PREFIX)) return test;
	const wrapped = /[\n#]/.test(command)
		? `${DRAIN_WRAP_PREFIX}\n${command}\n)`
		: `${DRAIN_WRAP_PREFIX} ${command} )`;
	return typeof test === "string" ? wrapped : ["CMD-SHELL", wrapped];
};

/**
 * The spec with the healthcheck of every listed, rolled service wrapped (see
 * `wrapHealthcheckTestForDrain`). Never mutates its input: a healthcheck shared
 * through a YAML anchor is replaced for the rolled service only. Returns the
 * same object when nothing needed wrapping, so a compose that does not roll
 * renders exactly as before.
 */
export const applyRollingDrainHealthchecks = <T>(
	spec: T,
	services: string[],
): T => {
	const definitions = (spec as RollingSpec | null)?.services;
	if (!definitions || services.length === 0) return spec;
	let wrapped: Record<string, SpecObject | null | undefined> | undefined;
	for (const name of services) {
		const definition = definitions[name];
		if (!isObject(definition) || !isObject(definition.healthcheck)) continue;
		if (definition.healthcheck.disable === true) continue;
		const test = wrapHealthcheckTestForDrain(definition.healthcheck.test);
		if (test === definition.healthcheck.test) continue;
		wrapped ??= { ...definitions };
		wrapped[name] = {
			...definition,
			healthcheck: { ...definition.healthcheck, test },
		};
	}
	if (!wrapped) return spec;
	return { ...(spec as object), services: wrapped } as T;
};

export interface RollingDrainWarning {
	service: string;
	message: string;
}

const trimPath = (path: string) =>
	path.length > 1 ? path.replace(/\/+$/, "") : path;

/** Container paths the service mounts something on: volumes, binds, tmpfs. */
const getMountTargets = (definition: SpecObject): string[] => {
	const targets: string[] = [];
	if (Array.isArray(definition.volumes)) {
		for (const volume of definition.volumes) {
			if (isObject(volume)) {
				if (typeof volume.target === "string") targets.push(volume.target);
				continue;
			}
			// `source:target[:mode]`; a single part is an anonymous volume's target.
			const parts = String(volume).split(":");
			const target = parts.length === 1 ? parts[0] : parts[1];
			if (target) targets.push(target);
		}
	}
	const tmpfs = definition.tmpfs;
	for (const entry of Array.isArray(tmpfs) ? tmpfs : tmpfs ? [tmpfs] : []) {
		const target = String(entry).split(":")[0];
		if (target) targets.push(target);
	}
	return targets.map(trimPath);
};

/**
 * Rolled services whose old container cannot be taken out of rotation before it
 * is stopped, from the compose alone: an exec-form healthcheck (the marker
 * cannot be put in front of it), or a read-only root file system or a mount on
 * `/` or `/tmp` (the marker would be shared with the new replica, or could not
 * be written). They still roll and are stopped as before. Never a blocker, and
 * silent for a service that can be drained.
 */
export const getRollingDrainWarnings = (
	spec: RollingSpec | null | undefined,
	services: string[],
): RollingDrainWarning[] => {
	const warnings: RollingDrainWarning[] = [];
	for (const service of services) {
		const definition = spec?.services?.[service];
		const healthcheck = definition?.healthcheck;
		if (
			!definition ||
			!isObject(healthcheck) ||
			healthcheck.test === undefined
		) {
			continue;
		}
		if (healthcheck.disable === true || isNoneTest(healthcheck.test)) continue;
		const stoppedAsBefore =
			"the old container is stopped while Traefik still routes to it.";
		if (getShellTestCommand(healthcheck.test) === undefined) {
			const execForm =
				Array.isArray(healthcheck.test) && healthcheck.test[0] === "CMD";
			warnings.push({
				service,
				message: execForm
					? `"${service}": the healthcheck is exec form, so ${stoppedAsBefore} A CMD-SHELL healthcheck (it needs a shell in the image) avoids that.`
					: `"${service}": the healthcheck test has a shape Dokploy cannot wrap, so ${stoppedAsBefore} Use a plain string or ["CMD-SHELL", "..."].`,
			});
			continue;
		}
		const covered =
			definition.read_only === true ||
			getMountTargets(definition).some((target) =>
				["/", "/tmp", ROLLING_DRAIN_MARKER_PATH].includes(target),
			);
		if (covered) {
			warnings.push({
				service,
				message: `"${service}": /tmp is read-only or a volume, bind mount or tmpfs, so ${stoppedAsBefore}`,
			});
		}
	}
	return warnings;
};

/**
 * Why `service` cannot be rolled, from the rendered spec. Empty = eligible.
 * Pure: no I/O, so the same function runs on save (the settings card) and at
 * deploy time (drift detection).
 */
export const getRollingEligibility = ({
	spec,
	service,
	composeType,
	hasCustomCommand = false,
	freshVolumes = false,
}: RollingEligibilityInput): RollingBlocker[] => {
	const blockers: RollingBlocker[] = [];
	const add = (code: RollingBlockerCode, message: string) =>
		blockers.push({ code, message });

	if (composeType !== "docker-compose") {
		add(
			"stack",
			"Only Docker Compose services can be rolled. A stack uses swarm: set deploy.update_config.order to start-first instead (see the docs).",
		);
	}
	if (hasCustomCommand) {
		add(
			"custom-command",
			"The service has a custom compose command, Dokploy does not control what runs.",
		);
	}
	if (freshVolumes) {
		add(
			"fresh-volumes",
			"A deploy with fresh volumes is destructive by design and is never rolled.",
		);
	}

	const services = spec.services ?? {};
	const definition = services[service];
	if (!isObject(definition)) {
		add("service-missing", `The compose file has no service "${service}".`);
		return blockers;
	}

	if (definition.container_name) {
		add(
			"container-name",
			"container_name is set: Compose cannot run two replicas.",
		);
	}
	const replicaCount = getRollingReplicaCount(definition);
	const portsProblem = getPublishedPortsProblem(
		definition.ports,
		"count" in replicaCount ? replicaCount.count : 1,
	);
	if (portsProblem) add("published-ports", portsProblem);
	const networkMode =
		typeof definition.network_mode === "string" ? definition.network_mode : "";
	if (
		networkMode === "host" ||
		networkMode.startsWith("service:") ||
		networkMode.startsWith("container:")
	) {
		add(
			"network-mode",
			`network_mode "${networkMode}" shares a network namespace, two replicas cannot.`,
		);
	}
	if ("problem" in replicaCount) add("replicas", replicaCount.problem);
	if (hasStaticAddress(definition)) {
		add(
			"static-address",
			"A static ipv4_address, ipv6_address or mac_address is set: the second replica could not take it.",
		);
	}
	for (const [otherName, other] of Object.entries(services)) {
		if (otherName === service || !isObject(other)) continue;
		if (sharesNamespaceWith(other, service)) {
			add(
				"namespace-dependent",
				`Service "${otherName}" shares the network, pid, ipc namespace or volumes of "${service}": replacing it would break "${otherName}".`,
			);
		}
	}

	const healthcheck = definition.healthcheck;
	if (!isObject(healthcheck)) {
		add(
			"no-healthcheck",
			"No healthcheck in the compose file: without a readiness signal Traefik would route to a booting container. An image-level HEALTHCHECK is not visible here.",
		);
	} else if (healthcheck.disable === true || isNoneTest(healthcheck.test)) {
		add("healthcheck-disabled", "The healthcheck is disabled.");
	} else if (healthcheck.test === undefined) {
		add(
			"no-healthcheck",
			"The healthcheck has no test in the compose file (an image-level HEALTHCHECK is not visible here).",
		);
	} else {
		// The wait is raised to cover the healthcheck; only one that cannot fit
		// even in the longest wait is refused.
		const settle = getHealthcheckSettleSeconds(healthcheck);
		if (settle >= ROLLING_HEALTH_TIMEOUT_MAX_SECONDS) {
			add(
				"health-timeout-too-short",
				`The healthcheck can take ${settle}s to settle (start_period + retries x (interval + timeout)), which does not fit in the longest health timeout (${ROLLING_HEALTH_TIMEOUT_MAX_SECONDS}s). Shorten its interval, timeout or retries.`,
			);
		}
	}

	if (typeof definition.image === "string") {
		const base = getImageBaseName(definition.image);
		// mcr.microsoft.com/mssql/server has a generic base name.
		const mssql = definition.image.toLowerCase().includes("/mssql/");
		if (STATEFUL_IMAGE_NAMES.has(base) || mssql) {
			add(
				"stateful-image",
				`The image "${base}" looks like a datastore. Stateful services keep the plain recreate.`,
			);
		}
	}

	return blockers;
};

export interface StackPreflightWarning {
	service: string;
	issues: string[];
}

/**
 * Swarm stacks are not rolled by Dokploy: swarm does it when the compose asks
 * for it. A stack service with no healthcheck or without `update_config.order:
 * start-first` silently stops the old task first, so say so. Never changes the
 * compose.
 */
export const getStackPreflightWarnings = (
	spec: RollingSpec,
): StackPreflightWarning[] => {
	const warnings: StackPreflightWarning[] = [];
	for (const [service, definition] of Object.entries(spec.services ?? {})) {
		if (!isObject(definition)) continue;
		const issues: string[] = [];
		const healthcheck = definition.healthcheck;
		if (
			!isObject(healthcheck) ||
			healthcheck.disable === true ||
			healthcheck.test === undefined ||
			isNoneTest(healthcheck.test)
		) {
			issues.push("no healthcheck: swarm cannot tell when a new task is ready");
		}
		if (Array.isArray(definition.ports) && definition.ports.some(bindsHostIp)) {
			issues.push(
				"a published port binds a host address: swarm ingress ignores it and listens on all interfaces",
			);
		}
		const deploy = isObject(definition.deploy) ? definition.deploy : undefined;
		const updateConfig = isObject(deploy?.update_config)
			? deploy.update_config
			: undefined;
		if (updateConfig?.order !== "start-first") {
			issues.push(
				"deploy.update_config.order is not start-first: swarm stops the old task before it starts the new one",
			);
		}
		if (issues.length > 0) warnings.push({ service, issues });
	}
	return warnings;
};

/**
 * The wait for a new replica: the configured timeout, raised when a selected
 * service's healthcheck needs longer (`start_period + retries x (interval +
 * timeout)` plus one second), never above the schema maximum. Waiting less
 * would remove a replica Docker has not finished judging.
 */
export const getEffectiveHealthTimeoutSeconds = (
	spec: RollingSpec,
	services: string[],
	configured: number,
) => {
	let needed = configured;
	for (const service of services) {
		const healthcheck = spec.services?.[service]?.healthcheck;
		if (isObject(healthcheck)) {
			needed = Math.max(
				needed,
				Math.ceil(getHealthcheckSettleSeconds(healthcheck)) + 1,
			);
		}
	}
	return Math.min(needed, ROLLING_HEALTH_TIMEOUT_MAX_SECONDS);
};

export interface RollingInterpolatedSpec {
	/** The spec to judge: services interpolated where that worked, raw otherwise. */
	spec: RollingSpec;
	/** Selected services judged on the raw compose file, and why (one line each). */
	notices: Array<{ service: string; message: string }>;
}

const RAW_SPEC_NOTE =
	"is judged on the compose file as written (variables not resolved).";

/**
 * A copy of `spec` with the `${VAR}` references of each service resolved the
 * way `docker compose` resolves them on the deploy, so that `deploy.replicas:
 * ${WEB_REPLICAS:-1}` or a port range built from variables is judged on its
 * value. Only used to decide what is rolled: the compose file that is written
 * and deployed is never changed.
 *
 * Never throws. A service that cannot be interpolated (an invalid `${`, a
 * required variable that is unset, a variable whose value is not known) keeps
 * its raw definition, which is exactly what was judged before; so does every
 * service when the variables cannot be prepared (`getLookup` throws, e.g. an
 * unresolved vault reference). A notice is returned for each selected service
 * that falls back and holds a `$`.
 */
export const interpolateRollingSpec = (
	spec: RollingSpec,
	selected: string[],
	getLookup: () => ComposeVariableLookup,
): RollingInterpolatedSpec => {
	const services = spec.services;
	if (!services) return { spec, notices: [] };
	const hasDollar = (value: unknown) => {
		try {
			return JSON.stringify(value)?.includes("$") ?? false;
		} catch {
			return false;
		}
	};
	if (!Object.values(services).some(hasDollar)) return { spec, notices: [] };
	const notices: RollingInterpolatedSpec["notices"] = [];
	const reasonOf = (error: unknown) =>
		error instanceof Error ? error.message : String(error);
	let lookup: ComposeVariableLookup;
	try {
		lookup = getLookup();
	} catch (error) {
		for (const name of selected) {
			if (hasDollar(services[name])) {
				notices.push({
					service: name,
					message: `Rolling replace: the variables of the compose could not be prepared (${reasonOf(error)}), so "${name}" ${RAW_SPEC_NOTE}`,
				});
			}
		}
		return { spec, notices };
	}
	const interpolated: Record<string, SpecObject | null | undefined> = {};
	for (const [name, definition] of Object.entries(services)) {
		if (!hasDollar(definition)) {
			interpolated[name] = definition;
			continue;
		}
		try {
			interpolated[name] = interpolateComposeValue(definition, lookup);
		} catch (error) {
			interpolated[name] = definition;
			if (selected.includes(name)) {
				notices.push({
					service: name,
					message: `Rolling replace: the variables of "${name}" could not be resolved (${reasonOf(error)}), so it ${RAW_SPEC_NOTE}`,
				});
			}
		}
	}
	return { spec: { ...spec, services: interpolated }, notices };
};

export interface RollingPlanInput {
	settings: ComposeRollingReplace;
	spec: RollingSpec;
	composeType: string;
	hasCustomCommand: boolean;
	freshVolumes: boolean;
}

export interface RollingServicePlan {
	/** Eligible at deploy time: rolled. */
	rolled: string[];
	/** Containers each rolled service runs (`scale` / `deploy.replicas`, 1 when unset). */
	replicas: Record<string, number>;
	/** The wait for the new replica, raised to cover the rolled services' healthchecks. */
	healthTimeoutSeconds: number;
	/** Selected but no longer eligible: a normal recreate, with a warning. */
	fallbacks: Array<{ service: string; blockers: RollingBlocker[] }>;
}

/**
 * Which of the selected services are rolled by this deploy. Settings can drift
 * from the compose (edited since they were saved), so every service is checked
 * again against the spec this deploy runs; one that no longer qualifies is
 * recreated normally, never a failed deploy.
 */
export const planRollingServices = ({
	settings,
	spec,
	composeType,
	hasCustomCommand,
	freshVolumes,
}: RollingPlanInput): RollingServicePlan => {
	const plan: RollingServicePlan = {
		rolled: [],
		replicas: {},
		fallbacks: [],
		healthTimeoutSeconds: settings.healthTimeoutSeconds,
	};
	for (const service of settings.services) {
		const blockers = getRollingEligibility({
			spec,
			service,
			composeType,
			hasCustomCommand,
			freshVolumes,
		});
		if (blockers.length === 0) {
			plan.rolled.push(service);
			const definition = spec.services?.[service];
			const count = isObject(definition)
				? getRollingReplicaCount(definition)
				: { count: 1 };
			plan.replicas[service] = "count" in count ? count.count : 1;
		} else {
			plan.fallbacks.push({ service, blockers });
		}
	}
	plan.healthTimeoutSeconds = getEffectiveHealthTimeoutSeconds(
		spec,
		plan.rolled,
		settings.healthTimeoutSeconds,
	);
	return plan;
};

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

export interface RollingScriptOptions {
	appName: string;
	/**
	 * `compose -p <app> [--project-directory ..] [--env-file ..] -f <file> [-f
	 * <override>]`: the invocation prefix of the deploy's own `up`, so every
	 * subcommand resolves the project (and its config hash) exactly like it.
	 */
	invocation: string;
	/** Services to roll, in the order they are rolled. Already validated names. */
	services: string[];
	/**
	 * Containers each rolled service runs (`scale` / `deploy.replicas`); a
	 * service that is not listed runs one. All of them are replaced together:
	 * N new replicas next to the old ones, then the old ones are removed.
	 */
	replicas?: Record<string, number>;
	/** Rolled services with a `build:` section (built before anything is touched). */
	buildServices?: string[];
	/** Rolled image-only services to pull first (`pullImagesOnDeploy`). */
	pullServices?: string[];
	/** Services of a build-server deploy are pulled earlier and never built here. */
	remoteBuild: boolean;
	pullAlways: boolean;
	healthTimeoutSeconds: number;
	/**
	 * Wait after the old container is out of rotation and before it is stopped,
	 * for requests already in flight on it. Without a take-out (see
	 * `dokploy_roll_take_out`) it is the wait between "new replica healthy" and
	 * the stop, as it always was.
	 */
	drainSeconds: number;
	/** Wait after the old container reports unhealthy, for Traefik to reload its routes. */
	routeSettleSeconds?: number;
	pollIntervalSeconds?: number;
}

export interface RollingScript {
	/** Function definitions: emitted once, before the `up` position. */
	definitions: string;
	/** The command that takes the place of the deploy's `up`. */
	call: string;
}

/** Name of the shell function that takes the place of the `up` line. */
export const ROLLING_RUN_FUNCTION = "dokploy_roll_run";

/**
 * True when a deploy script contains the rolling replace (not the plain `up` a
 * compose falls back to when no service can be rolled). Only that script has a
 * cancel trap, so only it is worth signalling on the serving host.
 */
export const commandRunsRollingReplace = (command: string) =>
	command.includes(`${ROLLING_RUN_FUNCTION}() {`);

/**
 * Shell: the rolling replace as functions, plus the call that replaces `up`.
 *
 * Everything runs in one shell with explicit `|| return 1`s: the call sits on
 * the left of the deploy script's `|| { ...failure... }`, where `set -e` does
 * not apply.
 *
 * Order, with every service named explicitly on every `up`:
 * 1. build / pull the rolled services (nothing running is touched);
 * 2. `up -d --no-deps <others>` when there are non-rolled services (taken from
 *    `config --services`, so inactive profiles stay inactive);
 * 3. each rolled service: reconcile leftovers, then skip (hash and image id
 *    unchanged), plain `up` (nothing running) or the rollout itself;
 * 4. `up -d --no-recreate --remove-orphans <config --services>`.
 *
 * Old and new containers are told apart by the ids recorded before the
 * scale-up, never by Compose's own scale-down, which removes the
 * highest-numbered container (the new one).
 *
 * A TERM / INT / HUP (the cancel launcher's group signal, see
 * `remote-build-cancel.ts`; a `pkill` or a Ctrl-C by hand) removes the replica
 * that was not promoted yet. A SIGKILL cannot be caught: the next deploy reconciles.
 *
 * The `up` of the services that are not rolled (and the final `up`) run in a
 * session of their own (`setsid`), so a cancel that signals this script's
 * process group does not kill them half way through a recreate: the trap runs
 * once they return. A cancel therefore waits for such a step. A step that is
 * still running when the cancel's grace ends keeps running on its own.
 */
export const getRollingReplaceScript = ({
	appName,
	invocation,
	services,
	replicas = {},
	buildServices = [],
	pullServices = [],
	remoteBuild,
	pullAlways,
	healthTimeoutSeconds,
	drainSeconds,
	routeSettleSeconds = ROLLING_ROUTE_SETTLE_SECONDS,
	pollIntervalSeconds = ROLLING_POLL_INTERVAL_SECONDS,
}: RollingScriptOptions): RollingScript => {
	const timeout = Math.trunc(healthTimeoutSeconds);
	const drain = Math.trunc(drainSeconds);
	const routeSettle = Math.trunc(routeSettleSeconds);
	const poll = pollIntervalSeconds;
	const projectFilter = quote([`label=com.docker.compose.project=${appName}`]);
	const buildFlag = remoteBuild ? "--no-build" : "--build";
	const pullFlag = pullAlways ? "--pull always " : "";
	// `web=2 docs=1`: only whole numbers 1..ROLLING_MAX_REPLICAS get in (the
	// names are validated); anything else leaves the service at one.
	const replicaList = services
		.map((service) => {
			const count = replicas[service];
			return count !== undefined &&
				Number.isInteger(count) &&
				count >= 1 &&
				count <= ROLLING_MAX_REPLICAS
				? `${service}=${count}`
				: `${service}=1`;
		})
		.join(" ");

	const buildBlock =
		buildServices.length > 0
			? `
		DR_B="";
		for DR_S in $DR_ROLL; do case " $DOKPLOY_ROLL_BUILD " in *" $DR_S "*) DR_B="$DR_B $DR_S";; esac; done;
		if [ -n "$DR_B" ]; then dokploy_roll_log "building:$DR_B"; dokploy_roll_compose build ${pullAlways ? "--pull " : ""}$DR_B 2>&1 || return 1; fi;`
			: "";
	const pullBlock =
		pullServices.length > 0
			? `
		DR_P="";
		for DR_S in $DR_ROLL; do case " $DOKPLOY_ROLL_PULL " in *" $DR_S "*) DR_P="$DR_P $DR_S";; esac; done;
		if [ -n "$DR_P" ]; then dokploy_roll_log "pulling:$DR_P"; dokploy_roll_compose pull $DR_P 2>&1 || return 1; fi;`
			: "";
	// After the take-out: with the old container out of rotation the delay lets
	// requests in flight on it finish; without it, it is the wait it always was.
	const drainBlock =
		drain > 0
			? `
		if [ "$DR_OUT" = "1" ]; then dokploy_roll_log "$1: the old container is out of rotation, waiting ${drain}s before the old container is stopped so that requests in flight finish"; else dokploy_roll_log "$1: the new replica is healthy, waiting ${drain}s before the old container is stopped"; fi;
		dokploy_roll_sleep ${drain};`
			: "";

	// Always emitted: DR_OTHERS comes from `config --services`, which also sees
	// included and extended services the raw spec lacks, and the step is skipped
	// at run time when there are none.
	const othersBlock = `
			if [ -n "$DR_OTHERS" ]; then
				dokploy_roll_log "updating the services that are not rolled:$DR_OTHERS";
				dokploy_roll_compose_shielded up -d --no-deps ${pullFlag}${buildFlag} $DR_OTHERS 2>&1 || return 1;
			fi;`;

	const definitions = `
		DOKPLOY_ROLL_SELECTED=${quote([services.join(" ")])};
		DOKPLOY_ROLL_BUILD=${quote([buildServices.join(" ")])};
		DOKPLOY_ROLL_PULL=${quote([pullServices.join(" ")])};
		DOKPLOY_ROLL_REPLICAS=${quote([replicaList])};
		DOKPLOY_ROLL_PROMOTED=0; DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_ABORTING=0;
		DOKPLOY_ROLL_SVC=""; DOKPLOY_ROLL_BEFORE=""; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_REASON=""; DR_EMPTY="";
		dokploy_roll_log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Rolling replace: $*"; };
		dokploy_roll_sleep() { sleep "$1" & wait $!; };
		dokploy_roll_compose() { env -i PATH="$PATH" HOME="$HOME" ${NEUTRALISED_CLI_ENV} docker ${invocation} "$@"; };
		dokploy_roll_compose_shielded() { if command -v setsid >/dev/null 2>&1; then ( exec setsid env -i PATH="$PATH" HOME="$HOME" ${NEUTRALISED_CLI_ENV} docker ${invocation} "$@" ); else dokploy_roll_compose "$@"; fi; };
		dokploy_roll_ids() { docker ps -aq --no-trunc --filter ${projectFilter} --filter "label=com.docker.compose.service=$1" --filter "label=com.docker.compose.oneoff=False"; };
		dokploy_roll_running_ids() { docker ps -q --no-trunc --filter ${projectFilter} --filter "label=com.docker.compose.service=$1" --filter "label=com.docker.compose.oneoff=False"; };
		dokploy_roll_replicas() {
			DR_RN=1;
			for DR_R in $DOKPLOY_ROLL_REPLICAS; do case "$DR_R" in "$1="*) DR_RN=$(printf '%s' "$DR_R" | cut -d= -f2);; esac; done;
			case "$DR_RN" in ''|*[!0-9]*|0) DR_RN=1;; esac;
			echo "$DR_RN";
		};
		dokploy_roll_remove() {
			if [ $# -eq 0 ]; then return 0; fi;
			docker stop "$@" >/dev/null 2>&1 || true;
			docker rm -f "$@" >/dev/null 2>&1;
		};
		dokploy_roll_honours_drain() {
			DR_WHY="";
			DR_I=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}|{{range .Mounts}}{{.Destination}} {{end}}|{{range $k, $v := .HostConfig.Tmpfs}}{{$k}} {{end}}' "$1" 2>/dev/null) || DR_I="";
			if [ -z "$DR_I" ]; then DR_WHY="the old container could not be inspected"; return 1; fi;
			if [ "$(printf '%s' "$DR_I" | cut -d'|' -f1)" = "true" ]; then DR_WHY="its root file system is read-only"; return 1; fi;
			set -f;
			for DR_M in $(printf '%s' "$DR_I" | cut -d'|' -f2) $(printf '%s' "$DR_I" | cut -d'|' -f3); do
				case "$DR_M" in
					/|/tmp|/tmp/|${ROLLING_DRAIN_MARKER_PATH}) set +f; DR_WHY="$DR_M is a mount or a tmpfs, so the marker would be shared with the new replica or lost"; return 1;;
				esac;
			done;
			set +f;
			DR_T=$(docker inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{end}}' "$1" 2>/dev/null) || { DR_WHY="the old container could not be inspected"; return 1; };
			if [ -z "$DR_T" ]; then DR_WHY="it has no healthcheck"; return 1; fi;
			if ! printf '%s' "$DR_T" | grep -qF -- '${ROLLING_DRAIN_MARKER_PATH}'; then DR_WHY="its healthcheck does not honour the marker (Dokploy could not wrap its test, or the container was started before the marker existed)"; return 1; fi;
			return 0;
		};
		dokploy_roll_drain_bound() {
			DR_HC=$(docker inspect -f '{{printf "%d %d %d %d" .Config.Healthcheck.Interval .Config.Healthcheck.Timeout .Config.Healthcheck.Retries .Config.Healthcheck.StartPeriod}}' "$1" 2>/dev/null) || DR_HC="";
			printf '%s\\n' "$DR_HC" | awk -v cap=${ROLLING_HEALTH_TIMEOUT_MAX_SECONDS} '{ i = $1 / 1e9; t = $2 / 1e9; r = $3; p = $4 / 1e9; if (i <= 0) i = 30; if (t <= 0) t = 30; if (r <= 0) r = 3; if (p < 0) p = 0; b = p + (i + t) * r + i + ${ROLLING_UNHEALTHY_SLACK_SECONDS}; b = int(b) + (b > int(b)); if (b > cap) b = cap; if (b < 1) b = 1; print b }';
		};
		dokploy_roll_new_state() {
			docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo "missing none";
		};
		dokploy_roll_new_bad_state() {
			for DR_NB in $1; do
				DR_NBS=$(dokploy_roll_new_state "$DR_NB");
				if [ "$DR_NBS" != "running healthy" ]; then echo "$DR_NBS"; return 0; fi;
			done;
			return 1;
		};
		dokploy_roll_wait_out() {
			DR_UDEADLINE=$(( $(date +%s) + $2 ));
			DR_ULAST="";
			while :; do
				DR_UST=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null) || DR_UST="missing none";
				if [ "$DR_UST" != "$DR_ULAST" ]; then dokploy_roll_log "$DOKPLOY_ROLL_SVC: the old container is $DR_UST"; DR_ULAST="$DR_UST"; fi;
				case "$DR_UST" in
					"running unhealthy"|"exited "*|"dead "*|"removing "*|"paused "*|"missing "*) return 0;;
					"running none") return 1;;
				esac;
				# A new replica that went bad is for the caller to undo: stop waiting.
				if dokploy_roll_new_bad_state "$3" >/dev/null; then return 2; fi;
				if [ "$(date +%s)" -ge "$DR_UDEADLINE" ]; then return 1; fi;
				dokploy_roll_sleep ${poll};
			done;
		};
		dokploy_roll_clear_empty() {
			if [ -n "$DR_EMPTY" ]; then rm -f "$DR_EMPTY"; fi;
			DR_EMPTY="";
		};
		dokploy_roll_unmark() {
			if [ -z "$DR_EMPTY" ] || [ ! -f "$DR_EMPTY" ]; then return 1; fi;
			DR_UOK=1;
			for DR_O in $1; do docker cp "$DR_EMPTY" "$DR_O:${ROLLING_DRAIN_MARKER_PATH}" >/dev/null 2>&1 || DR_UOK=0; done;
			[ "$DR_UOK" = "1" ];
		};
		dokploy_roll_recover_bound() {
			DR_HC=$(docker inspect -f '{{printf "%d %d" .Config.Healthcheck.Interval .Config.Healthcheck.Timeout}}' "$1" 2>/dev/null) || DR_HC="";
			printf '%s\\n' "$DR_HC" | awk -v cap=${ROLLING_HEALTH_TIMEOUT_MAX_SECONDS} '{ i = $1 / 1e9; t = $2 / 1e9; if (i <= 0) i = 30; if (t <= 0) t = 30; b = i + t + ${ROLLING_RECOVER_SLACK_SECONDS}; b = int(b) + (b > int(b)); if (b > cap) b = cap; print b }';
		};
		dokploy_roll_wait_recovered() {
			DR_RBOUND=$(dokploy_roll_recover_bound "$1");
			case "$DR_RBOUND" in ''|*[!0-9]*) DR_RBOUND=${ROLLING_HEALTH_TIMEOUT_MAX_SECONDS};; esac;
			DR_RDEADLINE=$(( $(date +%s) + DR_RBOUND ));
			while :; do
				if [ "$(dokploy_roll_new_state "$1")" = "running healthy" ]; then return 0; fi;
				if [ "$(date +%s)" -ge "$DR_RDEADLINE" ]; then return 1; fi;
				dokploy_roll_sleep ${poll};
			done;
		};
		dokploy_roll_take_out() {
			DR_OUT=0; DR_MARKED=0;
			for DR_O in $2; do
				if ! dokploy_roll_honours_drain "$DR_O"; then
					dokploy_roll_log "$1: the old container is not taken out of rotation: $DR_WHY";
					dokploy_roll_log "$1: the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail";
					return 1;
				fi;
			done;
			DR_TMP=$(mktemp 2>/dev/null) || DR_TMP="";
			if [ -z "$DR_TMP" ] || ! { printf 'drain\\n' >"$DR_TMP" && chmod 644 "$DR_TMP"; } 2>/dev/null; then
				if [ -n "$DR_TMP" ]; then rm -f "$DR_TMP"; fi;
				dokploy_roll_log "$1: could not prepare the drain marker";
				dokploy_roll_log "$1: the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail";
				return 1;
			fi;
			dokploy_roll_clear_empty;
			DR_EMPTY=$(mktemp 2>/dev/null) || DR_EMPTY="";
			if [ -z "$DR_EMPTY" ] || ! chmod 644 "$DR_EMPTY" 2>/dev/null; then
				rm -f "$DR_TMP"; dokploy_roll_clear_empty;
				dokploy_roll_log "$1: could not prepare the file that undoes the drain marker";
				dokploy_roll_log "$1: the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail";
				return 1;
			fi;
			dokploy_roll_log "$1: taking the old container out of rotation (drain marker)";
			# From the first copy on the old container is draining: a cancel removes it and keeps the new replica.
			DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTING="$2"; DOKPLOY_ROLL_PROMOTED=1;
			DR_CP_OK=1;
			for DR_O in $2; do
				docker cp "$DR_TMP" "$DR_O:${ROLLING_DRAIN_MARKER_PATH}" >/dev/null 2>&1 || DR_CP_OK=0;
			done;
			rm -f "$DR_TMP";
			DR_MARKED=1;
			if [ "$DR_CP_OK" != "1" ]; then
				dokploy_roll_unmark "$2";
				DR_MARKED=0;
				DOKPLOY_ROLL_ACTIVE=1; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_PROMOTED=$DR_WAS_PROMOTED;
				dokploy_roll_log "$1: the drain marker could not be copied into the old container";
				dokploy_roll_log "$1: the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail";
				return 1;
			fi;
			for DR_O in $2; do
				DR_BOUND=$(dokploy_roll_drain_bound "$DR_O");
				case "$DR_BOUND" in ''|*[!0-9]*) DR_BOUND=${ROLLING_HEALTH_TIMEOUT_MAX_SECONDS};; esac;
				dokploy_roll_log "$1: waiting up to $DR_BOUND seconds for the old container to report unhealthy";
				dokploy_roll_wait_out "$DR_O" "$DR_BOUND" "$3"; DR_WRC=$?;
				if [ "$DR_WRC" = "2" ]; then return 1; fi;
				if [ "$DR_WRC" != "0" ]; then
					dokploy_roll_log "$1: the old container did not report unhealthy in time";
					dokploy_roll_log "$1: the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail";
					return 1;
				fi;
			done;
			dokploy_roll_log "$1: the old container is unhealthy, waiting ${routeSettle}s for Traefik to drop it";
			dokploy_roll_sleep ${routeSettle};
			DR_OUT=1;
			return 0;
		};
		dokploy_roll_new_still_ok() {
			DR_NST=$(dokploy_roll_new_bad_state "$2") || return 0;
			dokploy_roll_log "$1: the new replica is $DR_NST, putting the old container back in rotation";
			DR_BACK=1;
			# The old container is being restored: a cancel from here on discards the new replica and keeps it.
			DOKPLOY_ROLL_ACTIVE=1; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_PROMOTED=$DR_WAS_PROMOTED;
			if [ "$DR_MARKED" = "1" ]; then
				if dokploy_roll_unmark "$3"; then
					for DR_O in $3; do dokploy_roll_wait_recovered "$DR_O" || DR_BACK=0; done;
				else
					DR_BACK=0;
				fi;
			fi;
			DOKPLOY_ROLL_REASON="the new replica was $DR_NST after the old container was taken out of rotation";
			if [ "$DR_BACK" = "1" ]; then
				dokploy_roll_fail "$1";
				return 1;
			fi;
			# Neither container is known to serve: remove nothing, leave both for the next deploy to reconcile.
			DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTED=1;
			echo "Error: ❌ Rolling replace of $1 failed: $DOKPLOY_ROLL_REASON, and the old container did not become healthy again after the drain marker was removed. Nothing was replaced: both containers were left running and nothing was stopped or removed, and the next deploy reconciles them.";
			return 1;
		};
		dokploy_roll_discard() {
			if [ $# -eq 0 ]; then return 0; fi;
			docker rm -f "$@" >/dev/null 2>&1;
		};
		dokploy_roll_extras() {
			for DR_X in $(dokploy_roll_ids "$DOKPLOY_ROLL_SVC"); do
				case " $DOKPLOY_ROLL_BEFORE " in *" $DR_X "*) ;; *) echo "$DR_X";; esac;
			done;
		};
		dokploy_roll_abort() {
			if [ "$DOKPLOY_ROLL_ABORTING" = "1" ]; then exit 130; fi;
			dokploy_roll_clear_empty;
			DOKPLOY_ROLL_ABORTING=1;
			dokploy_roll_log "the deployment was interrupted";
			if [ "$DOKPLOY_ROLL_ACTIVE" = "1" ]; then
				DR_EXTRA=$(dokploy_roll_extras);
				if [ -n "$DR_EXTRA" ]; then dokploy_roll_log "removing the replica of $DOKPLOY_ROLL_SVC that was not promoted"; dokploy_roll_discard $DR_EXTRA || true; fi;
			fi;
			if [ -n "$DOKPLOY_ROLL_PROMOTING" ]; then dokploy_roll_remove $DOKPLOY_ROLL_PROMOTING || true; fi;
			return 0;
		};
		dokploy_roll_signal_done() {
			if [ -n "$DOKPLOY_RELEASE_DONE" ]; then : > "$DOKPLOY_RELEASE_DONE" 2>/dev/null || true; fi;
		};
		dokploy_roll_fail() {
			DR_EXTRA=$(dokploy_roll_extras);
			DOKPLOY_ROLL_ACTIVE=0;
			if [ -n "$DR_EXTRA" ]; then dokploy_roll_discard $DR_EXTRA || true; fi;
			echo "Error: ❌ Rolling replace of $1 failed: $DOKPLOY_ROLL_REASON. The new replica was removed and the previous container was left as it was.";
		};
		dokploy_roll_reconcile() {
			DR_WANT_N=$(dokploy_roll_replicas "$1");
			DR_ALL_IDS=$(dokploy_roll_ids "$1");
			DR_COUNT=$(printf '%s\\n' "$DR_ALL_IDS" | grep -c .);
			if [ "$DR_COUNT" -le "$DR_WANT_N" ]; then return 0; fi;
			if [ "$DR_WANT_N" = "1" ]; then dokploy_roll_log "$1: found $DR_COUNT containers (an interrupted rollout?), keeping the newest healthy one"; else dokploy_roll_log "$1: found $DR_COUNT containers for $DR_WANT_N replicas (an interrupted rollout?), keeping the newest $DR_WANT_N, healthy ones first"; fi;
			DR_LIST=$(for DR_C in $DR_ALL_IDS; do docker inspect -f '{{.Created}} {{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Id}}' "$DR_C" 2>/dev/null; done | sort -r);
			# The newest healthy running ones first, then the newest running ones, at most N.
			DR_KEEP=$(printf '%s\\n' "$DR_LIST" | awk -v n="$DR_WANT_N" '$2 == "true" && $3 == "healthy" { h[++hc] = $4; next } $2 == "true" { r[++rc] = $4 } END { k = 0; for (i = 1; i <= hc && k < n; i++) { print h[i]; k++ } for (i = 1; i <= rc && k < n; i++) { print r[i]; k++ } }');
			if [ -z "$DR_KEEP" ]; then return 0; fi;
			DR_DROP="";
			for DR_C in $DR_ALL_IDS; do if ! printf '%s\\n' "$DR_KEEP" | grep -qxF -- "$DR_C"; then DR_DROP="$DR_DROP $DR_C"; fi; done;
			dokploy_roll_remove $DR_DROP || true;
			DR_STILL=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_KEEP" || true);
			if [ -n "$DR_STILL" ]; then docker rm -f $DR_STILL >/dev/null 2>&1 || true; DR_STILL=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_KEEP" || true); fi;
			if [ -n "$DR_STILL" ]; then
				echo "Error: ❌ Rolling replace of $1: a leftover container could not be removed ($(echo $DR_STILL)). The container $(echo $DR_KEEP) is serving. No compose up is run for this service: Compose would scale to $DR_WANT_N container(s) and could keep the stuck one instead.";
				return 1;
			fi;
			return 0;
		};
		dokploy_roll_unchanged() {
			DR_WANT=$(dokploy_roll_compose config --hash "$1" 2>/dev/null | awk -v s="$1" '$1 == s { print $2 }');
			if [ -z "$DR_WANT" ]; then return 1; fi;
			DR_IMAGES=$(dokploy_roll_compose config --images "$1" 2>/dev/null | while read -r DR_REF; do docker image inspect --format '{{.Id}}' "$DR_REF" 2>/dev/null; done);
			if [ -z "$DR_IMAGES" ]; then return 1; fi;
			for DR_C in $DR_OLD; do
				DR_HAVE=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$DR_C" 2>/dev/null);
				if [ "$DR_HAVE" != "$DR_WANT" ]; then return 1; fi;
				DR_IMG=$(docker inspect -f '{{.Image}}' "$DR_C" 2>/dev/null);
				if [ -z "$DR_IMG" ]; then return 1; fi;
				if ! printf '%s\\n' "$DR_IMAGES" | grep -qxF -- "$DR_IMG"; then return 1; fi;
			done;
			return 0;
		};
		dokploy_roll_wait_healthy() {
			# One deadline for every new replica of the service.
			DR_DEADLINE=$(( $(date +%s) + ${timeout} ));
			DR_WHO="the new replica";
			for DR_W in "$@"; do
				if [ $# -gt 1 ]; then DR_WHO="the new replica $(printf '%.12s' "$DR_W")"; fi;
				DR_LAST=""; DR_NONE=0;
				while :; do
					DR_STATE=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$DR_W" 2>/dev/null) || DR_STATE="missing none";
					if [ "$DR_STATE" != "$DR_LAST" ]; then dokploy_roll_log "$DOKPLOY_ROLL_SVC: $DR_WHO is $DR_STATE"; DR_LAST="$DR_STATE"; fi;
					if [ "$DR_STATE" != "running none" ]; then DR_NONE=0; fi;
					case "$DR_STATE" in
						"running healthy") break;;
						"running unhealthy") DOKPLOY_ROLL_REASON="$DR_WHO reported unhealthy"; return 1;;
						"running none")
							# The engine may not have attached the health monitor on the first poll.
							DR_NONE=$((DR_NONE + 1));
							if [ "$DR_NONE" -ge 2 ]; then DOKPLOY_ROLL_REASON="$DR_WHO has no health status, the healthcheck is missing or disabled"; return 1; fi;;
						"exited "*|"dead "*|"removing "*|"missing "*) DOKPLOY_ROLL_REASON="$DR_WHO stopped before it became healthy ($DR_STATE)"; return 1;;
					esac;
					if [ "$(date +%s)" -ge "$DR_DEADLINE" ]; then DOKPLOY_ROLL_REASON="$DR_WHO was not healthy within ${timeout}s (last state: $DR_STATE)"; return 1; fi;
					dokploy_roll_sleep ${poll};
				done;
			done;
			# A replica judged early may have gone bad while a later one was awaited.
			if [ $# -gt 1 ]; then
				if DR_LATE=$(dokploy_roll_new_bad_state "$*"); then DOKPLOY_ROLL_REASON="a new replica was $DR_LATE once every new replica had been judged"; return 1; fi;
			fi;
			return 0;
		};
		dokploy_roll_service() {
			DOKPLOY_ROLL_SVC="$1"; DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_REASON=""; DOKPLOY_ROLL_BEFORE="";
			dokploy_roll_reconcile "$1" || return 1;
			DR_OLD=$(dokploy_roll_running_ids "$1");
			if [ -z "$DR_OLD" ]; then
				dokploy_roll_log "$1: no running container, starting it with a plain up";
				dokploy_roll_compose_shielded up -d --no-deps ${pullFlag}--no-build "$1" 2>&1 || return 1;
				return 0;
			fi;
			if dokploy_roll_unchanged "$1"; then
				dokploy_roll_log "$1: unchanged (config hash and image id match), left running";
				return 0;
			fi;
			DR_N=$(dokploy_roll_replicas "$1");
			# A stopped container of the service serves nothing, and a scale-up could start it on the old release.
			DR_STOPPED=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_OLD" || true);
			if [ -n "$DR_STOPPED" ]; then
				dokploy_roll_log "$1: removing the stopped container(s) $(echo $DR_STOPPED) before the rollout";
				dokploy_roll_discard $DR_STOPPED || true;
				if [ -n "$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_OLD" || true)" ]; then
					echo "Error: ❌ Rolling replace of $1: a stopped container could not be removed. Nothing was replaced: the running containers were left as they were.";
					return 1;
				fi;
			fi;
			DR_OLD_COUNT=$(printf '%s\\n' "$DR_OLD" | grep -c .);
			DOKPLOY_ROLL_BEFORE=$(dokploy_roll_ids "$1" | tr '\\n' ' ');
			DOKPLOY_ROLL_ACTIVE=1;
			if [ "$DR_N" = "1" ]; then dokploy_roll_log "$1: starting a second replica from the new release"; else dokploy_roll_log "$1: starting $DR_N new replicas from the new release next to the $DR_OLD_COUNT running one(s)"; fi;
			if ! dokploy_roll_compose up -d --no-deps --no-recreate --no-build --scale "$1=$((DR_OLD_COUNT + DR_N))" "$1" 2>&1; then
				DOKPLOY_ROLL_REASON="docker compose could not start the second replica";
				if [ "$DR_N" != "1" ]; then DOKPLOY_ROLL_REASON="docker compose could not start the new replicas"; fi;
				dokploy_roll_fail "$1";
				return 1;
			fi;
			DR_NEW=$(dokploy_roll_extras);
			DR_NEW_COUNT=$(printf '%s\\n' "$DR_NEW" | grep -c .);
			if [ "$DR_NEW_COUNT" != "$DR_N" ]; then
				DOKPLOY_ROLL_REASON="the new replica could not be told apart from the old container ($DR_NEW_COUNT new containers, $DR_N expected)";
				dokploy_roll_fail "$1";
				return 1;
			fi;
			if [ "$DR_N" = "1" ]; then dokploy_roll_log "$1: waiting up to ${timeout}s for the new replica to be healthy"; else dokploy_roll_log "$1: waiting up to ${timeout}s for the $DR_N new replicas to be healthy"; fi;
			if ! dokploy_roll_wait_healthy $DR_NEW; then
				dokploy_roll_fail "$1";
				return 1;
			fi;
			DR_WAS_PROMOTED=$DOKPLOY_ROLL_PROMOTED; DR_MARKED=0; DR_OUT=0;
			dokploy_roll_take_out "$1" "$DR_OLD" "$DR_NEW" || true;
			dokploy_roll_new_still_ok "$1" "$DR_NEW" "$DR_OLD" || return 1;${drainBlock}
			dokploy_roll_new_still_ok "$1" "$DR_NEW" "$DR_OLD" || return 1;
			DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTING="$DR_OLD"; DOKPLOY_ROLL_PROMOTED=1;
			dokploy_roll_log "$1: stopping and removing the old container";
			dokploy_roll_remove $DR_OLD || dokploy_roll_log "$1: the old container could not be removed, retrying";
			DR_LEFT=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_NEW" || true);
			if [ -n "$DR_LEFT" ]; then docker rm -f $DR_LEFT >/dev/null 2>&1 || true; DR_LEFT=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_NEW" || true); fi;
			if [ -n "$DR_LEFT" ]; then
				echo "Error: ❌ Rolling replace of $1: the old container could not be removed ($(echo $DR_LEFT)). The new replica $(echo $DR_NEW) is serving. No compose up is run for this service: Compose would scale back to $DR_N container(s) and keep the lowest-numbered (old) one. The next deploy reconciles it.";
				return 1;
			fi;
			for DR_C in $DR_OLD; do
				if [ "$(docker inspect -f '{{.State.Running}}' "$DR_C" 2>/dev/null)" = "true" ]; then
					echo "Error: ❌ Rolling replace of $1: the old container $DR_C is still running after it was stopped, so both releases are serving.";
					return 1;
				fi;
			done;
			DOKPLOY_ROLL_PROMOTING="";
			dokploy_roll_log "$1: replaced";
			return 0;
		};
		dokploy_roll_body() {
			DR_ALL=$(dokploy_roll_compose config --services 2>/dev/null) || { echo "Error: ❌ Rolling replace: could not list the services of the project"; return 1; };
			if [ -z "$DR_ALL" ]; then dokploy_roll_log "the project has no active service"; return 0; fi;
			DR_ROLL=""; DR_OTHERS="";
			for DR_S in $DR_ALL; do
				case " $DOKPLOY_ROLL_SELECTED " in *" $DR_S "*) DR_ROLL="$DR_ROLL $DR_S";; *) DR_OTHERS="$DR_OTHERS $DR_S";; esac;
			done;${buildBlock}${pullBlock}${othersBlock}
			for DR_S in $DR_ROLL; do dokploy_roll_service "$DR_S" || return 1; done;
			dokploy_roll_log "reconciling the project (orphans, stopped services)";
			dokploy_roll_compose_shielded up -d --no-recreate --no-build --remove-orphans $DR_ALL 2>&1 || return 1;
			return 0;
		};
		${ROLLING_RUN_FUNCTION}() {
			trap 'dokploy_roll_abort; dokploy_roll_signal_done; exit 130' INT TERM HUP;
			dokploy_roll_body; DR_RC=$?;
			dokploy_roll_clear_empty;
			trap - INT TERM HUP;
			return $DR_RC;
		};
		`;

	return { definitions, call: ROLLING_RUN_FUNCTION };
};

/**
 * Shell run when a failed rolling deploy ends. Nothing is restored once a
 * service has been promoted: restoring would recreate it on the old release.
 * Before that point the previous release is still the one serving, so the
 * regular restore applies.
 */
export const getRollingRestoreGuard = (restoreCommands: string) =>
	`if [ "$DOKPLOY_ROLL_PROMOTED" = "0" ]; then ${restoreCommands || "true;"} else echo "Warning: ⚠️ Rolling replace: services already replaced stay on the new release and the others keep running the previous one. No automatic restore was performed."; fi;`;

export const getRollingNoticeCommand = (message: string) =>
	`echo ${quote([message])};`;

export const describeRollingBlockers = (blockers: RollingBlocker[]) =>
	blockers.map((blocker) => blocker.message).join(" ");
