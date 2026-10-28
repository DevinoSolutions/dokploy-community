import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyRollingDrainHealthchecks,
	getRollingDrainWarnings,
	getRollingReplaceScript,
	ROLLING_DRAIN_MARKER_PATH,
	ROLLING_ROUTE_SETTLE_SECONDS,
	wrapHealthcheckTestForDrain,
} from "@dokploy/server/utils/builders/compose-rolling";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { boundedSh } from "./helpers/bounded-shell";

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsyncRemote: mocks.execAsyncRemote,
		writeFileRemote: mocks.writeFileRemote,
	};
});

import { writeDomainsToCompose } from "@dokploy/server/utils/docker/domain";

/**
 * T-9197. Traefik keeps routing to a healthy running container until it dies,
 * so the old container of a rolling replace is first made unhealthy (a marker
 * its healthcheck honours), and only then stopped. These tests cover the three
 * parts: the healthcheck wrap at deploy time, the script sequence, and the
 * spec the deploy writes.
 */

const MARKER = ROLLING_DRAIN_MARKER_PATH;

const toShellPath = (path: string) =>
	process.platform === "win32"
		? path
				.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
				.replace(/\\/g, "/")
		: path;
const scratch = mkdtempSync(join(tmpdir(), "dokploy-rolling-drain-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const hasSh = (() => {
	try {
		const result = boundedSh(["-c", "echo ok"], {
			encoding: "utf8",
			timeout: 30_000,
		});
		return result.status === 0 && result.stdout.trim() === "ok";
	} catch {
		return false;
	}
})();

/** `sh -n`: the script parses. */
const parses = (script: string) => {
	const path = join(scratch, `s-${Math.random()}.sh`);
	writeFileSync(path, script);
	const result = boundedSh(["-n", toShellPath(path)], {
		encoding: "utf8",
	});
	return result.status === 0 ? "ok" : `${result.stderr}`;
};

describe("wrapHealthcheckTestForDrain", () => {
	it("a CMD-SHELL test keeps its form and fails while the marker exists", () => {
		const wrapped = wrapHealthcheckTestForDrain([
			"CMD-SHELL",
			"curl -f http://localhost:3000/health",
		]);
		expect(wrapped).toEqual([
			"CMD-SHELL",
			`[ ! -s ${MARKER} ] && ( curl -f http://localhost:3000/health )`,
		]);
	});

	it("a string test is a CMD-SHELL test and stays a string", () => {
		expect(wrapHealthcheckTestForDrain("wget -q -O- localhost:80")).toBe(
			`[ ! -s ${MARKER} ] && ( wget -q -O- localhost:80 )`,
		);
	});

	it("exec-form, NONE, empty and odd shapes are returned untouched", () => {
		const untouched: unknown[] = [
			["CMD", "curl", "-f", "http://localhost"],
			["CMD-SHELL"],
			["CMD-SHELL", "a", "b"],
			["CMD-SHELL", 5],
			["NONE"],
			"NONE",
			"",
			"   ",
			[],
			undefined,
			null,
			42,
			{ test: "x" },
		];
		for (const test of untouched) {
			expect(wrapHealthcheckTestForDrain(test)).toBe(test);
		}
	});

	it("is deterministic and idempotent: wrapping the wrapped test changes nothing", () => {
		const once = wrapHealthcheckTestForDrain(["CMD-SHELL", "true"]);
		expect(wrapHealthcheckTestForDrain(["CMD-SHELL", "true"])).toEqual(once);
		expect(wrapHealthcheckTestForDrain(once)).toEqual(once);
		const str = wrapHealthcheckTestForDrain("true");
		expect(wrapHealthcheckTestForDrain(str)).toBe(str);
	});

	it("introduces no `$`, so Compose interpolation has nothing to change", () => {
		const wrapped = wrapHealthcheckTestForDrain(["CMD-SHELL", "true"]) as [
			string,
			string,
		];
		expect(wrapped[1]).not.toContain("$");
	});

	it("keeps the `$$` and `$VAR` the user wrote exactly as they were", () => {
		const original =
			'curl -f "http://localhost:$$PORT/health?x=$TOKEN" || exit 1';
		const wrapped = wrapHealthcheckTestForDrain(["CMD-SHELL", original]) as [
			string,
			string,
		];
		expect(wrapped[1]).toContain(original);
		expect(wrapped[1].split("$$").length).toBe(original.split("$$").length);
	});

	it("a test with a comment or several lines gets the command on its own lines", () => {
		const wrapped = wrapHealthcheckTestForDrain([
			"CMD-SHELL",
			"true # probe",
		]) as [string, string];
		expect(wrapped[1]).toBe(`[ ! -s ${MARKER} ] && (\ntrue # probe\n)`);
		const multi = wrapHealthcheckTestForDrain("a\nb") as string;
		expect(multi).toBe(`[ ! -s ${MARKER} ] && (\na\nb\n)`);
	});
});

describe.skipIf(!hasSh)("the wrapped test, run by a real shell", () => {
	const markerFile = join(scratch, "marker");
	const sentinel = join(scratch, "ran");

	/** Runs the wrapped test with the marker path pointed at a scratch file. */
	const run = (test: unknown, marker: string | null) => {
		rmSync(markerFile, { force: true });
		rmSync(sentinel, { force: true });
		if (marker !== null) writeFileSync(markerFile, marker);
		const wrapped = wrapHealthcheckTestForDrain(
			Array.isArray(test) ? test : ["CMD-SHELL", test],
		) as [string, string];
		const command = wrapped[1].replaceAll(MARKER, toShellPath(markerFile));
		const result = boundedSh(["-c", command], { encoding: "utf8" });
		return { status: result.status, ran: existsSync(sentinel) };
	};
	const touch = `touch ${toShellPath(sentinel)}`;

	it("without the marker the original runs and its status is the status", () => {
		expect(run(`${touch}`, null)).toEqual({ status: 0, ran: true });
		expect(run(`${touch}; false`, null)).toEqual({ status: 1, ran: true });
		expect(run(`${touch}; exit 3`, null)).toEqual({ status: 3, ran: true });
	});

	it("an empty marker file counts as no marker (the drain can be undone)", () => {
		expect(run(`${touch}`, "")).toEqual({ status: 0, ran: true });
	});

	it("with the marker the test fails and the original does not run", () => {
		expect(run(`${touch}`, "drain\n")).toEqual({ status: 1, ran: false });
		expect(run(`${touch}; exit 0`, "drain\n")).toEqual({
			status: 1,
			ran: false,
		});
	});

	it("an original with || is judged as a whole, before and during the drain", () => {
		expect(run("false || true", null).status).toBe(0);
		expect(run("false || true", "drain\n").status).toBe(1);
		expect(run("true && false", null).status).toBe(1);
	});

	it("a trailing comment in the original cannot swallow the closing parenthesis", () => {
		expect(run(`${touch} # probe`, null)).toEqual({ status: 0, ran: true });
		expect(run(`${touch} # probe`, "drain\n")).toEqual({
			status: 1,
			ran: false,
		});
	});

	it("an unreadable or missing marker directory is no marker", () => {
		const wrapped = wrapHealthcheckTestForDrain("true") as string;
		const command = wrapped.replaceAll(
			MARKER,
			toShellPath(join(scratch, "no-such-dir", "marker")),
		);
		expect(boundedSh(["-c", command], { encoding: "utf8" }).status).toBe(0);
	});
});

describe("applyRollingDrainHealthchecks", () => {
	const spec = () => ({
		services: {
			web: {
				image: "x",
				healthcheck: {
					test: ["CMD-SHELL", "curl -f localhost"],
					interval: "5s",
					timeout: "2s",
					retries: 3,
					start_period: "10s",
				},
			},
			api: {
				image: "y",
				healthcheck: { test: "wget -q localhost", interval: "3s" },
			},
			exec: { image: "z", healthcheck: { test: ["CMD", "true"] } },
			off: { image: "o", healthcheck: { test: ["NONE"] } },
			disabled: { image: "d", healthcheck: { disable: true } },
			none: { image: "n" },
			other: {
				image: "p",
				healthcheck: { test: ["CMD-SHELL", "true"] },
			},
		},
	});

	it("wraps the listed services only and keeps every other healthcheck key", () => {
		const input = spec();
		const output = applyRollingDrainHealthchecks(input, [
			"web",
			"api",
			"exec",
			"off",
			"disabled",
			"none",
			"missing",
		]) as ReturnType<typeof spec>;
		expect(output.services.web.healthcheck).toEqual({
			...input.services.web.healthcheck,
			test: ["CMD-SHELL", `[ ! -s ${MARKER} ] && ( curl -f localhost )`],
		});
		expect(output.services.api.healthcheck).toEqual({
			test: `[ ! -s ${MARKER} ] && ( wget -q localhost )`,
			interval: "3s",
		});
		// Not shell form, disabled or absent: the same as the input.
		expect(output.services.exec).toEqual(input.services.exec);
		expect(output.services.off).toEqual(input.services.off);
		expect(output.services.disabled).toEqual(input.services.disabled);
		expect(output.services.none).toEqual(input.services.none);
		// Not listed: the same as the input.
		expect(output.services.other).toEqual(input.services.other);
	});

	it("does not mutate its input", () => {
		const input = spec();
		const snapshot = JSON.stringify(input);
		applyRollingDrainHealthchecks(input, ["web", "api"]);
		expect(JSON.stringify(input)).toBe(snapshot);
	});

	it("returns the very same object when nothing applies (the spec stays byte-identical)", () => {
		const input = spec();
		expect(applyRollingDrainHealthchecks(input, [])).toBe(input);
		expect(applyRollingDrainHealthchecks(input, ["exec", "none"])).toBe(input);
		expect(applyRollingDrainHealthchecks(null, ["web"])).toBe(null);
		const noServices = {};
		expect(applyRollingDrainHealthchecks(noServices, ["web"])).toBe(noServices);
	});

	it("a healthcheck shared through a YAML anchor is wrapped for the rolled service only", () => {
		const source = [
			"services:",
			"  web:",
			"    image: x",
			"    healthcheck: &hc",
			"      test: [CMD-SHELL, curl -f localhost]",
			"      interval: 5s",
			"  worker:",
			"    image: y",
			"    healthcheck: *hc",
		].join("\n");
		const parsed = parse(source, { maxAliasCount: 10000, merge: true });
		const output = applyRollingDrainHealthchecks(parsed, ["web"]) as {
			services: Record<string, { healthcheck: { test: string[] } }>;
		};
		expect(output.services.web?.healthcheck.test[1]).toContain(MARKER);
		expect(output.services.worker?.healthcheck.test).toEqual([
			"CMD-SHELL",
			"curl -f localhost",
		]);
	});

	it("the same input gives the same YAML every time (the config hash is stable)", () => {
		const render = () =>
			stringify(applyRollingDrainHealthchecks(spec(), ["web", "api"]), {
				lineWidth: 1000,
			});
		expect(render()).toBe(render());
		// What Compose reads back is exactly the wrapped test.
		const back = parse(render()) as ReturnType<typeof spec>;
		expect(back.services.web.healthcheck.test).toEqual([
			"CMD-SHELL",
			`[ ! -s ${MARKER} ] && ( curl -f localhost )`,
		]);
		// Feeding the rendered file back in (a re-read of the written compose)
		// changes nothing.
		expect(
			stringify(applyRollingDrainHealthchecks(back, ["web", "api"]), {
				lineWidth: 1000,
			}),
		).toBe(render());
	});

	it("no `$` is added to the rendered YAML, so `$$` quoting is not needed", () => {
		const rendered = stringify(applyRollingDrainHealthchecks(spec(), ["web"]), {
			lineWidth: 1000,
		});
		expect(rendered).not.toContain("$");
	});
});

describe("getRollingDrainWarnings", () => {
	const shell = ["CMD-SHELL", "true"];
	const input = {
		services: {
			shell: { healthcheck: { test: shell } },
			text: { healthcheck: { test: "true" } },
			exec: { healthcheck: { test: ["CMD", "curl", "-f", "localhost"] } },
			none: { image: "n" },
			off: { healthcheck: { test: ["NONE"] } },
			disabled: { healthcheck: { disable: true } },
			named: {
				healthcheck: { test: shell },
				volumes: ["data:/tmp", "logs:/var/log"],
			},
			bind: { healthcheck: { test: shell }, volumes: ["./t:/tmp:ro"] },
			slash: { healthcheck: { test: shell }, volumes: ["/host/tmp:/tmp/"] },
			object: {
				healthcheck: { test: shell },
				volumes: [{ type: "volume", source: "d", target: "/tmp" }],
			},
			anon: { healthcheck: { test: shell }, volumes: ["/tmp"] },
			marker: {
				healthcheck: { test: shell },
				volumes: [`x:${MARKER}`],
			},
			tmpfsString: { healthcheck: { test: shell }, tmpfs: "/tmp" },
			tmpfsList: {
				healthcheck: { test: shell },
				tmpfs: ["/run", "/tmp:size=64m"],
			},
			readonly: { healthcheck: { test: shell }, read_only: true },
			shape: { healthcheck: { test: ["CMD-SHELL", "a", "b"] } },
			other: {
				healthcheck: { test: shell },
				volumes: ["data:/data", "x:/tmp/app"],
				tmpfs: ["/run"],
				read_only: false,
			},
		},
	};
	const warned = (...names: string[]) =>
		getRollingDrainWarnings(input, names).map((w) => w.service);

	it("names a rolled service whose healthcheck is exec form, and says why in one line", () => {
		const warnings = getRollingDrainWarnings(input, ["exec"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			'"exec": the healthcheck is exec form, so the old container is stopped while Traefik still routes to it. A CMD-SHELL healthcheck (it needs a shell in the image) avoids that.',
		);
	});

	it("a test of a shape that cannot be wrapped is not called exec form", () => {
		expect(getRollingDrainWarnings(input, ["shape"])[0]?.message).toBe(
			'"shape": the healthcheck test has a shape Dokploy cannot wrap, so the old container is stopped while Traefik still routes to it. Use a plain string or ["CMD-SHELL", "..."].',
		);
	});

	it("is silent when the old container can be drained", () => {
		expect(warned("shell", "text", "none", "off", "disabled", "other")).toEqual(
			[],
		);
		expect(getRollingDrainWarnings(input, [])).toEqual([]);
		expect(getRollingDrainWarnings(null, ["shell"])).toEqual([]);
	});

	it.each([
		["a named volume on /tmp", "named"],
		["a bind mount on /tmp", "bind"],
		["a mount on /tmp/ with a trailing slash", "slash"],
		["a long-syntax volume on /tmp", "object"],
		["an anonymous volume on /tmp", "anon"],
		["a mount on the marker path", "marker"],
		["tmpfs as a string", "tmpfsString"],
		["tmpfs in a list, with options", "tmpfsList"],
		["read_only", "readonly"],
	])("%s: warns that /tmp cannot carry the marker", (_label, name) => {
		const warnings = getRollingDrainWarnings(input, [name]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe(
			`"${name}": /tmp is read-only or a volume, bind mount or tmpfs, so the old container is stopped while Traefik still routes to it.`,
		);
	});

	it("one warning per service, in the order given", () => {
		expect(warned("exec", "shell", "named", "readonly")).toEqual([
			"exec",
			"named",
			"readonly",
		]);
	});
});

describe("the compose the deploy writes", () => {
	const raw = [
		"services:",
		"  web:",
		"    image: nginx:1.27",
		"    healthcheck:",
		"      test: [CMD-SHELL, 'curl -f http://localhost:$$PORT/health']",
		"      interval: 5s",
		"  worker:",
		"    image: nginx:1.27",
		"    healthcheck:",
		"      test: [CMD-SHELL, 'true']",
		"",
	].join("\n");
	const compose = {
		appName: "drain-app",
		composeId: "c1",
		sourceType: "raw",
		composeFile: raw,
		command: "",
		composePath: "docker-compose.yml",
		composeType: "docker-compose",
		isolatedDeployment: false,
		randomize: false,
		suffix: "",
		serverId: "srv-1",
		env: "",
		mounts: [],
		createEnvFile: false,
		domains: [],
		environment: { project: { env: "" }, env: "" },
	} as never;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.writeFileRemote.mockResolvedValue(undefined);
	});

	const staged = () => mocks.writeFileRemote.mock.calls[0]?.[2] as string;

	it("wraps the rolled services' healthchecks and nothing else", async () => {
		await writeDomainsToCompose(compose, [], {
			deploymentId: "dep-1",
			rollingDrainServices: ["web"],
		});
		const parsed = parse(staged()) as {
			services: Record<
				string,
				{ healthcheck: { test: string[]; interval?: string } }
			>;
		};
		expect(parsed.services.web?.healthcheck.test).toEqual([
			"CMD-SHELL",
			`[ ! -s ${MARKER} ] && ( curl -f http://localhost:$$PORT/health )`,
		]);
		expect(parsed.services.web?.healthcheck.interval).toBe("5s");
		expect(parsed.services.worker?.healthcheck.test).toEqual([
			"CMD-SHELL",
			"true",
		]);
	});

	it("without rolled services the staged compose is byte-identical to before", async () => {
		await writeDomainsToCompose(compose, [], { deploymentId: "dep-1" });
		const plain = staged();
		mocks.writeFileRemote.mockClear();
		await writeDomainsToCompose(compose, [], {
			deploymentId: "dep-1",
			rollingDrainServices: [],
		});
		expect(staged()).toBe(plain);
		mocks.writeFileRemote.mockClear();
		// A rolled service whose healthcheck cannot be wrapped changes nothing.
		await writeDomainsToCompose(compose, [], {
			deploymentId: "dep-1",
			rollingDrainServices: ["nope"],
		});
		expect(staged()).toBe(plain);
		expect(plain).not.toContain(".dokploy-drain");
	});

	it("is stable across deploys: the same compose renders the same file", async () => {
		await writeDomainsToCompose(compose, [], {
			deploymentId: "dep-1",
			rollingDrainServices: ["web", "worker"],
		});
		const first = staged();
		mocks.writeFileRemote.mockClear();
		await writeDomainsToCompose(compose, [], {
			deploymentId: "dep-2",
			rollingDrainServices: ["web", "worker"],
		});
		expect(staged()).toBe(first);
	});
});

describe("the drain in the generated script", () => {
	const script = (
		extra: Partial<Parameters<typeof getRollingReplaceScript>[0]> = {},
	) =>
		getRollingReplaceScript({
			appName: "my-app",
			invocation: "compose -p my-app -f docker-compose.yml",
			services: ["web"],
			remoteBuild: false,
			pullAlways: false,
			healthTimeoutSeconds: 90,
			drainSeconds: 5,
			...extra,
		}).definitions;

	const inOrder = (text: string, parts: string[], from: string) => {
		let at = text.indexOf(from);
		expect(at, from).toBeGreaterThan(-1);
		for (const part of parts) {
			const next = text.indexOf(part, at);
			expect(next, part).toBeGreaterThan(-1);
			at = next;
		}
	};

	it("parses", () => {
		expect(parses(`${script()}\ndokploy_roll_run`)).toBe("ok");
		expect(parses(`${script({ drainSeconds: 0 })}\ndokploy_roll_run`)).toBe(
			"ok",
		);
	});

	it("the service sequence: healthy, take the old one out of rotation, drain, stop", () => {
		inOrder(
			script(),
			[
				'dokploy_roll_wait_healthy "$DR_NEW"',
				'dokploy_roll_take_out "$1" "$DR_OLD"',
				"waiting 5s before the old container is stopped",
				"dokploy_roll_remove $DR_OLD",
			],
			"dokploy_roll_service() {",
		);
	});

	it("the promotion is marked before the marker is written", () => {
		inOrder(
			script(),
			[
				"DOKPLOY_ROLL_ACTIVE=0;",
				'DOKPLOY_ROLL_PROMOTING="$2";',
				"DOKPLOY_ROLL_PROMOTED=1;",
				"docker cp",
			],
			"dokploy_roll_take_out() {",
		);
	});

	it("checks the old container's healthcheck, mounts and root file system before touching it", () => {
		const definitions = script();
		expect(definitions).toContain("{{.HostConfig.ReadonlyRootfs}}");
		expect(definitions).toContain("{{range .Mounts}}{{.Destination}} {{end}}");
		expect(definitions).toContain(
			"{{range $k, $v := .HostConfig.Tmpfs}}{{$k}} {{end}}",
		);
		expect(definitions).toContain("{{json .Config.Healthcheck.Test}}");
		expect(definitions).toContain(`grep -qF -- '${MARKER}'`);
		// A mount on /, /tmp or the marker refuses the drain.
		expect(definitions).toContain(`/|/tmp|/tmp/|${MARKER})`);
		expect(definitions).toContain("its root file system is read-only");
		inOrder(
			definitions,
			["dokploy_roll_honours_drain", "DOKPLOY_ROLL_PROMOTING", "docker cp"],
			"dokploy_roll_take_out() {",
		);
	});

	it("the promotion is marked just before the first copy, and undone when the copy fails", () => {
		const definitions = script();
		inOrder(
			definitions,
			[
				"mktemp",
				"chmod 644",
				'DOKPLOY_ROLL_PROMOTING="$2"',
				'docker cp "$DR_TMP"',
				'DOKPLOY_ROLL_ACTIVE=1; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_PROMOTED=$DR_WAS_PROMOTED;',
			],
			"dokploy_roll_take_out() {",
		);
		// What a previous service promoted is kept, not reset to 0.
		inOrder(
			definitions,
			["DR_WAS_PROMOTED=$DOKPLOY_ROLL_PROMOTED", "dokploy_roll_take_out"],
			"dokploy_roll_service() {",
		);
	});

	it("re-checks the new replica after the take-out and again after the drain delay, before the stop", () => {
		inOrder(
			script(),
			[
				'dokploy_roll_take_out "$1"',
				'dokploy_roll_new_still_ok "$1"',
				"dokploy_roll_sleep 5",
				'dokploy_roll_new_still_ok "$1"',
				'DOKPLOY_ROLL_PROMOTING="$DR_OLD"',
				"dokploy_roll_remove $DR_OLD",
			],
			"dokploy_roll_service() {",
		);
		// The undo: an empty file over the marker, the promotion reset, the usual failure path.
		inOrder(
			script(),
			[
				"dokploy_roll_unmark",
				"dokploy_roll_wait_recovered",
				'if [ "$DR_BACK" = "1" ]; then',
				'dokploy_roll_fail "$1"',
			],
			"dokploy_roll_new_still_ok() {",
		);
		// The unhealthy wait gives up as soon as the new replica is not healthy.
		expect(script()).toContain(
			'if [ "$(dokploy_roll_new_state "$3")" != "running healthy" ]; then return 2; fi;',
		);
	});

	it("the new replica is only discarded once the old container is healthy again; otherwise nothing is removed", () => {
		const definitions = script();
		const stillOk = definitions.indexOf("dokploy_roll_new_still_ok() {");
		const fail = definitions.indexOf('dokploy_roll_fail "$1"', stillOk);
		const kept = definitions.indexOf("Nothing was replaced", stillOk);
		expect(fail).toBeGreaterThan(definitions.indexOf("DR_BACK=1;", stillOk));
		expect(kept).toBeGreaterThan(fail);
		// The never-recovers path removes and stops nothing.
		const keptBlock = definitions.slice(
			definitions.lastIndexOf("# Neither container", kept),
			kept,
		);
		expect(keptBlock).not.toMatch(
			/docker (stop|rm)|dokploy_roll_(remove|discard|fail)/,
		);
		// The recovery wait is interval + timeout + 5 s.
		expect(definitions).toContain("b = i + t + 5");
	});

	it("the old container is marked as the survivor before the unmark and the recovery wait", () => {
		inOrder(
			script(),
			[
				"DR_BACK=1;",
				'DOKPLOY_ROLL_ACTIVE=1; DOKPLOY_ROLL_PROMOTING=""; DOKPLOY_ROLL_PROMOTED=$DR_WAS_PROMOTED;',
				"dokploy_roll_unmark",
				"dokploy_roll_wait_recovered",
				"DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTED=1;",
			],
			"dokploy_roll_new_still_ok() {",
		);
	});

	it("reads the healthcheck test on its own, so no healthcheck and a failed inspect are told apart", () => {
		const definitions = script();
		expect(definitions).toContain(
			"docker inspect -f '{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{end}}'",
		);
		expect(definitions).toContain('DR_WHY="it has no healthcheck"');
		expect(definitions).toContain(
			'DR_WHY="the old container could not be inspected"',
		);
	});

	it("the mount loop does not glob, on every way out of it", () => {
		const definitions = script();
		const loop = definitions.indexOf("for DR_M in");
		expect(definitions.lastIndexOf("set -f;", loop)).toBeGreaterThan(
			definitions.indexOf("dokploy_roll_honours_drain() {"),
		);
		// The early return and the normal exit both turn globbing back on.
		expect(definitions).toContain("set +f; DR_WHY=");
		expect(definitions).toContain("done;\n\t\t\tset +f;");
	});

	it("guards the bound: an empty or non-numeric value falls back to the longest timeout", () => {
		const definitions = script();
		inOrder(
			definitions,
			[
				'DR_BOUND=$(dokploy_roll_drain_bound "$DR_O");',
				"case \"$DR_BOUND\" in ''|*[!0-9]*) DR_BOUND=900;; esac;",
				"dokploy_roll_wait_out",
			],
			"dokploy_roll_take_out() {",
		);
	});

	it("writes the marker with docker cp from a world-readable temp file", () => {
		const definitions = script();
		expect(definitions).toContain("mktemp");
		expect(definitions).toContain("chmod 644");
		expect(definitions).toContain(`docker cp "$DR_TMP" "$DR_O:${MARKER}"`);
		expect(definitions).toContain('rm -f "$DR_TMP"');
		// No docker exec: the image may have no binary at all.
		expect(definitions).not.toContain("docker exec");
	});

	it("waits for unhealthy, bounded by the old container's own healthcheck and capped at 900 s", () => {
		const definitions = script({ healthTimeoutSeconds: 77 });
		expect(definitions).toContain(
			'{{printf "%d %d %d %d" .Config.Healthcheck.Interval .Config.Healthcheck.Timeout .Config.Healthcheck.Retries .Config.Healthcheck.StartPeriod}}',
		);
		// The longest health timeout, not this deploy's.
		expect(definitions).toContain("awk -v cap=900");
		expect(definitions).not.toContain("awk -v cap=77");
		// start period + (interval + timeout) x retries + interval + slack, Docker's defaults when unset.
		expect(definitions).toContain("b = p + (i + t) * r + i + 3");
		expect(definitions).toContain("if (i <= 0) i = 30");
		expect(definitions).toContain("if (t <= 0) t = 30");
		expect(definitions).toContain("if (r <= 0) r = 3");
		expect(definitions).toContain("if (b > cap) b = cap");
		expect(definitions).toContain('"running unhealthy"');
	});

	it("waits past the Traefik providers throttle (2 s default plus 1 s) before the drain delay", () => {
		expect(ROLLING_ROUTE_SETTLE_SECONDS).toBe(3);
		const definitions = script();
		inOrder(
			definitions,
			[
				"dokploy_roll_wait_out",
				`dokploy_roll_sleep ${ROLLING_ROUTE_SETTLE_SECONDS}`,
				"DR_OUT=1",
			],
			"dokploy_roll_take_out() {",
		);
		expect(script({ routeSettleSeconds: 9 })).toContain("dokploy_roll_sleep 9");
	});

	it("the drain delay runs after the old container is out of rotation", () => {
		inOrder(
			script(),
			[
				"dokploy_roll_take_out",
				"the old container is out of rotation, waiting 5s before the old container is stopped",
				"dokploy_roll_sleep 5",
				"dokploy_roll_remove $DR_OLD",
			],
			"dokploy_roll_service() {",
		);
	});

	it("falls back to the old behaviour with a clear line, never failing the deploy", () => {
		const definitions = script();
		expect(definitions).toContain(
			"the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail",
		);
		// The fallback still drains and stops: the take-out is a best effort.
		expect(definitions).toContain(
			"the new replica is healthy, waiting 5s before the old container is stopped",
		);
		expect(definitions).not.toMatch(/dokploy_roll_take_out[^\n]*\|\| return 1/);
	});

	it("stops with the container's own grace: docker stop gets no -t", () => {
		const definitions = script();
		expect(definitions).toContain('docker stop "$@"');
		expect(definitions).not.toMatch(/docker stop (-t|--time)/);
	});

	it("the old container is out of rotation even with no drain delay", () => {
		const definitions = script({ drainSeconds: 0 });
		expect(definitions).toContain("dokploy_roll_take_out");
		expect(definitions).not.toContain("waiting 0s");
	});

	it("a hostile app name still parses with the drain in place", () => {
		const hostile = getRollingReplaceScript({
			appName: "a'b$(touch /tmp/x)",
			invocation: "compose -p 'a b' -f 'x;y.yml'",
			services: ["w;x", "$(id)"],
			remoteBuild: false,
			pullAlways: false,
			healthTimeoutSeconds: 90,
			drainSeconds: 3,
		});
		expect(parses(`${hostile.definitions}\n${hostile.call}`)).toBe("ok");
	});
});
