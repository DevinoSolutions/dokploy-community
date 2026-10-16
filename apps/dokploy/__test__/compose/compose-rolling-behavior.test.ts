import { spawn, spawnSync } from "node:child_process";
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
	type RollingScriptOptions,
} from "@dokploy/server/utils/builders/compose-rolling";
import {
	getKillRemoteBuildCommand,
	getReleaseCancelKey,
	wrapCancelableRemoteBuild,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import { afterAll, describe, expect, it } from "vitest";

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
		const result = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
		return result.status === 0 && result.stdout.trim() === "ok";
	} catch {
		return false;
	}
})();

// The cancel launcher needs setsid and /proc (see remote-build-cancel.ts).
const hasSetsid =
	process.platform !== "win32" &&
	spawnSync("sh", ["-c", "command -v setsid && [ -d /proc/self ]"]).status ===
		0;

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

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
	const result = spawnSync(
		"sh",
		[writeScript(world, scriptFor(options, extra))],
		{ encoding: "utf8", env: envFor(world), timeout: 90_000 },
	);
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
				const child = spawn(
					"sh",
					[
						writeScript(
							world,
							scriptFor({ healthTimeoutSeconds: 60 }, { before }),
						),
					],
					{ env: envFor(world), stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdout = "";
				child.stdout.on("data", (chunk) => {
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
			const child = spawn(
				"sh",
				["-c", wrapCancelableRemoteBuild(command, target)],
				{
					env: envFor(world),
					stdio: "ignore",
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

			const kill = spawnSync(
				"sh",
				["-c", getKillRemoteBuildCommand(target, 20)],
				{
					encoding: "utf8",
					timeout: 60_000,
				},
			);
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
				const child = spawn(
					"sh",
					[
						writeScript(
							world,
							wrapCancelableRemoteBuild(`sh ${script}`, target),
						),
					],
					{ env: envFor(world), stdio: "ignore" },
				);
				const exited = new Promise<void>((resolve) =>
					child.on("close", resolve),
				);
				const termGroup = () => {
					const pgid = readFileSync(pidFile, "utf8").split(" ")[0];
					spawnSync("sh", [writeScript(world, `kill -s TERM -- -${pgid}`)]);
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
				const child = spawn(
					"sh",
					[
						writeScript(
							world,
							wrapCancelableRemoteBuild(`sh ${script}`, target),
						),
					],
					{ env: envFor(world), stdio: "ignore" },
				);
				const exited = new Promise<number | null>((resolve) =>
					child.on("close", resolve),
				);
				const signalGroup = (signal: string) => {
					const pgid = readFileSync(pidFile, "utf8").split(" ")[0];
					spawnSync("sh", [
						writeScript(world, `kill -s ${signal} -- -${pgid}`),
					]);
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

				const kill = spawnSync(
					"sh",
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
				const hard = spawnSync(
					"sh",
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
				const soft = spawnSync(
					"sh",
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
				const kill = spawnSync(
					"sh",
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
				spawnSync("sh", [
					writeScript(world, `kill -s KILL -- -${pgid} 2>/dev/null; true`),
				]);
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
