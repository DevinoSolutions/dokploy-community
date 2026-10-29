import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getRollingReplaceScript,
	ROLLING_DRAIN_MARKER_PATH,
	type RollingScriptOptions,
} from "@dokploy/server/utils/builders/compose-rolling";
import {
	getKillRemoteBuildCommand,
	getReleaseCancelKey,
	wrapCancelableRemoteBuild,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	boundedSh,
	boundedShellAvailable,
	boundedShSpawn,
	killLaunched,
} from "./helpers/bounded-shell";

/**
 * The generated rolling replace functions, executed in a real shell against a
 * stateful stub `docker` first on PATH (`__fixtures__/rolling-stub-docker.sh`).
 * Every wait is a bounded poll; no test sleeps for a fixed time and then
 * asserts.
 */

const toShellPath = (path: string) =>
	process.platform === "win32"
		? path
				.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
				.replace(/\\/g, "/")
		: path;

const root = mkdtempSync(join(tmpdir(), "dokploy-rolling-"));
let worldCount = 0;

const stubSource = readFileSync(
	new URL("./__fixtures__/rolling-stub-docker.sh", import.meta.url),
	"utf8",
).replace(/\r\n/g, "\n");

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

// The cancel launcher needs setsid and /proc (see remote-build-cancel.ts).
const hasSetsid =
	process.platform !== "win32" &&
	boundedShellAvailable &&
	boundedSh(["-c", "command -v setsid && [ -d /proc/self ]"], {
		encoding: "utf8",
		timeout: 30_000,
	}).status === 0;

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

// The release launcher runs the script in a session of its own, which the
// bound on the spawned shell does not reach: whatever a test leaves of it dies
// here (and once the bounded shell is gone, see `leftovers` in bounded-shell).
afterEach(() => killLaunched());

interface ServiceConfig {
	/** `docker compose config --hash` now. */
	hash: string;
	/** Image refs the service resolves to. */
	images?: string[];
	/** Image id of a replica started by `up`. */
	newImage?: string;
	newHealth?: string;
}

interface ContainerSeed {
	id: string;
	service: string;
	hash: string;
	image: string;
	running?: boolean;
	health?: string;
	created?: string;
	/** Config.Healthcheck.Test as docker prints it (JSON); unset = no healthcheck config. */
	healthTest?: string;
	/** "<interval> <timeout> <retries> [<start period>]", durations in nanoseconds. */
	healthCfg?: string;
	/** What an empty copy over the marker does: healthy (default), delay:<polls>, never. */
	recoverMode?: string;
	/** HostConfig.ReadonlyRootfs. */
	readonlyRootfs?: boolean;
	/** Destinations of the container's mounts. */
	mounts?: string[];
	/** Paths of its tmpfs mounts. */
	tmpfs?: string[];
	/** What the drain marker does: unhealthy (default), delay:<polls>, stays. */
	drainMode?: string;
}

interface WorldSeed {
	services: string[];
	config: Record<string, ServiceConfig>;
	/** ref -> id of the image as it is on the host after build/pull. */
	imageIds: Record<string, string>;
	containers: ContainerSeed[];
	flags?: string[];
}

const createWorld = (seed: WorldSeed) => {
	const dir = join(root, `world-${worldCount++}`);
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	for (const path of [bin, join(state, "cfg"), join(state, "containers")]) {
		mkdirSync(path, { recursive: true });
	}
	writeFileSync(join(bin, "docker"), stubSource, { mode: 0o755 });
	writeFileSync(
		join(state, "cfg", "services"),
		`${seed.services.join("\n")}\n`,
	);
	for (const [service, config] of Object.entries(seed.config)) {
		const images = config.images ?? [`registry/${service}:1`];
		writeFileSync(join(state, "cfg", `hash.${service}`), config.hash);
		writeFileSync(
			join(state, "cfg", `images.${service}`),
			`${images.join("\n")}\n`,
		);
		writeFileSync(
			join(state, "cfg", `newimage.${service}`),
			config.newImage ?? "sha256:new",
		);
		writeFileSync(
			join(state, "cfg", `newhealth.${service}`),
			config.newHealth ?? "healthy",
		);
	}
	for (const [ref, id] of Object.entries(seed.imageIds)) {
		writeFileSync(
			join(state, "cfg", `imageid.${ref.replace(/[/:]/g, "_")}`),
			id,
		);
	}
	for (const flag of seed.flags ?? []) {
		writeFileSync(join(state, "cfg", flag), "");
	}
	for (const container of seed.containers) {
		const base = join(state, "containers", container.id);
		mkdirSync(base);
		const files: Record<string, string> = {
			service: container.service,
			hash: container.hash,
			image: container.image,
			running: String(container.running ?? true),
			created: container.created ?? "2026-10-15T09:00:00.000000000Z",
			final_health: container.health ?? "healthy",
			polls_left: "0",
		};
		if (container.healthTest !== undefined) {
			files.healthtest = container.healthTest;
			files.healthcfg = container.healthCfg ?? "1000000000 1000000000 1";
		}
		if (container.drainMode !== undefined)
			files.drain_mode = container.drainMode;
		if (container.recoverMode) files.recover_mode = container.recoverMode;
		if (container.readonlyRootfs) files.readonly = "true";
		if (container.mounts) files.mounts = container.mounts.join(" ");
		if (container.tmpfs) files.tmpfs = container.tmpfs.join(" ");
		for (const [name, value] of Object.entries(files)) {
			writeFileSync(join(base, name), value);
		}
	}
	return { dir, bin, state };
};

type World = ReturnType<typeof createWorld>;

const baseOptions: RollingScriptOptions = {
	appName: "my-app",
	invocation: "compose -p my-app -f docker-compose.yml",
	services: ["web"],
	remoteBuild: false,
	pullAlways: false,
	healthTimeoutSeconds: 20,
	drainSeconds: 0,
	pollIntervalSeconds: 1,
};

const writeScript = (world: World, body: string) => {
	const path = join(world.dir, `script-${Date.now()}-${Math.random()}.sh`);
	writeFileSync(path, body);
	return toShellPath(path);
};

const scriptFor = (
	options: Partial<RollingScriptOptions>,
	{ before = "" }: { before?: string } = {},
) => {
	const { definitions, call } = getRollingReplaceScript({
		...baseOptions,
		...options,
	});
	return `${definitions}\n${before}\n${call}; echo "RC=$?"; echo "PROMOTED=$DOKPLOY_ROLL_PROMOTED"\n`;
};

const envFor = (world: World) => ({
	...process.env,
	PATH: `${toShellPath(world.bin)}:${process.env.PATH ?? ""}`,
});

const runRoll = (
	world: World,
	options: Partial<RollingScriptOptions> = {},
	extra: { before?: string } = {},
) => {
	const result = boundedSh([writeScript(world, scriptFor(options, extra))], {
		encoding: "utf8",
		env: envFor(world),
		timeout: 90_000,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		rc: Number(/RC=(\d+)/.exec(result.stdout)?.[1] ?? "-1"),
		promoted: /PROMOTED=(\d)/.exec(result.stdout)?.[1],
		exit: result.status,
	};
};

const calls = (world: World) => {
	const path = join(world.state, "calls.log");
	return existsSync(path)
		? readFileSync(path, "utf8").split("\n").filter(Boolean)
		: [];
};

const violations = (world: World) => {
	const path = join(world.state, "violations.log");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const containersOf = (world: World, service: string) =>
	readdirSync(join(world.state, "containers")).filter(
		(id) =>
			readFileSync(join(world.state, "containers", id, "service"), "utf8") ===
			service,
	);

const runningOf = (world: World, service: string) =>
	containersOf(world, service).filter(
		(id) =>
			readFileSync(join(world.state, "containers", id, "running"), "utf8") ===
			"true",
	);

const indexOfCall = (log: string[], needle: string, from = 0) =>
	log.findIndex((line, index) => index >= from && line.includes(needle));

const OLD = "zz-old-web";

/** One service with a running old container that differs from the new release. */
const changedWeb = (extra: Partial<WorldSeed> = {}): WorldSeed => ({
	services: ["web", "api"],
	config: {
		web: { hash: "H2", newImage: "sha256:NEW-web" },
		api: { hash: "A1", newImage: "sha256:NEW-api" },
	},
	imageIds: {
		"registry/web:1": "sha256:NEW-web",
		"registry/api:1": "sha256:NEW-api",
	},
	containers: [
		{ id: OLD, service: "web", hash: "H1", image: "sha256:OLD-web" },
		{ id: "aa-api", service: "api", hash: "A1", image: "sha256:NEW-api" },
	],
	...extra,
});

const DRAIN_TEST = JSON.stringify([
	"CMD-SHELL",
	`[ ! -s ${ROLLING_DRAIN_MARKER_PATH} ] && ( true )`,
]);

/** Like `changedWeb`, with an old container whose healthcheck honours the marker. */
const drainableWeb = (
	container: Partial<ContainerSeed> = {},
	extra: Partial<WorldSeed> = {},
): WorldSeed =>
	changedWeb({
		...extra,
		containers: [
			{
				id: OLD,
				service: "web",
				hash: "H1",
				image: "sha256:OLD-web",
				healthTest: DRAIN_TEST,
				...container,
			},
			{ id: "aa-api", service: "api", hash: "A1", image: "sha256:NEW-api" },
		],
	});

describe.skipIf(!hasSh)("rolling replace executed in a real shell", () => {
	it("replaces a changed service: others first, second replica, healthy, then the old id is stopped", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(changedWeb());
		const result = runRoll(world);
		const log = calls(world);

		expect(result.rc).toBe(0);
		expect(result.promoted).toBe("1");
		expect(violations(world)).toBe("");

		const others = indexOfCall(log, "up -d --no-deps --build api");
		const scaleUp = indexOfCall(log, "--scale web=2 web");
		const stopOld = indexOfCall(log, `docker stop ${OLD}`);
		const removeOld = indexOfCall(log, `docker rm -f ${OLD}`);
		const final = indexOfCall(
			log,
			"up -d --no-recreate --no-build --remove-orphans web api",
		);
		expect(others).toBeGreaterThan(-1);
		expect(scaleUp).toBeGreaterThan(others);
		// The new replica is judged before the old one is touched.
		const healthCheck = indexOfCall(log, "State.Health.Status", scaleUp);
		expect(healthCheck).toBeGreaterThan(scaleUp);
		expect(stopOld).toBeGreaterThan(healthCheck);
		expect(removeOld).toBeGreaterThan(stopOld);
		expect(final).toBeGreaterThan(removeOld);
		// Compose's scale-down is never used.
		expect(indexOfCall(log, "--scale web=1")).toBe(-1);

		// One container is left and it is the new one, never the old id.
		const left = containersOf(world, "web");
		expect(left).toHaveLength(1);
		expect(left[0]).toMatch(/^web-new-/);
		expect(containersOf(world, "api")).toEqual(["aa-api"]);
		// The new replica was not stopped or removed.
		expect(
			log.some(
				(line) => line.includes(`${left[0]}`) && /docker (stop|rm)/.test(line),
			),
		).toBe(false);
	});

	it("tells old from new by id even when the old id sorts last (never the highest-numbered)", {
		timeout: 90_000,
	}, () => {
		// `zz-old-web` sorts after `web-new-N`: a script that removed "the last"
		// container, as Compose's own scale-down does, would remove the old one by
		// accident of the name here, and the new one in real Compose.
		const world = createWorld(changedWeb());
		const result = runRoll(world);
		expect(result.rc).toBe(0);
		const stops = calls(world).filter((line) => line.startsWith("docker stop"));
		expect(stops).toEqual([`docker stop ${OLD}`]);
	});

	it("skips a service whose config hash and image id both match", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: { hash: "H1", newImage: "sha256:OLD-web" },
					api: { hash: "A1" },
				},
				imageIds: {
					"registry/web:1": "sha256:OLD-web",
					"registry/api:1": "sha256:NEW-api",
				},
			}),
		);
		const result = runRoll(world);
		const log = calls(world);
		expect(result.rc).toBe(0);
		expect(result.stdout).toContain("web: unchanged");
		expect(result.promoted).toBe("0");
		expect(log.some((line) => line.includes("--scale"))).toBe(false);
		expect(log.some((line) => line.startsWith("docker stop"))).toBe(false);
		expect(containersOf(world, "web")).toEqual([OLD]);
	});

	it("rolls when the hash is unchanged but the image id changed", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: { hash: "H1", newImage: "sha256:REBUILT" },
					api: { hash: "A1" },
				},
				imageIds: {
					"registry/web:1": "sha256:REBUILT",
					"registry/api:1": "sha256:NEW-api",
				},
			}),
		);
		const result = runRoll(world);
		expect(result.rc).toBe(0);
		expect(
			calls(world).some((line) => line.includes("--scale web=2 web")),
		).toBe(true);
		expect(runningOf(world, "web")[0]).toMatch(/^web-new-/);
	});

	it("starts a service with no running container with a plain up", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				containers: [
					{
						id: OLD,
						service: "web",
						hash: "H1",
						image: "sha256:OLD-web",
						running: false,
					},
					{ id: "aa-api", service: "api", hash: "A1", image: "sha256:NEW-api" },
				],
			}),
		);
		const result = runRoll(world);
		const log = calls(world);
		expect(result.rc).toBe(0);
		expect(log.some((line) => line.includes("--scale"))).toBe(false);
		expect(
			log.some((line) => line.endsWith("up -d --no-deps --no-build web")),
		).toBe(true);
		expect(violations(world)).toBe("");
	});

	it("with every service selected there is no others step and every up names its services", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(changedWeb());
		const result = runRoll(world, {
			services: ["web", "api"],
		});
		const log = calls(world);
		expect(result.rc).toBe(0);
		expect(result.stdout).not.toContain("services that are not rolled");
		const ups = log.filter((line) => / up /.test(line));
		expect(ups.length).toBeGreaterThan(0);
		expect(violations(world)).toBe("");
		for (const line of ups) {
			expect(line).toMatch(/\b(web|api)\b/);
		}
		// The final up lists every active service.
		expect(
			log.some((line) =>
				line.includes(
					"up -d --no-recreate --no-build --remove-orphans web api",
				),
			),
		).toBe(true);
	});

	it("an inactive profile stays inactive: services come from config --services", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				services: ["web"],
				config: {
					web: { hash: "H2", newImage: "sha256:NEW-web" },
					api: { hash: "A1" },
				},
			}),
		);
		const result = runRoll(world);
		const log = calls(world);
		expect(result.rc).toBe(0);
		expect(log.some((line) => /up .*\bapi\b/.test(line))).toBe(false);
	});

	it("an unhealthy new replica is removed, the old container is never touched, exit is non-zero", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: {
						hash: "H2",
						newImage: "sha256:NEW-web",
						newHealth: "unhealthy",
					},
					api: { hash: "A1" },
				},
			}),
		);
		const result = runRoll(world);
		const log = calls(world);
		expect(result.rc).toBe(1);
		expect(result.promoted).toBe("0");
		expect(result.stdout).toContain("Rolling replace of web failed");
		expect(result.stdout).toContain("reported unhealthy");
		expect(containersOf(world, "web")).toEqual([OLD]);
		expect(runningOf(world, "web")).toEqual([OLD]);
		expect(
			log.some((line) => line.includes(OLD) && /docker (stop|rm)/.test(line)),
		).toBe(false);
		expect(log.some((line) => /docker rm -f web-new-/.test(line))).toBe(true);
	});

	it("a replica that never becomes healthy times out within the bound and is removed", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: { hash: "H2", newImage: "sha256:NEW-web", newHealth: "never" },
					api: { hash: "A1" },
				},
			}),
		);
		const started = Date.now();
		const result = runRoll(world, { healthTimeoutSeconds: 3 });
		const elapsed = Date.now() - started;
		expect(result.rc).toBe(1);
		expect(result.stdout).toContain("was not healthy within 3s");
		expect(containersOf(world, "web")).toEqual([OLD]);
		// Bounded: the timeout plus process start-up, nowhere near a hang.
		expect(elapsed).toBeLessThan(60_000);
	});

	it("a replica with no health status (disabled healthcheck) is refused on the second poll", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: { hash: "H2", newImage: "sha256:NEW-web", newHealth: "none" },
					api: { hash: "A1" },
				},
			}),
		);
		const result = runRoll(world);
		expect(result.rc).toBe(1);
		expect(result.stdout).toContain("no health status");
		expect(containersOf(world, "web")).toEqual([OLD]);
	});

	it("a replica reported without health status on the first poll only is not removed", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: {
						hash: "H2",
						newImage: "sha256:NEW-web",
						newHealth: "noneonce",
					},
					api: { hash: "A1" },
				},
			}),
		);
		const result = runRoll(world);
		expect(result.rc).toBe(0);
		expect(result.stdout).not.toContain("no health status");
		expect(containersOf(world, "web")).toHaveLength(1);
		expect(containersOf(world, "web")).not.toContain(OLD);
	});

	it("a replica that becomes healthy after a few polls is accepted", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(
			changedWeb({
				config: {
					web: { hash: "H2", newImage: "sha256:NEW-web", newHealth: "delay:2" },
					api: { hash: "A1" },
				},
			}),
		);
		const result = runRoll(world);
		expect(result.rc).toBe(0);
		expect(result.stdout).toContain("the new replica is running starting");
		expect(result.stdout).toContain("the new replica is running healthy");
		expect(containersOf(world, "web")).toHaveLength(1);
	});

	it("when the second replica cannot be started nothing is removed", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(changedWeb({ flags: ["up.fail.web"] }));
		const result = runRoll(world);
		expect(result.rc).toBe(1);
		expect(result.stdout).toContain("could not start the second replica");
		expect(containersOf(world, "web")).toEqual([OLD]);
		expect(runningOf(world, "web")).toEqual([OLD]);
	});

	it("partial failure: services already rolled stay on the new release and the deploy fails", {
		timeout: 90_000,
	}, () => {
		const world = createWorld({
			services: ["web", "api"],
			config: {
				web: { hash: "H2", newImage: "sha256:NEW-web" },
				api: { hash: "A2", newImage: "sha256:NEW-api", newHealth: "unhealthy" },
			},
			imageIds: {
				"registry/web:1": "sha256:NEW-web",
				"registry/api:1": "sha256:NEW-api",
			},
			containers: [
				{ id: OLD, service: "web", hash: "H1", image: "sha256:OLD-web" },
				{
					id: "zz-old-api",
					service: "api",
					hash: "A1",
					image: "sha256:OLD-api",
				},
			],
		});
		const result = runRoll(world, {
			services: ["web", "api"],
		});
		expect(result.rc).toBe(1);
		// A service was replaced: the script must not offer a restore.
		expect(result.promoted).toBe("1");
		expect(containersOf(world, "web")).toHaveLength(1);
		expect(containersOf(world, "web")[0]).toMatch(/^web-new-/);
		expect(containersOf(world, "api")).toEqual(["zz-old-api"]);
		expect(runningOf(world, "api")).toEqual(["zz-old-api"]);
	});

	it("an old container that is still running after the stop fails the deploy", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(changedWeb({ flags: ["stop.noop", "rm.fail"] }));
		const result = runRoll(world);
		expect(result.rc).toBe(1);
		expect(result.stdout).toContain("could not be removed");
	});

	it("an old container that cannot be removed keeps the new replica serving and runs no compose up", {
		timeout: 90_000,
	}, () => {
		// The old container sorts first, like the lowest-numbered one in Compose:
		// a scale-down would remove the new replica and start the old one again.
		const OLD_FIRST = "aa-old-web";
		const world = createWorld(
			changedWeb({
				flags: ["rm.fail"],
				containers: [
					{
						id: OLD_FIRST,
						service: "web",
						hash: "H1",
						image: "sha256:OLD-web",
					},
					{ id: "aa-api", service: "api", hash: "A1", image: "sha256:NEW-api" },
				],
			}),
		);
		const result = runRoll(world);
		const log = calls(world);
		expect(result.rc).not.toBe(0);
		expect(result.stdout).toContain("could not be removed");
		expect(result.stdout).not.toContain("replaced");
		// The new replica is the only one running; the old one is stopped.
		const running = runningOf(world, "web");
		expect(running).toHaveLength(1);
		expect(running).not.toContain(OLD_FIRST);
		// No compose up after the failed removal.
		const stopOld = indexOfCall(log, `docker stop ${OLD_FIRST}`);
		expect(stopOld).toBeGreaterThan(-1);
		expect(indexOfCall(log, " up ", stopOld)).toBe(-1);
	});

	it("waits the drain delay between healthy and stopping the old container", {
		timeout: 90_000,
	}, () => {
		const world = createWorld(changedWeb());
		const started = Date.now();
		const result = runRoll(world, { drainSeconds: 2 });
		expect(result.rc).toBe(0);
		const out = result.stdout;
		expect(out).toContain("waiting 2s before the old container is stopped");
		expect(out.indexOf("waiting 2s")).toBeLessThan(
			out.indexOf("stopping and removing the old container"),
		);
		// Never shorter than the delay.
		expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
	});

	describe("the old container is taken out of rotation before it is stopped (T-9197)", () => {
		const OPTIONS = { drainSeconds: 1, routeSettleSeconds: 1 };
		const FALLBACK_LINE =
			"the old container could not be taken out of rotation before it was stopped; requests in flight at the stop may fail";
		const drainFile = (world: World, name: string) =>
			readFileSync(join(world.state, `cp.${OLD}.${name}`), "utf8");

		it("marker, unhealthy, Traefik settle, drain delay, then stop (without -t)", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(drainableWeb());
			const started = Date.now();
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			const out = result.stdout;

			expect(result.rc).toBe(0);
			expect(result.promoted).toBe("1");
			expect(violations(world)).toBe("");

			// The new replica is judged, then the marker goes in, then the old
			// container is polled until it is unhealthy, and only then stopped.
			const scaleUp = indexOfCall(log, "--scale web=2 web");
			const healthy = indexOfCall(log, "State.Health.Status", scaleUp);
			const honours = indexOfCall(log, "Config.Healthcheck.Test", healthy);
			const copy = indexOfCall(log, "docker cp", honours);
			const polled = log.findIndex(
				(line, index) =>
					index > copy &&
					line.includes("State.Status") &&
					line.endsWith(` ${OLD}`),
			);
			const stop = log.indexOf(`docker stop ${OLD}`);
			expect(honours).toBeGreaterThan(healthy);
			expect(copy).toBeGreaterThan(honours);
			expect(polled).toBeGreaterThan(copy);
			expect(stop).toBeGreaterThan(polled);
			expect(log[copy]?.endsWith(` ${OLD}:${ROLLING_DRAIN_MARKER_PATH}`)).toBe(
				true,
			);
			// `docker stop` keeps the container's own grace period: no -t.
			expect(log.filter((line) => line.startsWith("docker stop"))).toEqual([
				`docker stop ${OLD}`,
			]);

			// What was copied: a non-empty file the container's user can read.
			expect(drainFile(world, "content")).toBe("drain\n");
			expect(drainFile(world, "path")).toBe(ROLLING_DRAIN_MARKER_PATH);
			expect(drainFile(world, "perm")).toMatch(/^-rw-r--r--/);

			const order = [
				"taking the old container out of rotation",
				"the old container is running unhealthy",
				"waiting 1s for Traefik to drop it",
				"waiting 1s before the old container is stopped so that requests in flight finish",
				"stopping and removing the old container",
			].map((part) => out.indexOf(part));
			expect(order.every((at) => at > -1)).toBe(true);
			expect([...order].sort((a, b) => a - b)).toEqual(order);
			expect(out).not.toContain(FALLBACK_LINE);
			// Both waits are honoured.
			expect(Date.now() - started).toBeGreaterThanOrEqual(1900);

			const left = containersOf(world, "web");
			expect(left).toHaveLength(1);
			expect(left[0]).toMatch(/^web-new-/);
		});

		it("with no drain delay the old container is still taken out of rotation", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(drainableWeb());
			const result = runRoll(world, { drainSeconds: 0, routeSettleSeconds: 1 });
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain("waiting 1s for Traefik to drop it");
			expect(result.stdout).not.toContain(
				"before the old container is stopped",
			);
			expect(calls(world).some((line) => line.startsWith("docker cp"))).toBe(
				true,
			);
		});

		it("waits for unhealthy as long as the healthcheck takes to give up", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(drainableWeb({ drainMode: "delay:3" }));
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).toBe(0);
			const copy = indexOfCall(log, "docker cp");
			const stop = log.indexOf(`docker stop ${OLD}`);
			const polls = log
				.slice(copy, stop)
				.filter(
					(line) => line.endsWith(` ${OLD}`) && line.includes("State.Status"),
				);
			// healthy, healthy, healthy, then unhealthy.
			expect(polls.length).toBeGreaterThanOrEqual(4);
			expect(result.stdout).toContain("the old container is running healthy");
			expect(result.stdout).toContain("the old container is running unhealthy");
			expect(result.stdout).not.toContain(FALLBACK_LINE);
		});

		it("bounds the wait by the old container's own healthcheck, start period included, capped at 900 s", {
			timeout: 90_000,
		}, () => {
			// (2 + 1) x 2 + 2 + 3 = 11 s.
			const world = createWorld(
				drainableWeb({ healthCfg: "2000000000 1000000000 2" }),
			);
			const result = runRoll(world, { ...OPTIONS, healthTimeoutSeconds: 20 });
			expect(result.stdout).toContain("waiting up to 11 seconds");

			// A start period of 5 s adds to it, and the health timeout does not cap it.
			const started = createWorld(
				drainableWeb({ healthCfg: "2000000000 1000000000 2 5000000000" }),
			);
			expect(
				runRoll(started, { ...OPTIONS, healthTimeoutSeconds: 10 }).stdout,
			).toContain("waiting up to 16 seconds");

			// Unset interval, timeout and retries are Docker's 30 s, 30 s and 3:
			// (30 + 30) x 3 + 30 + 3 = 213 s.
			const unset = createWorld(drainableWeb({ healthCfg: "0 0 0 0" }));
			expect(runRoll(unset, OPTIONS).stdout).toContain(
				"waiting up to 213 seconds",
			);

			// A 10 minute interval would be 1805 s: capped at the longest health
			// timeout.
			const capped = createWorld(
				drainableWeb({ healthCfg: "600000000000 1000000000 2" }),
			);
			expect(runRoll(capped, OPTIONS).stdout).toContain(
				"waiting up to 900 seconds",
			);
		});

		it("an old container that never reports unhealthy: falls back after the bound and still stops", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(drainableWeb({ drainMode: "stays" }));
			const started = Date.now();
			// Its own healthcheck (1 s, 1 s, 1 retry) bounds the wait at 6 s.
			const result = runRoll(world, OPTIONS);
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain("waiting up to 6 seconds");
			expect(result.stdout).toContain(
				"the old container did not report unhealthy in time",
			);
			expect(result.stdout).toContain(FALLBACK_LINE);
			// Today's behaviour: the drain delay, then the stop.
			expect(result.stdout).toContain(
				"the new replica is healthy, waiting 1s before the old container is stopped",
			);
			expect(calls(world)).toContain(`docker stop ${OLD}`);
			expect(containersOf(world, "web")).toHaveLength(1);
			// Bounded by the cap, not by the 213 s of an unset healthcheck.
			expect(Date.now() - started).toBeLessThan(30_000);
		});

		it("a failed docker cp falls back to the old behaviour without failing the deploy", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(drainableWeb({}, { flags: ["cp.fail"] }));
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain(
				"could not be copied into the old container",
			);
			expect(result.stdout).toContain(FALLBACK_LINE);
			expect(result.stdout).toContain(
				"the new replica is healthy, waiting 1s before the old container is stopped",
			);
			// No unhealthy wait, no Traefik settle.
			expect(result.stdout).not.toContain("for Traefik to drop it");
			expect(log.indexOf(`docker stop ${OLD}`)).toBeGreaterThan(
				indexOfCall(log, "docker cp"),
			);
			expect(containersOf(world, "web")).toHaveLength(1);
		});

		it("a healthcheck that does not honour the marker: no copy, a clear line, the old behaviour", {
			timeout: 90_000,
		}, () => {
			// Exec form (or a container that predates the wrap): the test does not
			// name the marker.
			const world = createWorld(
				drainableWeb({
					healthTest: JSON.stringify(["CMD", "curl", "-f", "x"]),
				}),
			);
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).toBe(0);
			expect(log.some((line) => line.startsWith("docker cp"))).toBe(false);
			expect(result.stdout).toContain("does not honour the marker");
			expect(result.stdout).toContain(FALLBACK_LINE);
			expect(result.stdout).toContain(
				"the new replica is healthy, waiting 1s before the old container is stopped",
			);
			expect(log.filter((line) => line.startsWith("docker stop"))).toEqual([
				`docker stop ${OLD}`,
			]);
			expect(containersOf(world, "web")).toHaveLength(1);
		});

		it("an old container with no healthcheck config at all is the same fallback", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(changedWeb());
			const result = runRoll(world, OPTIONS);
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain("it has no healthcheck");
			expect(result.stdout).not.toContain("could not be inspected");
			expect(result.stdout).toContain(FALLBACK_LINE);
			expect(calls(world).some((line) => line.startsWith("docker cp"))).toBe(
				false,
			);
		});

		it.each([
			[
				"a named volume or bind mount on /tmp",
				{ mounts: ["/data", "/tmp"] },
				"/tmp is a mount",
			],
			["a tmpfs on /tmp", { tmpfs: ["/tmp"] }, "/tmp is a mount"],
			["a mount on the root", { mounts: ["/"] }, "/ is a mount"],
			[
				"a mount on the marker itself",
				{ mounts: [ROLLING_DRAIN_MARKER_PATH] },
				"is a mount",
			],
			["a read-only root file system", { readonlyRootfs: true }, "read-only"],
		])(
			"%s: no marker is written, a clear line, the old behaviour",
			{
				timeout: 90_000,
			},
			(_label, container, reason) => {
				const world = createWorld(drainableWeb(container));
				const result = runRoll(world, OPTIONS);
				const log = calls(world);
				expect(result.rc).toBe(0);
				// Nothing is copied: a shared mount would hand the marker to the new
				// replica as well.
				expect(log.some((line) => line.startsWith("docker cp"))).toBe(false);
				expect(result.stdout).toContain(reason);
				expect(result.stdout).toContain(FALLBACK_LINE);
				expect(result.stdout).not.toContain("for Traefik to drop it");
				expect(result.stdout).toContain(
					"the new replica is healthy, waiting 1s before the old container is stopped",
				);
				expect(log.filter((line) => line.startsWith("docker stop"))).toEqual([
					`docker stop ${OLD}`,
				]);
				expect(containersOf(world, "web")).toHaveLength(1);
			},
		);

		it("a mount elsewhere than /tmp does not stop the drain", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				drainableWeb({ mounts: ["/data", "/var/lib/app"], tmpfs: ["/run"] }),
			);
			const result = runRoll(world, OPTIONS);
			expect(result.rc).toBe(0);
			expect(calls(world).some((line) => line.startsWith("docker cp"))).toBe(
				true,
			);
			expect(result.stdout).not.toContain(FALLBACK_LINE);
		});

		it("a new replica that goes unhealthy after the marker: the marker is emptied, the old container keeps serving, the new replica is removed", {
			timeout: 90_000,
		}, () => {
			// The old container reports unhealthy at once, so the unhealthy wait
			// ends and the re-check before the stop is what catches the new replica.
			const world = createWorld(
				drainableWeb({}, { flags: ["flip_new_on_cp"] }),
			);
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).not.toBe(0);
			// The promotion was undone: a deploy that failed here may be restored.
			expect(result.promoted).toBe("0");
			expect(result.stdout).toContain(
				"putting the old container back in rotation",
			);
			expect(result.stdout).toContain(
				"the new replica was running unhealthy after the old container was taken out of rotation",
			);
			// An empty file over the marker: the healthcheck passes again.
			expect(drainFile(world, "content")).toBe("");
			expect(log.filter((line) => line.startsWith("docker cp"))).toHaveLength(
				2,
			);
			// The old container was never stopped and is the only one left.
			expect(log.some((line) => line.startsWith("docker stop"))).toBe(false);
			expect(containersOf(world, "web")).toEqual([OLD]);
			expect(runningOf(world, "web")).toEqual([OLD]);
		});

		it("the new replica is removed only after the old container is healthy again", {
			timeout: 90_000,
		}, () => {
			// The old container needs three polls to recover from the empty marker.
			const world = createWorld(
				drainableWeb({ recoverMode: "delay:3" }, { flags: ["flip_new_on_cp"] }),
			);
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).not.toBe(0);
			expect(result.promoted).toBe("0");
			const emptyCopy = log.reduce(
				(last, line, index) => (line.startsWith("docker cp") ? index : last),
				-1,
			);
			const discard = log.findIndex(
				(line, index) =>
					index > emptyCopy && line.startsWith("docker rm -f web-new-"),
			);
			expect(discard).toBeGreaterThan(-1);
			const recovered = log
				.slice(emptyCopy, discard)
				.filter(
					(line) => line.endsWith(` ${OLD}`) && line.includes("State.Status"),
				);
			// unhealthy, unhealthy, unhealthy, then healthy: four polls before the discard.
			expect(recovered.length).toBeGreaterThanOrEqual(4);
			expect(containersOf(world, "web")).toEqual([OLD]);
			expect(runningOf(world, "web")).toEqual([OLD]);
		});

		it("an old container that does not recover keeps the new replica: nothing is removed, the deploy still fails", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				drainableWeb({ recoverMode: "never" }, { flags: ["flip_new_on_cp"] }),
			);
			const started = Date.now();
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).not.toBe(0);
			expect(result.stdout).toContain(
				"the old container did not become healthy again",
			);
			expect(result.stdout).toContain("Nothing was replaced");
			// Nothing is stopped or removed, so whatever still serves stays.
			expect(log.some((line) => /^docker (stop|rm)/.test(line))).toBe(false);
			expect(containersOf(world, "web")).toHaveLength(2);
			expect(runningOf(world, "web")).toHaveLength(2);
			// No automatic restore over two live containers.
			expect(result.promoted).toBe("1");
			// Bounded by interval + timeout + 5 s of its own healthcheck (1 s + 1 s).
			expect(Date.now() - started).toBeLessThan(30_000);
		});

		it("an unmark that fails keeps the new replica and removes nothing", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				drainableWeb({}, { flags: ["flip_new_on_cp", "cp.fail.empty"] }),
			);
			const result = runRoll(world, OPTIONS);
			const log = calls(world);
			expect(result.rc).not.toBe(0);
			expect(result.stdout).toContain(
				"the old container did not become healthy again",
			);
			expect(log.some((line) => /^docker (stop|rm)/.test(line))).toBe(false);
			expect(containersOf(world, "web")).toHaveLength(2);
			expect(result.promoted).toBe("1");
		});

		it.each([
			["the old container recovers", 0],
			["the old container does not recover", 1],
		])(
			"the state during the recovery wait, and after it: %s",
			{
				timeout: 90_000,
			},
			(_label, waitRc) => {
				// A new replica that is unhealthy, and the functions called directly with
				// the recovery wait replaced by a probe of the state variables.
				const world = createWorld(drainableWeb());
				const newId = "web-new-9";
				const base = join(world.state, "containers", newId);
				mkdirSync(base);
				for (const [name, value] of Object.entries({
					service: "web",
					hash: "H2",
					image: "sha256:NEW-web",
					running: "true",
					created: "2026-10-15T10:09:00.000000000Z",
					final_health: "unhealthy",
					polls_left: "0",
				})) {
					writeFileSync(join(base, name), value);
				}
				const { definitions } = getRollingReplaceScript(baseOptions);
				const script = [
					definitions,
					`dokploy_roll_wait_recovered() { echo "DURING active=$DOKPLOY_ROLL_ACTIVE promoting=[$DOKPLOY_ROLL_PROMOTING] promoted=$DOKPLOY_ROLL_PROMOTED"; return ${waitRc}; }`,
					'dokploy_roll_fail() { echo "FAIL active=$DOKPLOY_ROLL_ACTIVE"; }',
					"DR_WAS_PROMOTED=0; DR_MARKED=1; DR_EMPTY=$(mktemp); DOKPLOY_ROLL_SVC=web",
					`DOKPLOY_ROLL_ACTIVE=0; DOKPLOY_ROLL_PROMOTING=${OLD}; DOKPLOY_ROLL_PROMOTED=1`,
					`dokploy_roll_new_still_ok web ${newId} ${OLD}; echo "RC=$? AFTER active=$DOKPLOY_ROLL_ACTIVE promoting=[$DOKPLOY_ROLL_PROMOTING] promoted=$DOKPLOY_ROLL_PROMOTED"`,
				].join("\n");
				const result = boundedSh([writeScript(world, script)], {
					encoding: "utf8",
					env: envFor(world),
					timeout: 60_000,
				});
				// During the wait a cancel would discard the new replica and keep the old one.
				expect(result.stdout).toContain(
					"DURING active=1 promoting=[] promoted=0",
				);
				expect(result.stdout).toContain("RC=1");
				if (waitRc === 0) {
					expect(result.stdout).toContain("FAIL active=1");
					expect(result.stdout).toContain(
						"AFTER active=1 promoting=[] promoted=0",
					);
				} else {
					// Nothing is known to serve: nothing is removed, a cancel removes nothing.
					expect(result.stdout).not.toContain("FAIL");
					expect(result.stdout).toContain(
						"AFTER active=0 promoting=[] promoted=1",
					);
					expect(result.stdout).toContain("Nothing was replaced");
				}
			},
		);

		it("the file that undoes the marker is prepared before the marker is written", () => {
			const { definitions } = getRollingReplaceScript({
				...baseOptions,
				drainSeconds: 1,
			});
			const takeOut = definitions.indexOf("dokploy_roll_take_out() {");
			const empty = definitions.indexOf("DR_EMPTY=$(mktemp", takeOut);
			const firstCopy = definitions.indexOf('docker cp "$DR_TMP"', takeOut);
			expect(empty).toBeGreaterThan(takeOut);
			expect(firstCopy).toBeGreaterThan(empty);
		});

		it("a new replica that goes bad while the old one is still healthy ends the unhealthy wait early", {
			timeout: 90_000,
		}, () => {
			// The old container would take its whole 213 s bound to go unhealthy.
			const world = createWorld(
				drainableWeb(
					{ drainMode: "stays", healthCfg: "0 0 0" },
					{ flags: ["flip_new_on_cp"] },
				),
			);
			const started = Date.now();
			const result = runRoll(world, OPTIONS);
			expect(result.rc).not.toBe(0);
			expect(Date.now() - started).toBeLessThan(20_000);
			expect(result.stdout).not.toContain("did not report unhealthy in time");
			expect(result.stdout).toContain(
				"putting the old container back in rotation",
			);
			expect(drainFile(world, "content")).toBe("");
			expect(calls(world).some((line) => line.startsWith("docker stop"))).toBe(
				false,
			);
			expect(containersOf(world, "web")).toEqual([OLD]);
		});

		it("a promotion by an earlier service stays promoted when a later one is undone", {
			timeout: 90_000,
		}, () => {
			// A rolled `api` first, then `web` whose new replica goes bad.
			const world = createWorld({
				...drainableWeb({}, { flags: ["flip_new_on_cp"] }),
				services: ["api", "web"],
				config: {
					web: { hash: "H2", newImage: "sha256:NEW-web", newHealth: "healthy" },
					api: { hash: "A2", newImage: "sha256:NEW-api" },
				},
				containers: [
					{
						id: OLD,
						service: "web",
						hash: "H1",
						image: "sha256:OLD-web",
						healthTest: DRAIN_TEST,
					},
					{
						id: "aa-api",
						service: "api",
						hash: "A1",
						image: "sha256:OLD-api",
					},
				],
			});
			const result = runRoll(world, { ...OPTIONS, services: ["api", "web"] });
			expect(result.rc).not.toBe(0);
			// api was replaced (no healthcheck config: fallback, promoted), so web's
			// undo must not reset the flag to 0.
			expect(result.promoted).toBe("1");
			expect(containersOf(world, "web")).toEqual([OLD]);
		});

		it("only the old container is given the marker, never the new replica", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(drainableWeb());
			runRoll(world, OPTIONS);
			const copies = calls(world).filter((line) =>
				line.startsWith("docker cp"),
			);
			expect(copies).toHaveLength(1);
			expect(copies[0]).toContain(` ${OLD}:`);
			expect(copies[0]).not.toContain("web-new-");
		});
	});

	describe("leftovers of an interrupted rollout", () => {
		const twoWebs = (
			older: Partial<ContainerSeed>,
			newer: Partial<ContainerSeed>,
			config: ServiceConfig,
		): WorldSeed => ({
			services: ["web"],
			config: { web: config },
			imageIds: { "registry/web:1": "sha256:NEW-web" },
			containers: [
				{
					id: "web-old-1",
					service: "web",
					hash: "H1",
					image: "sha256:OLD-web",
					created: "2026-10-15T08:00:00.000000000Z",
					...older,
				},
				{
					id: "web-old-2",
					service: "web",
					hash: "H1",
					image: "sha256:OLD-web",
					created: "2026-10-15T09:00:00.000000000Z",
					...newer,
				},
			],
		});

		it("keeps the newest healthy container and converges to one, then skips when unchanged", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				twoWebs({}, {}, { hash: "H1", newImage: "sha256:OLD-web" }),
			);
			// The images on the host are the running ones: nothing to roll.
			writeFileSync(
				join(world.state, "cfg", "imageid.registry_web_1"),
				"sha256:OLD-web",
			);
			const result = runRoll(world);
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain("found 2 containers");
			expect(containersOf(world, "web")).toEqual(["web-old-2"]);
		});

		it("a leftover that cannot be removed fails the deploy on every run and no compose up ever runs", {
			timeout: 90_000,
		}, () => {
			// The older container is stopped but stuck (rm fails); the newer one serves.
			// Compose would remove the newer one and start the stuck one again.
			const world = createWorld({
				...twoWebs(
					{ running: false },
					{ health: "healthy" },
					{ hash: "H1", newImage: "sha256:OLD-web" },
				),
				flags: ["rm.fail"],
			});
			for (const attempt of [1, 2]) {
				const result = runRoll(world);
				expect(result.rc, `run ${attempt}`).not.toBe(0);
				expect(result.stdout).toContain(
					"leftover container could not be removed",
				);
				expect(runningOf(world, "web")).toEqual(["web-old-2"]);
			}
			expect(calls(world).filter((line) => / up /.test(line))).toEqual([]);
		});

		it("keeps the older one when the newer is not healthy", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				twoWebs({}, { health: "starting" }, { hash: "H1" }),
			);
			writeFileSync(
				join(world.state, "cfg", "imageid.registry_web_1"),
				"sha256:OLD-web",
			);
			const result = runRoll(world);
			expect(result.rc).toBe(0);
			expect(containersOf(world, "web")).toEqual(["web-old-1"]);
		});

		it("then rolls a changed service from the single survivor", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				twoWebs({}, {}, { hash: "H2", newImage: "sha256:NEW-web" }),
			);
			const result = runRoll(world);
			const log = calls(world);
			expect(result.rc).toBe(0);
			// Exactly one container is left and it is the freshly started one.
			expect(containersOf(world, "web")).toHaveLength(1);
			expect(containersOf(world, "web")[0]).toMatch(/^web-new-/);
			// The leftover was removed before the scale-up, the survivor after it.
			const dropLeftover = indexOfCall(log, "docker rm -f web-old-1");
			const scaleUp = indexOfCall(log, "--scale web=2 web");
			expect(dropLeftover).toBeGreaterThan(-1);
			expect(scaleUp).toBeGreaterThan(dropLeftover);
			expect(
				indexOfCall(log, "docker stop web-old-2", scaleUp),
			).toBeGreaterThan(scaleUp);
		});
	});

	describe("build and pull steps", () => {
		it("builds rolled services with a build section and pulls image-only ones before anything is touched", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(changedWeb());
			const result = runRoll(world, {
				services: ["web", "api"],
				buildServices: ["web"],
				pullServices: ["api"],
				pullAlways: true,
			});
			const log = calls(world);
			expect(result.rc).toBe(0);
			const build = indexOfCall(
				log,
				"docker compose -p my-app -f docker-compose.yml build --pull web",
			);
			const pull = indexOfCall(
				log,
				"docker compose -p my-app -f docker-compose.yml pull api",
			);
			const scaleUp = indexOfCall(log, "--scale web=2 web");
			expect(build).toBeGreaterThan(-1);
			expect(pull).toBeGreaterThan(-1);
			expect(scaleUp).toBeGreaterThan(build);
			expect(scaleUp).toBeGreaterThan(pull);
		});

		it("a build-server deploy never builds or pulls on the serving host", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(changedWeb());
			const result = runRoll(world, { remoteBuild: true });
			const log = calls(world);
			expect(result.rc).toBe(0);
			expect(log.some((line) => / (build|pull)( |$)/.test(line))).toBe(false);
			expect(
				log.some((line) => line.includes("up -d --no-deps --no-build api")),
			).toBe(true);
		});
	});

	describe("cancel / kill mid-rollout", () => {
		// The launcher's kill script sends TERM; a hand-made Ctrl-C sends INT, a
		// closed terminal HUP.
		it.each(["TERM", "INT", "HUP"])(
			"%s removes the replica that was not promoted and leaves the old container serving",
			{
				timeout: 90_000,
			},
			async (signal) => {
				const world = createWorld(
					changedWeb({
						config: {
							web: {
								hash: "H2",
								newImage: "sha256:NEW-web",
								newHealth: "never",
							},
							api: { hash: "A1" },
						},
					}),
				);
				// A watcher in the same shell sends the TERM, once the second replica
				// exists. Bounded: it gives up after 40 s instead of hanging the run.
				const calls = toShellPath(join(world.state, "calls.log"));
				const before = `(
  i=0
  while [ "$i" -lt 160 ] && ! grep -q -- '--scale web=2 web' ${calls} 2>/dev/null; do sleep 0.25; i=$((i + 1)); done
  kill -${signal} $$
) >/dev/null 2>&1 &`;
				const child = boundedShSpawn(
					[
						writeScript(
							world,
							scriptFor({ healthTimeoutSeconds: 60 }, { before }),
						),
					],
					{
						env: envFor(world),
						stdio: ["ignore", "pipe", "pipe"],
						seconds: 90,
					},
				);
				let stdout = "";
				child.stdout?.on("data", (chunk) => {
					stdout += String(chunk);
				});
				const exit = await new Promise<number | null>((resolve) => {
					const timer = setTimeout(() => {
						child.kill();
						resolve(null);
					}, 80_000);
					child.on("close", (code) => {
						clearTimeout(timer);
						resolve(code);
					});
				});
				expect(exit).toBe(130);
				expect(stdout).toContain("the deployment was interrupted");
				expect(stdout).toContain("that was not promoted");
				expect(containersOf(world, "web")).toEqual([OLD]);
				expect(runningOf(world, "web")).toEqual([OLD]);
				// The replica serves nothing: removed at once, not stopped with a grace period.
				const callLog = readFileSync(join(world.state, "calls.log"), "utf8");
				expect(callLog).not.toMatch(/docker stop web-new/);
				expect(callLog).toMatch(/docker rm -f web-new/);
				// The shell ended in the trap: no restore, no RC line.
				expect(stdout).not.toContain("RC=");
			},
		);
	});

	// The path every rolling compose takes, with or without a build server: the
	// script is launched in its own session with a pid file on the serving host,
	// and the cancel runs the kill script there. SIGTERM reaches the whole group,
	// so the trap can run.
	describe.skipIf(!hasSetsid)("cancel through the release launcher", () => {
		it("the kill script reaches the rolling script, its trap removes the unpromoted replica", {
			timeout: 90_000,
		}, async () => {
			const world = createWorld(
				changedWeb({
					config: {
						web: {
							hash: "H2",
							newImage: "sha256:NEW-web",
							newHealth: "never",
						},
						api: { hash: "A1" },
					},
				}),
			);
			const pidFile = join(world.dir, "release.pid");
			const target = {
				pidFile: toShellPath(pidFile),
				deploymentId: getReleaseCancelKey("dep-1"),
			};
			const logFile = join(world.dir, "deploy.log");
			const script = writeScript(
				world,
				scriptFor({ healthTimeoutSeconds: 60 }),
			);
			// The shape runStep gives the deploy script: a subshell, output to the log.
			const command = `(sh ${script}) >> ${toShellPath(logFile)} 2>&1`;
			const child = boundedShSpawn(
				["-c", wrapCancelableRemoteBuild(command, target)],
				{
					env: envFor(world),
					stdio: "ignore",
					seconds: 90,
					leftovers: "kill",
				},
			);
			const exited = new Promise<void>((resolve) => child.on("close", resolve));

			// Wait (bounded) until the second replica exists and the pid file is there.
			const callsLog = join(world.state, "calls.log");
			for (let i = 0; i < 160; i++) {
				if (
					existsSync(pidFile) &&
					existsSync(callsLog) &&
					readFileSync(callsLog, "utf8").includes("--scale web=2 web") &&
					containersOf(world, "web").length === 2
				) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			expect(existsSync(pidFile)).toBe(true);
			expect(runningOf(world, "web")).toContain(OLD);
			expect(containersOf(world, "web").length).toBe(2);

			const kill = boundedSh(["-c", getKillRemoteBuildCommand(target, 20)], {
				encoding: "utf8",
				timeout: 60_000,
			});
			expect(kill.stdout.trim()).toBe("KILLED");
			await exited;

			// The old container keeps serving, the replica is gone, and the trap said so.
			expect(containersOf(world, "web")).toEqual([OLD]);
			expect(runningOf(world, "web")).toEqual([OLD]);
			const log = readFileSync(logFile, "utf8");
			expect(log).toContain("the deployment was interrupted");
			expect(log).toContain("that was not promoted");
			expect(log).not.toContain("RC=");
			expect(readFileSync(callsLog, "utf8")).toMatch(/docker rm -f web-new/);
			expect(existsSync(pidFile)).toBe(false);
		});
	});

	describe.skipIf(!hasSetsid)(
		"a cancel and the steps around the rollout",
		() => {
			const startWrapped = (
				world: World,
				scriptBody: string,
				drainSeconds?: number,
			) => {
				const pidFile = join(world.dir, "release.pid");
				const target = {
					pidFile: toShellPath(pidFile),
					deploymentId: getReleaseCancelKey("dep-x"),
					drainSeconds,
				};
				const script = writeScript(world, scriptBody);
				const child = boundedShSpawn(
					[
						writeScript(
							world,
							wrapCancelableRemoteBuild(`sh ${script}`, target),
						),
					],
					{
						env: envFor(world),
						stdio: "ignore",
						seconds: 90,
						leftovers: "kill",
					},
				);
				const exited = new Promise<void>((resolve) =>
					child.on("close", resolve),
				);
				const termGroup = () => {
					const pgid = readFileSync(pidFile, "utf8").split(" ")[0];
					boundedSh([writeScript(world, `kill -s TERM -- -${pgid}`)], {
						encoding: "utf8",
						timeout: 30_000,
					});
				};
				return { pidFile, exited, termGroup };
			};
			const waitFor = async (check: () => boolean) => {
				for (let i = 0; i < 160 && !check(); i++) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				return check();
			};

			it("the release wrapper returns only after the trap has finished", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(changedWeb());
				const done = join(world.dir, "trap.done");
				const started = join(world.dir, "started");
				const { pidFile, exited, termGroup } = startWrapped(
					world,
					`trap 'sleep 2; touch ${toShellPath(done)}; exit 130' TERM\ntouch ${toShellPath(started)}\nsleep 30 & wait $!\n`,
					10,
				);
				expect(
					await waitFor(() => existsSync(pidFile) && existsSync(started)),
				).toBe(true);

				termGroup();
				await exited;

				// Had the wrapper returned when the first process died, this would not
				// exist yet: the trap sleeps 2 s first.
				expect(existsSync(done)).toBe(true);
				expect(existsSync(pidFile)).toBe(false);
			});

			it("a cancel during the up of the services that are not rolled lets it finish, then stops", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(changedWeb());
				const state = toShellPath(world.state);
				// Only what this flow needs: the services, and a slow `up` for api.
				writeFileSync(
					join(world.bin, "docker"),
					`#!/bin/sh\necho "$*" >> ${state}/calls.log\ncase "$*" in\n*"config --services"*) printf 'web\napi\n';;\n*"up -d --no-deps"*api*) sleep 3; touch ${state}/up.done;;\nesac\nexit 0\n`,
					{ mode: 0o755 },
				);
				const callsLog = join(world.state, "calls.log");
				const { pidFile, exited, termGroup } = startWrapped(
					world,
					scriptFor({ healthTimeoutSeconds: 60 }),
					10,
				);
				expect(
					await waitFor(
						() =>
							existsSync(pidFile) &&
							existsSync(callsLog) &&
							readFileSync(callsLog, "utf8").includes("up -d --no-deps"),
					),
				).toBe(true);

				termGroup();
				await exited;

				// The recreate of the service that is not rolled was not cut short...
				expect(existsSync(join(world.state, "up.done"))).toBe(true);
				// ...and nothing after it ran: the trap took over once it returned.
				const log = readFileSync(callsLog, "utf8");
				expect(log).not.toMatch(/^ps /m);
				expect(log).not.toContain("no-build web");
				expect(log).not.toContain("--remove-orphans");
			});
		},
	);

	describe.skipIf(!hasSetsid)(
		"a cancel in the other windows of the rollout",
		() => {
			const launch = (
				world: World,
				scriptBody: string,
				drainSeconds?: number,
			) => {
				const pidFile = join(world.dir, "release.pid");
				const target = {
					pidFile: toShellPath(pidFile),
					deploymentId: getReleaseCancelKey("dep-y"),
					drainSeconds,
				};
				const script = writeScript(world, scriptBody);
				const child = boundedShSpawn(
					[
						writeScript(
							world,
							wrapCancelableRemoteBuild(`sh ${script}`, target),
						),
					],
					{
						env: envFor(world),
						stdio: "ignore",
						seconds: 90,
						leftovers: "kill",
					},
				);
				const exited = new Promise<number | null>((resolve) =>
					child.on("close", resolve),
				);
				const signalGroup = (signal: string) => {
					const pgid = readFileSync(pidFile, "utf8").split(" ")[0];
					boundedSh([writeScript(world, `kill -s ${signal} -- -${pgid}`)], {
						encoding: "utf8",
						timeout: 30_000,
					});
				};
				return { pidFile, target, exited, signalGroup };
			};
			const waitUntil = async (check: () => boolean) => {
				for (let i = 0; i < 160 && !check(); i++) {
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				return check();
			};
			const callsOf = (world: World) => {
				const path = join(world.state, "calls.log");
				return existsSync(path) ? readFileSync(path, "utf8") : "";
			};

			it("during the drain the unpromoted replica is removed and the old container keeps serving", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(changedWeb());
				const { pidFile, exited, signalGroup } = launch(
					world,
					scriptFor({ drainSeconds: 30, healthTimeoutSeconds: 60 }),
					10,
				);
				// Two replicas, the new one judged healthy: the script is in its drain sleep.
				expect(
					await waitUntil(
						() =>
							existsSync(pidFile) &&
							containersOf(world, "web").length === 2 &&
							callsOf(world).includes("State.Health"),
					),
				).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 1500));

				signalGroup("TERM");
				await exited;

				expect(containersOf(world, "web")).toEqual([OLD]);
				expect(runningOf(world, "web")).toEqual([OLD]);
				expect(callsOf(world)).not.toMatch(/docker stop zz-old-web/);
			});

			it("during the drain of an old container that was taken out of rotation, the old one is removed and the new replica survives", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(drainableWeb());
				const { pidFile, exited, signalGroup } = launch(
					world,
					scriptFor({
						drainSeconds: 30,
						routeSettleSeconds: 1,
						healthTimeoutSeconds: 60,
					}),
					10,
				);
				// The marker is in and the old container reports unhealthy: the script
				// is in its Traefik settle or its drain sleep.
				expect(
					await waitUntil(
						() =>
							existsSync(pidFile) &&
							containersOf(world, "web").length === 2 &&
							callsOf(world).includes("docker cp"),
					),
				).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 2500));

				signalGroup("TERM");
				await exited;

				// The draining old container must never be the survivor.
				const left = containersOf(world, "web");
				expect(left).toHaveLength(1);
				expect(left[0]).toMatch(/^web-new-/);
				expect(runningOf(world, "web")).toEqual(left);
				expect(callsOf(world)).toMatch(/docker stop zz-old-web/);
			});

			it("a cancel while the old container is being put back in rotation keeps the old one and removes the new one", {
				timeout: 90_000,
			}, async () => {
				// The new replica goes bad after the marker; the old container stays
				// unhealthy for 30 polls after the undo copy: the script is waiting.
				const world = createWorld(
					drainableWeb(
						{ recoverMode: "delay:30" },
						{ flags: ["flip_new_on_cp"] },
					),
				);
				const { pidFile, exited, signalGroup } = launch(
					world,
					scriptFor({ routeSettleSeconds: 1, healthTimeoutSeconds: 60 }),
					10,
				);
				expect(
					await waitUntil(
						() =>
							existsSync(pidFile) &&
							(callsOf(world).match(/docker cp/g) ?? []).length >= 2,
					),
				).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 1500));

				signalGroup("TERM");
				await exited;

				// The container being restored survives; the bad replica is gone.
				expect(containersOf(world, "web")).toEqual([OLD]);
				expect(runningOf(world, "web")).toEqual([OLD]);
				expect(callsOf(world)).not.toMatch(/docker stop zz-old-web/);
			});

			it("a cancel right after the marker is written still keeps the new replica", {
				timeout: 90_000,
			}, async () => {
				// The old container takes 12 polls to report unhealthy: the cancel lands
				// in the wait for unhealthy, with the marker already in place.
				const world = createWorld(drainableWeb({ drainMode: "delay:12" }));
				const { pidFile, exited, signalGroup } = launch(
					world,
					scriptFor({ routeSettleSeconds: 1, healthTimeoutSeconds: 60 }),
					10,
				);
				expect(
					await waitUntil(
						() => existsSync(pidFile) && callsOf(world).includes("docker cp"),
					),
				).toBe(true);
				await new Promise((resolve) => setTimeout(resolve, 1500));

				signalGroup("TERM");
				await exited;

				const left = containersOf(world, "web");
				expect(left).toHaveLength(1);
				expect(left[0]).toMatch(/^web-new-/);
			});

			it("in the promote window the old container is removed and the healthy new replica keeps serving", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(changedWeb({ flags: ["stop.slow"] }));
				const { pidFile, exited, signalGroup } = launch(
					world,
					scriptFor({ healthTimeoutSeconds: 60 }),
					10,
				);
				// The old container's stop is in flight (it takes 3 s).
				expect(
					await waitUntil(
						() =>
							existsSync(pidFile) &&
							callsOf(world).includes("docker stop zz-old-web"),
					),
				).toBe(true);

				signalGroup("TERM");
				await exited;

				// Not both gone: the replica was already judged healthy and is the one left.
				const left = containersOf(world, "web");
				expect(left).toHaveLength(1);
				expect(left[0]).toMatch(/^web-new-/);
				expect(runningOf(world, "web")).toEqual(left);
			});

			it("a script that ignores TERM is killed after the grace and the group is gone", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(changedWeb());
				const started = join(world.dir, "started");
				const { pidFile, target, exited } = launch(
					world,
					`trap '' TERM\ntouch ${toShellPath(started)}\nsleep 60\n`,
					10,
				);
				expect(
					await waitUntil(() => existsSync(pidFile) && existsSync(started)),
				).toBe(true);

				const kill = boundedSh(
					[writeScript(world, getKillRemoteBuildCommand(target, 2))],
					{ encoding: "utf8", timeout: 60_000 },
				);

				expect(kill.stdout.trim()).toBe("KILLED");
				// 137 when $SHELL execs the command; 143 under a plain sh (no $SHELL, as
				// in the Dokploy container), which dies of the TERM itself.
				expect([137, 143]).toContain(await exited);
				expect(existsSync(pidFile)).toBe(false);
			});

			it("the kill script reports a hard kill when asked, and not when TERM was enough", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(changedWeb());
				const started = join(world.dir, "started2");
				const stubborn = launch(
					world,
					`trap '' TERM\ntouch ${toShellPath(started)}\nsleep 60\n`,
					10,
				);
				expect(
					await waitUntil(
						() => existsSync(stubborn.pidFile) && existsSync(started),
					),
				).toBe(true);
				const hard = boundedSh(
					[
						writeScript(
							world,
							getKillRemoteBuildCommand(stubborn.target, 2, {
								reportHardKill: true,
							}),
						),
					],
					{ encoding: "utf8", timeout: 60_000 },
				);
				expect(hard.stdout.trim()).toBe("KILLED_HARD");
				await stubborn.exited;

				const polite = launch(world, "sleep 60\n", 10);
				expect(await waitUntil(() => existsSync(polite.pidFile))).toBe(true);
				const soft = boundedSh(
					[
						writeScript(
							world,
							getKillRemoteBuildCommand(polite.target, 5, {
								reportHardKill: true,
							}),
						),
					],
					{ encoding: "utf8", timeout: 60_000 },
				);
				expect(soft.stdout.trim()).toBe("KILLED");
				await polite.exited;
			});

			it("helpers left in the group do not hold the wrapper or the kill script once the cleanup is done", {
				timeout: 90_000,
			}, async () => {
				const world = createWorld(
					changedWeb({
						config: {
							web: {
								hash: "H2",
								newImage: "sha256:NEW-web",
								newHealth: "never",
							},
							api: { hash: "A1" },
						},
					}),
				);
				// A helper that outlives the cancel, like the docker events capture.
				const before = "( trap '' TERM; sleep 40 ) >/dev/null 2>&1 &";
				const { pidFile, target, exited } = launch(
					world,
					scriptFor({ healthTimeoutSeconds: 60 }, { before }),
					25,
				);
				expect(
					await waitUntil(
						() =>
							existsSync(pidFile) && callsOf(world).includes("State.Health"),
					),
				).toBe(true);
				const pgid = readFileSync(pidFile, "utf8").split(" ")[0];

				const startedAt = Date.now();
				const kill = boundedSh(
					[
						writeScript(
							world,
							getKillRemoteBuildCommand(target, 20, { reportHardKill: true }),
						),
					],
					{ encoding: "utf8", timeout: 60_000 },
				);
				await exited;
				const elapsed = Date.now() - startedAt;

				// Not the 20 s grace, not the 25 s drain: the marker ended both.
				expect(kill.stdout.trim()).toBe("KILLED");
				expect(elapsed).toBeLessThan(15_000);
				expect(containersOf(world, "web")).toEqual([OLD]);
				expect(existsSync(`${pidFile}.done`)).toBe(false);
				boundedSh(
					[writeScript(world, `kill -s KILL -- -${pgid} 2>/dev/null; true`)],
					{ encoding: "utf8", timeout: 30_000 },
				);
			});
		},
	);

	describe("hostile names", () => {
		it("a service name or app name with shell syntax is data, not code", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(changedWeb());
			const marker = toShellPath(join(world.dir, "PWNED"));
			const result = runRoll(world, {
				appName: `my-app';touch ${marker};'`,
				services: [`web;touch ${marker}`, "web"],
			});
			// The hostile service does not exist, so it is not rolled; the other
			// still is, and nothing in the names ran.
			expect(existsSync(join(world.dir, "PWNED"))).toBe(false);
			expect(result.rc).toBe(0);
		});
	});
});

describe.skipIf(!hasSh)(
	"rolling replace of a service with several replicas",
	() => {
		const OLD_A = "zz-old-web-1";
		const OLD_B = "zz-old-web-2";
		const N2: Partial<RollingScriptOptions> = {
			replicas: { web: 2 },
			drainSeconds: 0,
			routeSettleSeconds: 1,
		};

		/** `web` runs two old containers that honour the marker; deploy.replicas is 2. */
		const twoOldWeb = (extra: Partial<WorldSeed> = {}): WorldSeed =>
			changedWeb({
				...extra,
				containers: [
					{
						id: OLD_A,
						service: "web",
						hash: "H1",
						image: "sha256:OLD-web",
						healthTest: DRAIN_TEST,
					},
					{
						id: OLD_B,
						service: "web",
						hash: "H1",
						image: "sha256:OLD-web",
						healthTest: DRAIN_TEST,
					},
					{ id: "aa-api", service: "api", hash: "A1", image: "sha256:NEW-api" },
				],
			});

		const withReplicas = (world: World, count: number) => {
			writeFileSync(join(world.state, "cfg", "replicas.web"), String(count));
			return world;
		};

		const copiedTo = (world: World, id: string) => {
			const path = join(world.state, `cp.${id}.content`);
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		};

		/** Containers of the release the compose already describes (nothing to roll). */
		const sameRelease = (containers: ContainerSeed[]): WorldSeed => ({
			services: ["web"],
			config: { web: { hash: "H1", newImage: "sha256:OLD-web" } },
			imageIds: { "registry/web:1": "sha256:OLD-web" },
			containers,
		});

		const seed = (
			id: string,
			minute: number,
			health = "healthy",
		): ContainerSeed => ({
			id,
			service: "web",
			hash: "H1",
			image: "sha256:OLD-web",
			health,
			created: `2026-10-15T09:0${minute}:00.000000000Z`,
		});

		it("starts two new replicas next to the two old ones, waits for both, takes both old ones out and removes them", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(createWorld(twoOldWeb()), 2);
			const result = runRoll(world, N2);
			const log = calls(world);

			expect(result.rc).toBe(0);
			expect(result.promoted).toBe("1");
			expect(violations(world)).toBe("");

			// Four containers during the overlap: two old plus two new.
			const scaleUp = indexOfCall(log, "--scale web=4 web");
			expect(scaleUp).toBeGreaterThan(-1);
			expect(result.stdout).toContain("starting 2 new replicas");
			expect(result.stdout).toContain(
				"waiting up to 20s for the 2 new replicas to be healthy",
			);

			// Both new replicas are judged before either old one is marked.
			const newIds = containersOf(world, "web");
			expect(newIds).toHaveLength(2);
			expect(newIds.every((id) => id.startsWith("web-new-"))).toBe(true);
			const firstCopy = indexOfCall(log, "docker cp", scaleUp);
			expect(firstCopy).toBeGreaterThan(scaleUp);
			for (const id of newIds) {
				const judged = log.findIndex(
					(line, index) =>
						index > scaleUp &&
						line.includes("State.Health.Status") &&
						line.endsWith(` ${id}`),
				);
				expect(judged).toBeGreaterThan(scaleUp);
				expect(judged).toBeLessThan(firstCopy);
			}

			// Both old ones got the marker, and only then were they stopped.
			expect(copiedTo(world, OLD_A)).toBe("drain\n");
			expect(copiedTo(world, OLD_B)).toBe("drain\n");
			const lastCopy = log.reduce(
				(at, line, index) => (line.startsWith("docker cp") ? index : at),
				-1,
			);
			const stop = indexOfCall(log, "docker stop");
			expect(stop).toBeGreaterThan(lastCopy);
			expect(log[stop]).toContain(OLD_A);
			expect(log[stop]).toContain(OLD_B);
			// One settle for both.
			expect(
				result.stdout.split("waiting 1s for Traefik to drop it").length - 1,
			).toBe(1);

			// The final up keeps the two new replicas.
			expect(
				indexOfCall(
					log,
					"up -d --no-recreate --no-build --remove-orphans web api",
				),
			).toBeGreaterThan(stop);
			expect(runningOf(world, "web").sort()).toEqual([...newIds].sort());
		});

		it("one new replica unhealthy: every new replica is removed, both old ones are untouched", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(createWorld(twoOldWeb()), 2);
			writeFileSync(join(world.state, "cfg", "newhealth.web.2"), "unhealthy");
			const result = runRoll(world, N2);
			const log = calls(world);

			expect(result.rc).not.toBe(0);
			expect(result.promoted).toBe("0");
			expect(result.stdout).toContain("Rolling replace of web failed");
			expect(result.stdout).toContain("reported unhealthy");
			expect(containersOf(world, "web").sort()).toEqual([OLD_A, OLD_B]);
			expect(runningOf(world, "web").sort()).toEqual([OLD_A, OLD_B]);
			// Never marked, never stopped.
			expect(log.some((line) => line.startsWith("docker cp"))).toBe(false);
			expect(log.some((line) => line.startsWith("docker stop"))).toBe(false);
			expect(copiedTo(world, OLD_A)).toBeUndefined();
		});

		it("a new replica that never gets healthy runs into the one shared deadline: all new removed", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(createWorld(twoOldWeb()), 2);
			writeFileSync(join(world.state, "cfg", "newhealth.web.1"), "never");
			const started = Date.now();
			const result = runRoll(world, { ...N2, healthTimeoutSeconds: 3 });
			expect(result.rc).not.toBe(0);
			expect(result.stdout).toContain("was not healthy within 3s");
			expect(containersOf(world, "web").sort()).toEqual([OLD_A, OLD_B]);
			expect(Date.now() - started).toBeLessThan(30_000);
		});

		it("a new replica that goes bad after the marker: both old ones are put back in rotation, all new removed", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(
				createWorld(twoOldWeb({ flags: ["flip_new_on_cp"] })),
				2,
			);
			const result = runRoll(world, N2);
			const log = calls(world);

			expect(result.rc).not.toBe(0);
			expect(result.stdout).toContain(
				"putting the old container back in rotation",
			);
			// The marker was emptied in both old containers.
			expect(copiedTo(world, OLD_A)).toBe("");
			expect(copiedTo(world, OLD_B)).toBe("");
			expect(log.some((line) => line.startsWith("docker stop"))).toBe(false);
			expect(containersOf(world, "web").sort()).toEqual([OLD_A, OLD_B]);
			expect(runningOf(world, "web").sort()).toEqual([OLD_A, OLD_B]);
		});

		it("replicas raised from 1 to 2: two new replicas next to the one old container", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(createWorld(drainableWeb()), 2);
			const result = runRoll(world, N2);
			const log = calls(world);
			expect(result.rc).toBe(0);
			expect(indexOfCall(log, "--scale web=3 web")).toBeGreaterThan(-1);
			const left = containersOf(world, "web");
			expect(left).toHaveLength(2);
			expect(left.every((id) => id.startsWith("web-new-"))).toBe(true);
		});

		it("reconcile with 3 containers and N=2 keeps the newest two and removes the oldest", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(
				createWorld(
					sameRelease([
						seed("c-oldest", 0),
						seed("c-middle", 1),
						seed("c-newest", 2),
					]),
				),
				2,
			);
			const result = runRoll(world, N2);
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain("found 3 containers for 2 replicas");
			expect(result.stdout).toContain(
				"unchanged (config hash and image id match)",
			);
			expect(containersOf(world, "web").sort()).toEqual([
				"c-middle",
				"c-newest",
			]);
			expect(calls(world)).toContain("docker stop c-oldest");
		});

		it("reconcile with N=2 keeps a healthy container over a newer unhealthy one", {
			timeout: 90_000,
		}, () => {
			const world = withReplicas(
				createWorld(
					sameRelease([
						seed("c-oldest", 0),
						seed("c-middle", 1),
						seed("c-newest", 2, "unhealthy"),
					]),
				),
				2,
			);
			const result = runRoll(world, N2);
			expect(result.rc).toBe(0);
			expect(containersOf(world, "web").sort()).toEqual([
				"c-middle",
				"c-oldest",
			]);
		});

		it("with N=1 two containers are still reduced to one, as before", {
			timeout: 90_000,
		}, () => {
			const world = createWorld(
				sameRelease([seed("c-oldest", 0), seed("c-newest", 2)]),
			);
			const result = runRoll(world, { drainSeconds: 0 });
			expect(result.rc).toBe(0);
			expect(result.stdout).toContain(
				"found 2 containers (an interrupted rollout?), keeping the newest healthy one",
			);
			expect(containersOf(world, "web")).toEqual(["c-newest"]);
		});
	},
);
