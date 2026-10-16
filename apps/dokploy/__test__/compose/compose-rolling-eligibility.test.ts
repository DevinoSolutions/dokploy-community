import {
	getEffectiveHealthTimeoutSeconds,
	getHealthcheckSettleSeconds,
	getImageBaseName,
	getRollingEligibility,
	getStackPreflightWarnings,
	parseComposeDurationSeconds,
	planRollingServices,
	type RollingBlockerCode,
	type RollingSpec,
} from "@dokploy/server/utils/builders/compose-rolling";
import { describe, expect, it } from "vitest";

const healthcheck = {
	test: ["CMD", "curl", "-f", "http://localhost/health"],
	interval: "10s",
	timeout: "5s",
	retries: 3,
	start_period: "20s",
};

const web = (extra: Record<string, unknown> = {}) => ({
	image: "ghcr.io/acme/web:1",
	healthcheck,
	...extra,
});

const specOf = (
	services: Record<string, Record<string, unknown>>,
): RollingSpec => ({ services });

const codes = (
	spec: RollingSpec,
	overrides: Partial<Parameters<typeof getRollingEligibility>[0]> = {},
): RollingBlockerCode[] =>
	getRollingEligibility({
		spec,
		service: "web",
		composeType: "docker-compose",
		...overrides,
	}).map((blocker) => blocker.code);

describe("rolling eligibility: a clean service", () => {
	it("is eligible", () => {
		expect(codes(specOf({ web: web() }))).toEqual([]);
	});

	it("is eligible with a build section, expose and an unpublished container port", () => {
		expect(
			codes(
				specOf({
					web: web({
						image: undefined,
						build: ".",
						expose: ["3000"],
						ports: ["3000", "127.0.0.1::3000"],
					}),
				}),
			),
		).toEqual([]);
	});
});

describe("rolling eligibility: every refusal reason", () => {
	const cases: Array<[RollingBlockerCode, Record<string, unknown>]> = [
		["container-name", { container_name: "web" }],
		["published-ports", { ports: ["8080:80"] }],
		["published-ports", { ports: ["127.0.0.1:8080:80"] }],
		["published-ports", { ports: ["[::1]:8080:80"] }],
		["published-ports", { ports: ["8000-8010:80/udp"] }],
		["published-ports", { ports: [{ target: 80, published: 8080 }] }],
		["network-mode", { network_mode: "host" }],
		["network-mode", { network_mode: "service:db" }],
		["network-mode", { network_mode: "container:abc" }],
		["replicas", { scale: 2 }],
		["replicas", { deploy: { replicas: 3 } }],
		["replicas", { deploy: { replicas: 0 } }],
		["static-address", { mac_address: "02:42:ac:11:00:02" }],
		[
			"static-address",
			{ networks: { default: { ipv4_address: "172.20.0.5" } } },
		],
		[
			"static-address",
			{ networks: { default: { ipv6_address: "2001:db8::5" } } },
		],
		["no-healthcheck", { healthcheck: undefined }],
		["no-healthcheck", { healthcheck: { interval: "5s" } }],
		["healthcheck-disabled", { healthcheck: { disable: true } }],
		["healthcheck-disabled", { healthcheck: { test: ["NONE"] } }],
		["healthcheck-disabled", { healthcheck: { test: "NONE" } }],
		["stateful-image", { image: "postgres:16" }],
		["stateful-image", { image: "docker.io/library/redis:7-alpine" }],
		["stateful-image", { image: "bitnami/postgresql@sha256:abc" }],
		["stateful-image", { image: "ghcr.io/x/valkey:8" }],
		["stateful-image", { image: "redis/redis-stack:latest" }],
		["stateful-image", { image: "mcr.microsoft.com/mssql/server:2022" }],
		["stateful-image", { image: "qdrant/qdrant:v1" }],
		["stateful-image", { image: "nats:2" }],
	];

	it.each(cases)("%s: %j", (code, extra) => {
		expect(codes(specOf({ web: web(extra) }))).toContain(code);
	});

	it("scale or replicas of exactly 1 is fine", () => {
		expect(
			codes(specOf({ web: web({ scale: 1, deploy: { replicas: 1 } }) })),
		).toEqual([]);
	});

	it("a service the compose does not define", () => {
		expect(codes(specOf({ api: web() }))).toEqual(["service-missing"]);
	});

	it.each([
		["network_mode", { network_mode: "service:web" }],
		["pid", { pid: "service:web" }],
		["ipc", { ipc: "service:web" }],
		["volumes_from", { volumes_from: ["web"] }],
		["volumes_from with a mode", { volumes_from: ["web:ro"] }],
	])("a dependent sharing a namespace through %s", (_name, extra) => {
		const spec = specOf({ web: web(), sidecar: { image: "x", ...extra } });
		expect(codes(spec)).toEqual(["namespace-dependent"]);
		// The sidecar itself is not what points at the rolled service.
		expect(codes(spec, { service: "sidecar" })).not.toContain(
			"namespace-dependent",
		);
	});

	it("a service that merely shares a name prefix is not a dependent", () => {
		const spec = specOf({
			web: web(),
			other: { image: "x", volumes_from: ["web-2"] },
		});
		expect(codes(spec)).toEqual([]);
	});

	it("compose-level refusals: stack, custom command, fresh volumes", () => {
		const spec = specOf({ web: web() });
		expect(codes(spec, { composeType: "stack" })).toEqual(["stack"]);
		expect(codes(spec, { hasCustomCommand: true })).toEqual(["custom-command"]);
		expect(codes(spec, { freshVolumes: true })).toEqual(["fresh-volumes"]);
	});

	it("reports every reason at once, each with a human message", () => {
		const blockers = getRollingEligibility({
			spec: specOf({
				web: web({
					container_name: "web",
					ports: ["80:80"],
					healthcheck: undefined,
				}),
			}),
			service: "web",
			composeType: "docker-compose",
		});
		expect(blockers.map((b) => b.code).sort()).toEqual([
			"container-name",
			"no-healthcheck",
			"published-ports",
		]);
		for (const blocker of blockers)
			expect(blocker.message.length).toBeGreaterThan(10);
	});
});

describe("health timeout against the healthcheck", () => {
	// start_period 20s + retries 3 x (interval 10s + timeout 5s) = 65s
	it("settle time is start_period + retries x (interval + timeout)", () => {
		expect(getHealthcheckSettleSeconds(healthcheck)).toBe(65);
	});

	it("uses the Compose defaults (30s interval, 30s timeout, 3 retries, no start period)", () => {
		expect(getHealthcheckSettleSeconds({ test: ["CMD", "true"] })).toBe(180);
	});

	it("a healthcheck that settles within the longest wait is eligible", () => {
		// Docker's defaults (180s) used to be refused against the 120s default.
		expect(
			codes(specOf({ web: web({ healthcheck: { test: ["CMD", "true"] } }) })),
		).toEqual([]);
	});

	it("a healthcheck that cannot settle within the longest wait is refused", () => {
		expect(
			codes(
				specOf({
					web: web({
						healthcheck: { test: ["CMD", "true"], interval: "5m", retries: 3 },
					}),
				}),
			),
		).toEqual(["health-timeout-too-short"]);
	});

	it("zero interval, timeout and retries mean Docker's defaults", () => {
		expect(
			getHealthcheckSettleSeconds({
				test: ["CMD", "true"],
				interval: "0s",
				timeout: "0s",
				retries: 0,
			}),
		).toBe(180);
	});

	it.each([
		[30, 66],
		[120, 120],
		[10, 66],
		[900, 900],
	])(
		"the wait %ds is raised to cover the healthcheck: %ds",
		(configured, expected) => {
			// 65s to settle + 1s
			expect(
				getEffectiveHealthTimeoutSeconds(
					specOf({ web: web() }),
					["web"],
					configured,
				),
			).toBe(expected);
		},
	);

	it("the wait is never above the schema maximum", () => {
		expect(
			getEffectiveHealthTimeoutSeconds(
				specOf({
					web: web({
						healthcheck: { test: ["CMD", "true"], interval: "1m", retries: 10 },
					}),
				}),
				["web"],
				120,
			),
		).toBe(900);
	});

	it.each([
		["30s", 30],
		["1m30s", 90],
		["500ms", 0.5],
		["1.5h", 5400],
		["2m", 120],
	])("parses %s", (value, seconds) => {
		expect(parseComposeDurationSeconds(value)).toBeCloseTo(seconds);
	});

	it.each(["", "30", "abc", "10x", undefined, 30])("rejects %j", (value) => {
		expect(parseComposeDurationSeconds(value)).toBeUndefined();
	});
});

describe("image base name", () => {
	it.each([
		["postgres:16", "postgres"],
		["library/postgres", "postgres"],
		["docker.io/library/Redis:7", "redis"],
		["registry:5000/team/web:1.2", "web"],
		["ghcr.io/acme/web@sha256:abc", "web"],
	])("%s -> %s", (image, base) => {
		expect(getImageBaseName(image)).toBe(base);
	});
});

describe("plan: drift is a fallback, never a failure", () => {
	const settings = {
		enabled: true,
		services: ["web", "gone", "ports"],
		healthTimeoutSeconds: 120,
		drainSeconds: 5,
	};

	it("rolls the eligible, falls back for the rest with the reasons", () => {
		const plan = planRollingServices({
			settings,
			spec: specOf({ web: web(), ports: web({ ports: ["80:80"] }) }),
			composeType: "docker-compose",
			hasCustomCommand: false,
			freshVolumes: false,
		});
		expect(plan.rolled).toEqual(["web"]);
		expect(plan.fallbacks.map((f) => f.service)).toEqual(["gone", "ports"]);
		expect(plan.fallbacks[0]?.blockers[0]?.code).toBe("service-missing");
		expect(plan.fallbacks[1]?.blockers[0]?.code).toBe("published-ports");
	});

	it("everything falls back for a stack", () => {
		const plan = planRollingServices({
			settings,
			spec: specOf({ web: web() }),
			composeType: "stack",
			hasCustomCommand: false,
			freshVolumes: false,
		});
		expect(plan.rolled).toEqual([]);
	});

	it("a health timeout shorter than the healthcheck is raised, not refused", () => {
		const plan = planRollingServices({
			settings: { ...settings, services: ["web"], healthTimeoutSeconds: 30 },
			spec: specOf({ web: web() }),
			composeType: "docker-compose",
			hasCustomCommand: false,
			freshVolumes: false,
		});
		expect(plan.rolled).toEqual(["web"]);
		expect(plan.healthTimeoutSeconds).toBe(66);
	});
});

describe("stack preflight warning", () => {
	it("flags a service without a healthcheck or without start-first, never one with both", () => {
		const warnings = getStackPreflightWarnings(
			specOf({
				good: {
					image: "x",
					healthcheck,
					deploy: { update_config: { order: "start-first" } },
				},
				noHealth: {
					image: "x",
					deploy: { update_config: { order: "start-first" } },
				},
				noOrder: { image: "x", healthcheck },
				stopFirst: {
					image: "x",
					healthcheck,
					deploy: { update_config: { order: "stop-first" } },
				},
			}),
		);
		expect(warnings.map((w) => w.service).sort()).toEqual([
			"noHealth",
			"noOrder",
			"stopFirst",
		]);
		expect(warnings.find((w) => w.service === "noHealth")?.issues).toHaveLength(
			1,
		);
	});
	it.each([
		["short syntax with an ip", ["127.0.0.1:54005:5432"]],
		["short syntax with an ip and no host port", ["127.0.0.1::5432"]],
		["short syntax with an ipv6 address", ["[::1]:8080:80"]],
		[
			"long syntax with host_ip",
			[{ target: 80, published: 8080, host_ip: "10.0.0.1" }],
		],
	])("flags a host address in a published port: %s", (_name, ports) => {
		const warnings = getStackPreflightWarnings(
			specOf({
				web: {
					image: "x",
					healthcheck,
					deploy: { update_config: { order: "start-first" } },
					ports,
				},
			}),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.issues[0]).toMatch(/binds a host address/);
	});

	it("does not flag a published port without a host address", () => {
		const warnings = getStackPreflightWarnings(
			specOf({
				web: {
					image: "x",
					healthcheck,
					deploy: { update_config: { order: "start-first" } },
					ports: ["8080:80", "80", { target: 80, published: 8080 }],
				},
			}),
		);
		expect(warnings).toEqual([]);
	});
});
