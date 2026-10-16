import { quote } from "shell-quote";
import {
	type ComposeRollingReplace,
	composeRollingReplaceSchema,
	ROLLING_HEALTH_TIMEOUT_MAX_SECONDS,
} from "../../db/validations/compose-rolling";

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

/** True when a short-syntax port string publishes a fixed host port. */
const shortPortPublishes = (entry: string) => {
	// The protocol suffix and a bracketed IPv6 host address are not ports.
	let value = entry.replace(/\/[a-z]+$/i, "").replace(/^\[[^\]]*\]:/, "");
	value = value.trim();
	const parts = value.split(":");
	if (parts.length === 1) return false;
	// `host:container` or `ip:host:container`; `ip::container` publishes a random port.
	const host = parts[parts.length - 2] ?? "";
	return host.length > 0;
};

const hasPublishedPort = (ports: unknown) => {
	if (!Array.isArray(ports)) return false;
	return ports.some((port) => {
		if (isObject(port)) {
			return (
				port.published !== undefined &&
				port.published !== null &&
				String(port.published) !== ""
			);
		}
		return shortPortPublishes(String(port));
	});
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
	const retries = positive(
		typeof healthcheck.retries === "number" ? healthcheck.retries : undefined,
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
	if (hasPublishedPort(definition.ports)) {
		add(
			"published-ports",
			"A host port is published: the second replica could not bind it. Use expose and Traefik instead.",
		);
	}
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
	const scale = definition.scale;
	const deploy = isObject(definition.deploy) ? definition.deploy : undefined;
	const replicas = deploy?.replicas;
	if (
		(scale !== undefined && Number(scale) !== 1) ||
		(replicas !== undefined && Number(replicas) !== 1)
	) {
		add(
			"replicas",
			"scale or deploy.replicas is not 1: --scale would conflict with it.",
		);
	}
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
		if (blockers.length === 0) plan.rolled.push(service);
		else plan.fallbacks.push({ service, blockers });
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
	/** Rolled services with a `build:` section (built before anything is touched). */
	buildServices?: string[];
	/** Rolled image-only services to pull first (`pullImagesOnDeploy`). */
	pullServices?: string[];
	/** Services of a build-server deploy are pulled earlier and never built here. */
	remoteBuild: boolean;
	pullAlways: boolean;
	healthTimeoutSeconds: number;
	drainSeconds: number;
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
	buildServices = [],
	pullServices = [],
	remoteBuild,
	pullAlways,
	healthTimeoutSeconds,
	drainSeconds,
	pollIntervalSeconds = ROLLING_POLL_INTERVAL_SECONDS,
}: RollingScriptOptions): RollingScript => {
	const timeout = Math.trunc(healthTimeoutSeconds);
	const drain = Math.trunc(drainSeconds);
	const poll = pollIntervalSeconds;
	const projectFilter = quote([`label=com.docker.compose.project=${appName}`]);
	const buildFlag = remoteBuild ? "--no-build" : "--build";
	const pullFlag = pullAlways ? "--pull always " : "";

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
	const drainBlock =
		drain > 0
			? `
		dokploy_roll_log "$1: the new replica is healthy, waiting ${drain}s before the old container is stopped";
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
		DOKPLOY_ROLL_PROMOTED=0; DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_ABORTING=0;
		DOKPLOY_ROLL_SVC=""; DOKPLOY_ROLL_BEFORE=""; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_REASON="";
		dokploy_roll_log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Rolling replace: $*"; };
		dokploy_roll_sleep() { sleep "$1" & wait $!; };
		dokploy_roll_compose() { env -i PATH="$PATH" HOME="$HOME" docker ${invocation} "$@"; };
		dokploy_roll_compose_shielded() { if command -v setsid >/dev/null 2>&1; then ( exec setsid env -i PATH="$PATH" HOME="$HOME" docker ${invocation} "$@" ); else dokploy_roll_compose "$@"; fi; };
		dokploy_roll_ids() { docker ps -aq --no-trunc --filter ${projectFilter} --filter "label=com.docker.compose.service=$1" --filter "label=com.docker.compose.oneoff=False"; };
		dokploy_roll_running_ids() { docker ps -q --no-trunc --filter ${projectFilter} --filter "label=com.docker.compose.service=$1" --filter "label=com.docker.compose.oneoff=False"; };
		dokploy_roll_remove() {
			if [ $# -eq 0 ]; then return 0; fi;
			docker stop "$@" >/dev/null 2>&1 || true;
			docker rm -f "$@" >/dev/null 2>&1;
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
			DR_ALL_IDS=$(dokploy_roll_ids "$1");
			DR_COUNT=$(printf '%s\\n' "$DR_ALL_IDS" | grep -c .);
			if [ "$DR_COUNT" -le 1 ]; then return 0; fi;
			dokploy_roll_log "$1: found $DR_COUNT containers (an interrupted rollout?), keeping the newest healthy one";
			DR_LIST=$(for DR_C in $DR_ALL_IDS; do docker inspect -f '{{.Created}} {{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Id}}' "$DR_C" 2>/dev/null; done | sort -r);
			DR_KEEP=$(printf '%s\\n' "$DR_LIST" | awk '$2 == "true" && $3 == "healthy" { print $4; exit }');
			if [ -z "$DR_KEEP" ]; then DR_KEEP=$(printf '%s\\n' "$DR_LIST" | awk '$2 == "true" { print $4; exit }'); fi;
			if [ -z "$DR_KEEP" ]; then return 0; fi;
			DR_DROP="";
			for DR_C in $DR_ALL_IDS; do if [ "$DR_C" != "$DR_KEEP" ]; then DR_DROP="$DR_DROP $DR_C"; fi; done;
			dokploy_roll_remove $DR_DROP || true;
			DR_STILL=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_KEEP" || true);
			if [ -n "$DR_STILL" ]; then docker rm -f $DR_STILL >/dev/null 2>&1 || true; DR_STILL=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_KEEP" || true); fi;
			if [ -n "$DR_STILL" ]; then
				echo "Error: ❌ Rolling replace of $1: a leftover container could not be removed ($DR_STILL). The container $DR_KEEP is serving. No compose up is run for this service: Compose would scale to one container and could keep the stuck one instead.";
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
			DR_DEADLINE=$(( $(date +%s) + ${timeout} ));
			DR_LAST=""; DR_NONE=0;
			while :; do
				DR_STATE=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null) || DR_STATE="missing none";
				if [ "$DR_STATE" != "$DR_LAST" ]; then dokploy_roll_log "$DOKPLOY_ROLL_SVC: the new replica is $DR_STATE"; DR_LAST="$DR_STATE"; fi;
				if [ "$DR_STATE" != "running none" ]; then DR_NONE=0; fi;
				case "$DR_STATE" in
					"running healthy") return 0;;
					"running unhealthy") DOKPLOY_ROLL_REASON="the new replica reported unhealthy"; return 1;;
					"running none")
						# The engine may not have attached the health monitor on the first poll.
						DR_NONE=$((DR_NONE + 1));
						if [ "$DR_NONE" -ge 2 ]; then DOKPLOY_ROLL_REASON="the new replica has no health status, the healthcheck is missing or disabled"; return 1; fi;;
					"exited "*|"dead "*|"removing "*|"missing "*) DOKPLOY_ROLL_REASON="the new replica stopped before it became healthy ($DR_STATE)"; return 1;;
				esac;
				if [ "$(date +%s)" -ge "$DR_DEADLINE" ]; then DOKPLOY_ROLL_REASON="the new replica was not healthy within ${timeout}s (last state: $DR_STATE)"; return 1; fi;
				dokploy_roll_sleep ${poll};
			done;
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
			DOKPLOY_ROLL_BEFORE=$(dokploy_roll_ids "$1" | tr '\\n' ' ');
			DOKPLOY_ROLL_ACTIVE=1;
			dokploy_roll_log "$1: starting a second replica from the new release";
			if ! dokploy_roll_compose up -d --no-deps --no-recreate --no-build --scale "$1=2" "$1" 2>&1; then
				DOKPLOY_ROLL_REASON="docker compose could not start the second replica";
				dokploy_roll_fail "$1";
				return 1;
			fi;
			DR_NEW=$(dokploy_roll_extras);
			DR_NEW_COUNT=$(printf '%s\\n' "$DR_NEW" | grep -c .);
			if [ "$DR_NEW_COUNT" != "1" ]; then
				DOKPLOY_ROLL_REASON="the new replica could not be told apart from the old container ($DR_NEW_COUNT new containers)";
				dokploy_roll_fail "$1";
				return 1;
			fi;
			dokploy_roll_log "$1: waiting up to ${timeout}s for the new replica to be healthy";
			if ! dokploy_roll_wait_healthy "$DR_NEW"; then
				dokploy_roll_fail "$1";
				return 1;
			fi;${drainBlock}
			DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTING="$DR_OLD"; DOKPLOY_ROLL_PROMOTED=1;
			dokploy_roll_log "$1: stopping and removing the old container";
			dokploy_roll_remove $DR_OLD || dokploy_roll_log "$1: the old container could not be removed, retrying";
			DR_LEFT=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_NEW" || true);
			if [ -n "$DR_LEFT" ]; then docker rm -f $DR_LEFT >/dev/null 2>&1 || true; DR_LEFT=$(dokploy_roll_ids "$1" | grep -vxF -- "$DR_NEW" || true); fi;
			if [ -n "$DR_LEFT" ]; then
				echo "Error: ❌ Rolling replace of $1: the old container could not be removed ($DR_LEFT). The new replica $DR_NEW is serving. No compose up is run for this service: Compose would scale back to one container and keep the lowest-numbered (old) one. The next deploy reconciles it.";
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
