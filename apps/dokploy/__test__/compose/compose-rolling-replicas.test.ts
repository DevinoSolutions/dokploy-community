import {
	ComposeInterpolationError,
	createComposeVariableLookup,
	interpolateComposeString,
	interpolateComposeValue,
	UNKNOWN_VALUE,
} from "@dokploy/server/utils/builders/compose-interpolate";
import {
	getEffectiveHealthTimeoutSeconds,
	getRollingEligibility,
	getRollingReplaceScript,
	getRollingReplicaCount,
	interpolateRollingSpec,
	planRollingServices,
	type RollingBlockerCode,
	type RollingSpec,
} from "@dokploy/server/utils/builders/compose-rolling";
import { describe, expect, it } from "vitest";

/**
 * Rolled services with several replicas (`deploy.replicas: N`, N in 1..10) and
 * host port ranges, judged on the values Compose interpolates. The compose that
 * is deployed is never changed; only eligibility reads the interpolated copy.
 */

const lookupOf = (values: Record<string, string>, unknown: string[] = []) =>
	createComposeVariableLookup(
		new Map(Object.entries(values)),
		new Set(unknown),
	);

const interp = (text: string, values: Record<string, string> = {}) =>
	interpolateComposeString(text, lookupOf(values));

describe("compose interpolation", () => {
	it("leaves text without a $ alone", () => {
		expect(interp("plain text")).toBe("plain text");
	});

	it("$$ is a literal $", () => {
		expect(interp("a$$b $${X}", { X: "no" })).toBe("a$b ${X}");
	});

	it("$VAR and ${VAR}", () => {
		expect(interp("$A-${B}", { A: "1", B: "2" })).toBe("1-2");
		expect(interp("${A}x$Ay", { A: "1", Ay: "z" })).toBe("1xz");
	});

	it("an unset variable without a default is empty", () => {
		expect(interp("[${NOPE}][$NOPE]")).toBe("[][]");
	});

	it("a $ that starts no reference is literal", () => {
		expect(interp("cost $5 and $ alone and end$")).toBe(
			"cost $5 and $ alone and end$",
		);
	});

	it("${VAR:-default} and ${VAR-default}", () => {
		expect(interp("${A:-d}", {})).toBe("d");
		expect(interp("${A:-d}", { A: "" })).toBe("d");
		expect(interp("${A:-d}", { A: "v" })).toBe("v");
		expect(interp("${A-d}", {})).toBe("d");
		expect(interp("${A-d}", { A: "" })).toBe("");
		expect(interp("${A-d}", { A: "v" })).toBe("v");
	});

	it("${VAR:+alt} and ${VAR+alt}", () => {
		expect(interp("${A:+alt}", {})).toBe("");
		expect(interp("${A:+alt}", { A: "" })).toBe("");
		expect(interp("${A:+alt}", { A: "v" })).toBe("alt");
		expect(interp("${A+alt}", {})).toBe("");
		expect(interp("${A+alt}", { A: "" })).toBe("alt");
	});

	it("${VAR:?err} and ${VAR?err} pass a set value and throw otherwise", () => {
		expect(interp("${A:?missing}", { A: "v" })).toBe("v");
		expect(interp("${A?missing}", { A: "" })).toBe("");
		expect(() => interp("${A:?missing}", { A: "" })).toThrow(
			ComposeInterpolationError,
		);
		expect(() => interp("${A:?missing}")).toThrow(ComposeInterpolationError);
		expect(() => interp("${A?missing}")).toThrow(ComposeInterpolationError);
	});

	it("nested expressions in defaults, only the branch taken is looked up", () => {
		expect(interp("${A:-${B:-54000}}")).toBe("54000");
		expect(interp("${A:-${B:-54000}}", { B: "1" })).toBe("1");
		expect(interp("${A:-${B:-54000}}", { A: "7" })).toBe("7");
		expect(interp("${A:-x${B}y}-z", { B: "1" })).toBe("x1y-z");
		const lookup = lookupOf({ A: "7" }, ["SECRET"]);
		expect(interpolateComposeString("${A:-${SECRET}}", lookup)).toBe("7");
		expect(() => interpolateComposeString("${B:-${SECRET}}", lookup)).toThrow(
			ComposeInterpolationError,
		);
	});

	it("invalid or unclosed references throw", () => {
		for (const bad of ["${", "${A", "${1A}", "${A*b}", "${}", "${A:-x"]) {
			expect(() => interp(bad), bad).toThrow(ComposeInterpolationError);
		}
	});

	it("an unknown variable throws", () => {
		const lookup = (name: string) =>
			name === "HOME" ? UNKNOWN_VALUE : undefined;
		expect(() => interpolateComposeString("$HOME/x", lookup)).toThrow(
			ComposeInterpolationError,
		);
	});

	it("interpolates a deep copy and never the input", () => {
		const input = {
			deploy: { replicas: "${N:-1}" },
			ports: ["${P}:80"],
			retries: 3,
			flag: true,
			nothing: null,
		};
		const out = interpolateComposeValue(input, lookupOf({ N: "2", P: "9" }));
		expect(out).toEqual({
			deploy: { replicas: "2" },
			ports: ["9:80"],
			retries: 3,
			flag: true,
			nothing: null,
		});
		expect(input.deploy.replicas).toBe("${N:-1}");
		expect(input.ports[0]).toBe("${P}:80");
	});
});

const healthcheck = {
	test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:3000/health"],
	interval: "10s",
	timeout: "5s",
	retries: 3,
};

const web = (extra: Record<string, unknown> = {}) => ({
	image: "ghcr.io/acme/web:1",
	healthcheck,
	...extra,
});

const codes = (definition: Record<string, unknown>): RollingBlockerCode[] =>
	getRollingEligibility({
		spec: { services: { web: definition } },
		service: "web",
		composeType: "docker-compose",
	}).map((blocker) => blocker.code);

const messages = (definition: Record<string, unknown>) =>
	getRollingEligibility({
		spec: { services: { web: definition } },
		service: "web",
		composeType: "docker-compose",
	}).map((blocker) => blocker.message);

describe("rolling eligibility: replicas", () => {
	it.each([
		[{}, 1],
		[{ scale: 1 }, 1],
		[{ deploy: { replicas: 2 } }, 2],
		[{ deploy: { replicas: "3" } }, 3],
		[{ scale: 10 }, 10],
		[{ scale: 4, deploy: { replicas: 4 } }, 4],
	])("%j runs %i replicas and is eligible", (extra, count) => {
		expect(codes(web(extra))).toEqual([]);
		expect(getRollingReplicaCount(web(extra))).toEqual({ count });
	});

	it.each([
		{ scale: 0 },
		{ deploy: { replicas: 0 } },
		{ deploy: { replicas: 11 } },
		{ deploy: { replicas: -1 } },
		{ deploy: { replicas: 2.5 } },
		{ deploy: { replicas: "${REPLICAS:-1}" } },
		{ deploy: { replicas: "" } },
		{ scale: 2, deploy: { replicas: 3 } },
	])("%j stays a replicas blocker", (extra) => {
		expect(codes(web(extra))).toContain("replicas");
	});

	it("says what is accepted", () => {
		expect(messages(web({ deploy: { replicas: 11 } })).join(" ")).toContain(
			"only a whole number from 1 to 10",
		);
	});
});

describe("rolling eligibility: published host port ranges", () => {
	it.each([
		[{ ports: ["54000-54001:3000"] }],
		[{ ports: ["127.0.0.1:54000-54003:3000"] }],
		[{ deploy: { replicas: 2 }, ports: ["54000-54003:3000"] }],
		[{ deploy: { replicas: 2 }, ports: ["0.0.0.0:54000-54005:3000/tcp"] }],
		[
			{
				deploy: { replicas: 2 },
				ports: [{ target: 3000, published: "54000-54003" }],
			},
		],
		[{ deploy: { replicas: 2 }, ports: ["3000", "127.0.0.1::3000"] }],
	])("%j is eligible", (extra) => {
		expect(codes(web(extra))).toEqual([]);
	});

	it.each([
		[{ ports: ["54000:3000"] }],
		[{ deploy: { replicas: 2 }, ports: ["54000-54001:3000"] }],
		[{ deploy: { replicas: 2 }, ports: ["54000-54002:3000"] }],
		[{ deploy: { replicas: 2 }, ports: [{ target: 3000, published: 54000 }] }],
		[
			{
				deploy: { replicas: 2 },
				ports: [{ target: 3000, published: "54000-54001" }],
			},
		],
		[{ ports: ["54000-54003:3000-3001"] }],
		[{ ports: ["54003-54000:3000"] }],
		[{ deploy: { replicas: 2 }, ports: ["54000-54003:3000", "8080:80"] }],
	])("%j stays a published-ports blocker", (extra) => {
		expect(codes(web(extra))).toContain("published-ports");
	});

	it("the message says the range must hold at least 2 x replicas ports", () => {
		const small = messages(
			web({ deploy: { replicas: 2 }, ports: ["54000-54001:3000"] }),
		).join(" ");
		expect(small).toContain("at least 2 x replicas ports (4 here)");
		const fixed = messages(web({ ports: ["54000:3000"] })).join(" ");
		expect(fixed).toContain("at least 2 x replicas ports (2 here)");
	});
});

/** The uNotes prod `web` service, as written in its compose. */
const UNOTES_WEB = {
	build: { context: "." },
	restart: "unless-stopped",
	deploy: { replicas: "${UNOTES_WEB_REPLICAS:-1}" },
	ports: [
		"${BIND_HOST:-127.0.0.1}:${UNOTES_WEB_PORT:-54000}-${UNOTES_WEB_PORT_LAST:-${UNOTES_WEB_PORT:-54000}}:3000",
	],
	healthcheck: {
		test: [
			"CMD-SHELL",
			'curl -fsS -H "Authorization: Bearer $${HEALTHCHECK_SECRET}" http://127.0.0.1:3000/api/health/db >/dev/null',
		],
		interval: "10s",
		timeout: "10s",
		retries: 18,
		start_period: "120s",
		start_interval: "2s",
	},
};

const UNOTES_ENV = {
	UNOTES_WEB_REPLICAS: "2",
	UNOTES_WEB_PORT: "54020",
	UNOTES_WEB_PORT_LAST: "54023",
};

describe("interpolateRollingSpec", () => {
	it("the uNotes web service is blocked raw and eligible with 2 replicas once interpolated", () => {
		const raw: RollingSpec = { services: { web: UNOTES_WEB } };
		expect(
			getRollingEligibility({
				spec: raw,
				service: "web",
				composeType: "docker-compose",
			})
				.map((b) => b.code)
				.sort(),
		).toEqual(["published-ports", "replicas"]);

		const { spec, notices } = interpolateRollingSpec(raw, ["web"], () =>
			lookupOf(UNOTES_ENV),
		);
		expect(notices).toEqual([]);
		const definition = spec.services?.web as Record<string, unknown>;
		expect(definition.ports).toEqual(["127.0.0.1:54020-54023:3000"]);
		expect(
			getRollingEligibility({
				spec,
				service: "web",
				composeType: "docker-compose",
			}),
		).toEqual([]);

		const plan = planRollingServices({
			settings: {
				enabled: true,
				services: ["web"],
				healthTimeoutSeconds: 120,
				drainSeconds: 5,
			},
			spec,
			composeType: "docker-compose",
			hasCustomCommand: false,
			freshVolumes: false,
		});
		expect(plan.rolled).toEqual(["web"]);
		expect(plan.replicas).toEqual({ web: 2 });
		// 120 + 18 x (10 + 10) = 480 s, plus one second.
		expect(plan.healthTimeoutSeconds).toBe(481);
		expect(getEffectiveHealthTimeoutSeconds(spec, ["web"], 120)).toBe(481);

		// The input spec is untouched.
		expect(UNOTES_WEB.deploy.replicas).toBe("${UNOTES_WEB_REPLICAS:-1}");
		expect(raw.services?.web).toBe(UNOTES_WEB);
	});

	it("the uNotes web service with the defaults only (no env) runs one replica on one fixed port: blocked", () => {
		const { spec } = interpolateRollingSpec(
			{ services: { web: UNOTES_WEB } },
			["web"],
			() => lookupOf({}),
		);
		const blockers = getRollingEligibility({
			spec,
			service: "web",
			composeType: "docker-compose",
		}).map((b) => b.code);
		expect(blockers).toEqual(["published-ports"]);
	});

	it("replicas from an env var: ${X:-1} with X=2 is eligible with N=2; 11 is a blocker", () => {
		const raw: RollingSpec = {
			services: { web: web({ deploy: { replicas: "${X:-1}" } }) },
		};
		const two = interpolateRollingSpec(raw, ["web"], () =>
			lookupOf({ X: "2" }),
		);
		expect(
			getRollingEligibility({
				spec: two.spec,
				service: "web",
				composeType: "docker-compose",
			}),
		).toEqual([]);
		expect(
			getRollingReplicaCount(two.spec.services?.web as Record<string, unknown>),
		).toEqual({ count: 2 });
		const eleven = interpolateRollingSpec(raw, ["web"], () =>
			lookupOf({ X: "11" }),
		);
		expect(
			getRollingEligibility({
				spec: eleven.spec,
				service: "web",
				composeType: "docker-compose",
			}).map((b) => b.code),
		).toEqual(["replicas"]);
	});

	it("a :? on an unset variable keeps the raw service and says so", () => {
		const raw: RollingSpec = {
			services: {
				web: web({ deploy: { replicas: "${X:?set X}" } }),
				other: web({ image: "${IMG:?nope}" }),
			},
		};
		const { spec, notices } = interpolateRollingSpec(raw, ["web"], () =>
			lookupOf({}),
		);
		expect(spec.services?.web).toBe(raw.services?.web);
		expect(spec.services?.other).toBe(raw.services?.other);
		// Only a selected service gets a notice.
		expect(notices.map((n) => n.service)).toEqual(["web"]);
		expect(notices[0]?.message).toContain(
			"judged on the compose file as written",
		);
	});

	it("an unknown variable keeps the raw service", () => {
		const raw: RollingSpec = {
			services: { web: web({ volumes: ["$HOME/data:/data"] }) },
		};
		const { spec, notices } = interpolateRollingSpec(raw, ["web"], () =>
			lookupOf({}, ["HOME"]),
		);
		expect(spec.services?.web).toBe(raw.services?.web);
		expect(notices).toHaveLength(1);
	});

	it("variables that cannot be prepared keep the whole raw spec, with a notice per selected service that uses one", () => {
		const raw: RollingSpec = {
			services: {
				web: web({ deploy: { replicas: "${X:-2}" } }),
				api: web(),
			},
		};
		const { spec, notices } = interpolateRollingSpec(
			raw,
			["web", "api"],
			() => {
				throw new Error("Unresolved vault reference");
			},
		);
		expect(spec).toBe(raw);
		expect(notices.map((n) => n.service)).toEqual(["web"]);
		expect(notices[0]?.message).toContain("Unresolved vault reference");
	});

	it("a spec without any $ is returned as it is and the variables are never prepared", () => {
		const raw: RollingSpec = { services: { web: web() } };
		let called = false;
		const result = interpolateRollingSpec(raw, ["web"], () => {
			called = true;
			return lookupOf({});
		});
		expect(result.spec).toBe(raw);
		expect(called).toBe(false);
	});

	it("an interpolated retries value counts in the health timeout", () => {
		const raw: RollingSpec = {
			services: {
				web: web({
					healthcheck: {
						test: "true",
						interval: "10s",
						timeout: "10s",
						retries: "${R:-3}",
					},
				}),
			},
		};
		const { spec } = interpolateRollingSpec(raw, ["web"], () =>
			lookupOf({ R: "18" }),
		);
		expect(getEffectiveHealthTimeoutSeconds(spec, ["web"], 10)).toBe(
			18 * 20 + 1,
		);
	});
});

describe("rolling replace script: replicas", () => {
	const script = (replicas?: Record<string, number>, services = ["web"]) =>
		getRollingReplaceScript({
			appName: "my-app",
			invocation: "compose -p my-app -f docker-compose.yml",
			services,
			replicas,
			remoteBuild: false,
			pullAlways: false,
			healthTimeoutSeconds: 90,
			drainSeconds: 5,
		}).definitions;

	it("passes N per service, shell-quoted, and defaults to 1", () => {
		expect(script()).toContain("DOKPLOY_ROLL_REPLICAS=web\\=1;");
		expect(script({ web: 2, docs: 1 }, ["web", "docs"])).toContain(
			"DOKPLOY_ROLL_REPLICAS='web=2 docs=1';",
		);
	});

	it("a value outside 1..10 never reaches the script", () => {
		expect(script({ web: 11 })).toContain("DOKPLOY_ROLL_REPLICAS=web\\=1;");
		expect(script({ web: 0 })).toContain("DOKPLOY_ROLL_REPLICAS=web\\=1;");
		expect(script({ web: 2.5 })).toContain("DOKPLOY_ROLL_REPLICAS=web\\=1;");
	});

	it("scales to old + N, needs exactly N new replicas and waits for all of them with one deadline", () => {
		const definitions = script({ web: 2 });
		expect(definitions).toContain('DR_N=$(dokploy_roll_replicas "$1");');
		expect(definitions).toContain('--scale "$1=$((DR_OLD_COUNT + DR_N))" "$1"');
		expect(definitions).toContain('if [ "$DR_NEW_COUNT" != "$DR_N" ]; then');
		expect(definitions).toContain("dokploy_roll_wait_healthy $DR_NEW;");
		const wait = definitions.slice(
			definitions.indexOf("dokploy_roll_wait_healthy() {"),
		);
		// The deadline is set once, before the loop over the replicas.
		expect(wait.indexOf("DR_DEADLINE=")).toBeLessThan(
			wait.indexOf('for DR_W in "$@"; do'),
		);
	});

	it("reconcile keeps up to N containers", () => {
		const definitions = script({ web: 3 });
		expect(definitions).toContain(
			'if [ "$DR_COUNT" -le "$DR_WANT_N" ]; then return 0; fi;',
		);
		expect(definitions).toContain('awk -v n="$DR_WANT_N"');
	});
});
