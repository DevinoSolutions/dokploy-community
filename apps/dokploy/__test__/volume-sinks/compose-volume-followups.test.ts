import { beforeEach, describe, expect, it, vi } from "vitest";

// T-6919: follow-ups of the compose volume check (T-6822): binds of the
// parents of Docker's volume storage, `docker compose run -v` in a custom
// command, variable bind sources, and the volume backup record.
const mocks = vi.hoisted(() => {
	const table = () => ({ findFirst: vi.fn(), findMany: vi.fn() });
	return {
		query: {
			applications: table(),
			compose: table(),
			libsql: table(),
			mariadb: table(),
			mongo: table(),
			mysql: table(),
			postgres: table(),
			redis: table(),
			mounts: table(),
			volumeBackups: table(),
			patch: table(),
			deployments: table(),
			network: table(),
		},
		warn: vi.fn(),
		readFileSync: vi.fn(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks.query },
}));

vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: async <T>(value: T) => value,
}));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	readFileSync: mocks.readFileSync,
}));

const { assertComposeVolumesBound, getCommandRunVolumes } = await import(
	"@dokploy/server/services/compose-volume-binding"
);
const {
	dockerVolumesDirectoryReach,
	reachesDockerVolumesDirectory,
	resolveComposeMountedVolumes,
	unresolvedSourceReachesDockerVolumes,
} = await import("@dokploy/server/utils/volume-backups/compose-volumes");
const { parse } = await import("yaml");

const APP = "compose-x-AbC123";

const orgOf = (organizationId: string) => ({
	environment: { project: { organizationId } },
});

const composeRow = (
	composeFile: string,
	overrides: Record<string, unknown> = {},
) =>
	({
		composeId: "compose-1",
		appName: APP,
		sourceType: "raw",
		composeType: "docker-compose",
		composePath: "./docker-compose.yml",
		composeFile,
		command: "",
		createEnvFile: true,
		env: "",
		randomize: false,
		suffix: "",
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		serverId: null,
		domains: [],
		serviceNetworks: [],
		environment: { env: "", project: { env: "" } },
		...overrides,
	}) as never;

const bind = (source: string) => `
services:
  web:
    volumes:
      - "${source}:/data"
`;

const longBind = (source: string) => `
services:
  web:
    volumes:
      - type: bind
        source: ${source}
        target: /data
`;

const mountOf = (volumeName: string, organizationId: string) => ({
	mountId: "mount-b",
	mariadbId: "m-b",
	volumeName,
	mariadb: { appName: "m-b", serverId: null, ...orgOf(organizationId) },
});

beforeEach(() => {
	vi.clearAllMocks();
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
	mocks.query.compose.findFirst.mockResolvedValue({
		appName: APP,
		serverId: null,
		composeFile: "",
		...orgOf("org-a"),
	});
});

describe("directories that contain Docker's volume storage", () => {
	it.each([
		"/",
		"//",
		"/.",
		"/..",
		"/var",
		"/var/",
		"/var//",
		"/var/lib",
		"/var/lib/",
		"/var/lib/docker",
		"/var/lib/docker/",
		"/var/lib/docker//",
		"//var//lib//docker",
		"/var/./lib/./docker/.",
		"/var/lib/../lib/docker",
		"/var/lib/docker/other/..",
		"/var/lib/docker/volumes/..",
		"/var/lib/docker/volumes/../..",
		"/var/lib/docker/volumes/../../../../..",
		"/etc/../var",
		"/../../var/lib",
		"\\var\\lib\\docker",
	])("%s is a parent", (path) => {
		expect(dockerVolumesDirectoryReach(path)).toBe("parent");
		expect(reachesDockerVolumesDirectory(path)).toBe(true);
	});

	it.each([
		"/proc/self/root",
		"/proc/1/root",
		"/proc/1/root/",
		"/proc/1/root/etc",
		"/proc/1/cwd",
		"/proc/self/task/12/root/srv",
	])("%s is a process link to a root, by its shape", (path) => {
		expect(dockerVolumesDirectoryReach(path)).toBe("parent");
	});

	it.each([
		"/var/lib/docker/volumes",
		"/var/lib/docker/volumes/",
		"/var/lib/docker/volumes/victim/_data",
		"//var//lib//docker//volumes//victim",
		"/var/lib/docker/other/../volumes/victim",
	])("%s is inside, not a parent", (path) => {
		expect(dockerVolumesDirectoryReach(path)).toBe("inside");
	});

	it.each([
		"/var/lib/dockerx",
		"/var/lib/docker/containers",
		"/var/lib/docker/volumes-other",
		"/var/log",
		"/varx",
		"/etc",
		"/srv/data",
		"/proc/self/status",
		"/proc/1/rootfs",
		"/proc/1/environ",
		"/home/app/proc/1/root",
	])("%s is not refused", (path) => {
		expect(dockerVolumesDirectoryReach(path)).toBeNull();
	});

	it("resolves relative paths from the compose's directories, never from /", () => {
		const base = ["/etc/dokploy/compose/app/code"];
		// A relative `.` or `..` is not a bind of `/`.
		expect(dockerVolumesDirectoryReach(".")).toBeNull();
		expect(dockerVolumesDirectoryReach("..")).toBeNull();
		expect(dockerVolumesDirectoryReach("./", base)).toBeNull();
		expect(dockerVolumesDirectoryReach("..", base)).toBeNull();
		expect(dockerVolumesDirectoryReach("../../../..", base)).toBeNull();
		expect(dockerVolumesDirectoryReach("./data", base)).toBeNull();
		// ...until the chain really reaches `/` or a parent from the base.
		expect(dockerVolumesDirectoryReach("../../../../..", base)).toBe("parent");
		expect(dockerVolumesDirectoryReach("../../../../../..", base)).toBe(
			"parent",
		);
		expect(
			dockerVolumesDirectoryReach("../../../../../var/lib/docker/./", base),
		).toBe("parent");
		expect(
			dockerVolumesDirectoryReach(
				"../../../../../var/lib/docker/volumes/x",
				base,
			),
		).toBe("inside");
		// From a base that sits at `/var/lib/docker`, `./volumes` is inside.
		expect(dockerVolumesDirectoryReach("./volumes", ["/var/lib/docker"])).toBe(
			"inside",
		);
		expect(dockerVolumesDirectoryReach(".", ["/var/lib/docker"])).toBe(
			"parent",
		);
	});

	it("reads ~ as the home of an unknown user", () => {
		expect(dockerVolumesDirectoryReach("~")).toBeNull();
		expect(dockerVolumesDirectoryReach("~/data")).toBeNull();
		expect(dockerVolumesDirectoryReach("~/..")).toBe("parent");
		expect(dockerVolumesDirectoryReach("~/../..")).toBe("parent");
		expect(dockerVolumesDirectoryReach("~/../../var/lib/docker")).toBe(
			"parent",
		);
		expect(dockerVolumesDirectoryReach("~/../var/lib/docker/volumes/x")).toBe(
			"inside",
		);
	});

	it("does not see a symlink that only exists on the host", () => {
		// `/srv/docker` -> `/var/lib/docker` cannot be told from here, and the
		// check never touches the host: documented, not refused.
		expect(
			dockerVolumesDirectoryReach("/srv/docker/volumes/victim"),
		).toBeNull();
	});
});

describe("binds of those directories at deploy", () => {
	const parentMessage =
		/Compose volume refused: bind mount ".*" contains Docker's own volume storage/;

	it.each([
		"/",
		"/var",
		"/var/",
		"/var/lib",
		"/var/lib/docker",
		"/var/lib/docker/",
	])("refuses the short-syntax bind %s", async (source) => {
		await expect(
			assertComposeVolumesBound(composeRow(bind(source))),
		).rejects.toThrow(parentMessage);
	});

	it.each([
		"//var//lib//docker",
		"/var/lib/docker/volumes/..",
		"/var/./lib",
		"/../..",
	])("refuses the tricked path %s", async (source) => {
		await expect(
			assertComposeVolumesBound(composeRow(bind(source))),
		).rejects.toThrow(parentMessage);
	});

	it.each(["/", "/var/lib", "/var/lib/docker/"])(
		"refuses the long-syntax bind %s",
		async (source) => {
			await expect(
				assertComposeVolumesBound(composeRow(longBind(source))),
			).rejects.toThrow(parentMessage);
		},
	);

	it("refuses a relative path that climbs to a parent from the compose's directory", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("../../../../../../../../../var/lib")),
			),
		).rejects.toThrow(parentMessage);
	});

	it("refuses a local volume whose device is a parent", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    driver_opts:
      type: none
      o: bind
      device: /var/lib/docker
`),
			),
		).rejects.toThrow(
			/Compose volume refused: volume "data" \(device "\/var\/lib\/docker"\) contains Docker's own volume storage/,
		);
	});

	it("keeps the message for a path inside the storage", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("/var/lib/docker/volumes/victim/_data")),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
	});

	it("is refused for every caller: there is no role to widen it", async () => {
		// The check takes the compose row only (no caller, no privilege flag), so
		// an owner or admin is held to it exactly like a member.
		expect(assertComposeVolumesBound.length).toBe(1);
		await expect(
			assertComposeVolumesBound(composeRow(bind("/"))),
		).rejects.toThrow(parentMessage);
	});

	it("logs the refusal with the path", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(bind("/var/lib"))),
		).rejects.toThrow();
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ forbiddenParents: ['bind mount "/var/lib"'] }),
			expect.stringContaining("contains Docker's volume storage"),
		);
	});

	it.each([
		"./data",
		".",
		"..",
		"./",
		"../shared",
		"/srv/data",
		"/var/log",
		"/var/lib/dockerx",
		"/var/lib/docker/containers",
		"/var/run/docker.sock",
		"/etc/dokploy/applications/x",
		"/proc/self/status",
		"~/data",
	])("still allows the bind %s", async (source) => {
		await expect(
			assertComposeVolumesBound(composeRow(bind(source))),
		).resolves.toBeUndefined();
	});

	it("still allows named volumes, tmpfs and anonymous volumes", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
      - /anonymous
      - type: tmpfs
        target: /run
volumes:
  data:
`),
			),
		).resolves.toBeUndefined();
	});

	it("checks the override files of a command the same way", async () => {
		mocks.readFileSync.mockReturnValue(bind("/var"));

		await expect(
			assertComposeVolumesBound(
				composeRow("services:\n  web:\n    image: nginx\n", {
					command: `compose -p ${APP} -f docker-compose.yml -f override.yml up -d`,
				}),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});
});

describe("docker compose run -v in a custom command", () => {
	const yaml = `
services:
  web:
    image: nginx
volumes:
  data:
`;
	const run = (flags: string, extra: Record<string, unknown> = {}) =>
		composeRow(yaml, {
			command: `compose -p ${APP} -f docker-compose.yml run ${flags} web sh`,
			...extra,
		});

	describe("reading the volumes", () => {
		const volumes = (command: string) => getCommandRunVolumes({ command });

		it.each([
			["compose -f d.yml run -v /a:/b web", ["/a:/b"]],
			["compose -f d.yml run -v/a:/b web", ["/a:/b"]],
			["compose -f d.yml run -v=/a:/b web", ["/a:/b"]],
			["compose -f d.yml run --volume /a:/b web", ["/a:/b"]],
			["compose -f d.yml run --volume=/a:/b web", ["/a:/b"]],
			["compose -f d.yml run --rm -Tv /a:/b web", ["/a:/b"]],
			["compose -f d.yml run -v /a:/b -v c:/d web", ["/a:/b", "c:/d"]],
			['compose -f d.yml run -v "/a b:/c" web', ["/a b:/c"]],
			["compose -f d.yml run -v '/a:/b:ro' web", ["/a:/b:ro"]],
			["compose -f d.yml run --name n -e A=1 -v /a:/b web", ["/a:/b"]],
			[
				"compose -f d.yml up -d && docker compose -f d.yml run -v /a:/b web",
				["/a:/b"],
			],
			[
				"docker-compose -f d.yml up -d && docker-compose -f d.yml run -v /a:/b web",
				["/a:/b"],
			],
			["--context x compose -f d.yml run -v /a:/b web", ["/a:/b"]],
		])("%s", (command, expected) => {
			expect(volumes(command)).toEqual(expected);
		});

		it.each([
			"compose -f d.yml up -d",
			"compose -f d.yml run web",
			"compose -f d.yml run -e A=-v web",
			"compose -f d.yml run --name -v web",
			"compose -f d.yml run -d web",
			"compose -f d.yml exec -v /a:/b web",
			"compose -f d.yml logs -v web",
			"run -v /a:/b img",
			"stack deploy -c d.yml x",
			"",
		])("finds none in %s", (command) => {
			expect(volumes(command)).toEqual([]);
		});

		it("is empty without a command", () => {
			expect(getCommandRunVolumes({ command: null } as never)).toEqual([]);
		});
	});

	it("refuses a bind of Docker's volume storage", async () => {
		await expect(
			assertComposeVolumesBound(
				run("-v /var/lib/docker/volumes/victim/_data:/d"),
			),
		).rejects.toThrow(/command bind mount ".*" is Docker's own volume storage/);
	});

	it.each([
		"--volume=/:/host",
		"-v /var/lib/docker:/d:ro",
		"-v ../../../../../../../../../../../..:/d",
	])("refuses a bind of a parent: %s", async (flags) => {
		await expect(assertComposeVolumesBound(run(flags))).rejects.toThrow(
			/command bind mount ".*" contains Docker's own volume storage/,
		);
	});

	it("allows a bind of the compose's own directory", async () => {
		await expect(
			assertComposeVolumesBound(run("-v ./data:/d -v .:/app -v /srv/data:/x")),
		).resolves.toBeUndefined();
	});

	it("refuses a named volume another organization uses", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([mountOf("victim", "org-b")]);

		await expect(
			assertComposeVolumesBound(run("-v victim:/d")),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});

	it("refuses a Dokploy-reserved volume name", async () => {
		await expect(
			assertComposeVolumesBound(run("-v dokploy-postgres:/d")),
		).rejects.toThrow(/Compose volume "dokploy-postgres" is refused/);
	});

	it("allows the compose's own namespace and an unclaimed name", async () => {
		await expect(
			assertComposeVolumesBound(run(`-v ${APP}_extra:/d -v scratch:/s`)),
		).resolves.toBeUndefined();
	});

	it("treats a name the compose declares as its key, not as a literal volume", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([mountOf("data", "org-b")]);

		// `data` is declared by the compose: it is `<appName>_data`, the compose's
		// own, whatever another organization calls a volume `data`.
		await expect(
			assertComposeVolumesBound(run("-v data:/d")),
		).resolves.toBeUndefined();
	});

	it("ignores an anonymous volume", async () => {
		await expect(
			assertComposeVolumesBound(run("-v /anonymous -v anonymous")),
		).resolves.toBeUndefined();
	});

	it("fails closed on a shell variable it cannot know", async () => {
		await expect(assertComposeVolumesBound(run("-v $SRC:/d"))).rejects.toThrow(
			/Compose volume check failed: command volume "\$SRC:\/d"/,
		);
	});

	it("does not read a -v of a compose command that is not run, or an option value", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, {
					command: `compose -p ${APP} -f docker-compose.yml logs -v /:/x web`,
				}),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(run("-e A=-v")),
		).resolves.toBeUndefined();
	});

	it("keeps the current behaviour when the first command is not docker compose", async () => {
		// `docker run -v` (and any other docker command) is not parsed: the check
		// reads docker compose commands only. Documented as a remaining gap.
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, { command: "run -v /:/host alpine sh" }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, {
					command: `run -v /var/lib/docker/volumes:/x alpine && docker compose -p ${APP} -f docker-compose.yml run -v /srv:/y web`,
				}),
			),
		).resolves.toBeUndefined();
	});

	it("a command with no run is unchanged", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, {
					command: `compose -p ${APP} -f docker-compose.yml up -d`,
				}),
			),
		).resolves.toBeUndefined();
	});
});

describe("a bind source that depends on a variable", () => {
	const source = (value: string) => bind(value);

	it("resolves it from the compose's environment, as the deploy does", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA}"), { env: "DATA=/var/lib/docker/volumes" }),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA}/x"), {
					env: "DATA=/var/lib/docker/volumes/victim",
				}),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA}"), { env: "DATA=/" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA:-/var/lib}"), { env: "" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA}"), { env: "DATA=/srv/data" }),
			),
		).resolves.toBeUndefined();
	});

	it("reads the source of a short-syntax volume up to the colon outside ${...}", async () => {
		// `${DATA:-/srv}:/data` was cut at the colon of the default, so its
		// source was never resolved.
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA:-/var/lib/docker/volumes}/victim/_data")),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(composeRow(source("${DATA:-${ROOT:-/}}"))),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(composeRow(source("${DATA:-/srv}/x"))),
		).resolves.toBeUndefined();
		mocks.query.mounts.findMany.mockResolvedValue([mountOf("victim", "org-b")]);
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - "\${V:-victim}:/data"
volumes:
  victim:
    external: true
`),
			),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});

	it("resolves it for the long syntax and a stack too", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(longBind('"${DATA}"'), { env: "DATA=/var/lib/docker" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(source("${DATA}"), {
					composeType: "stack",
					env: "DATA=/var/lib/docker/volumes",
				}),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
	});

	describe("with Create env file off", () => {
		const off = { createEnvFile: false };

		it("does not trust the compose's environment: Docker reads a .env Dokploy cannot see", async () => {
			// DATA is in the compose's env, but Dokploy writes no .env, so it is
			// not what Docker uses: the source is unresolved, not /srv/data.
			await expect(
				assertComposeVolumesBound(
					composeRow(source("/var/lib/docker/volumes/${DATA}"), {
						...off,
						env: "DATA=safe",
					}),
				),
			).rejects.toThrow(/is Docker's own volume storage/);
		});

		it("refuses what is written before the variable when it is inside the storage", async () => {
			for (const value of [
				"/var/lib/docker/volumes/${NAME}/_data",
				"/var/lib/docker/volumes/${NAME}",
				"//var//lib/docker/volumes/${NAME}",
				"/var/lib/docker/other/../volumes/${NAME}",
				"/var/lib/docker/volumes/$NAME",
			]) {
				await expect(
					assertComposeVolumesBound(composeRow(source(value), off)),
				).rejects.toThrow(/is Docker's own volume storage/);
				await expect(
					assertComposeVolumesBound(composeRow(longBind(`"${value}"`), off)),
				).rejects.toThrow(/is Docker's own volume storage/);
			}
		});

		it("leaves a source it cannot tell from a volume name or an ordinary path", async () => {
			// Unresolved service sources are not refused for being unresolved
			// (unlike a volume name or `external`), so these keep deploying; every
			// declared volume is checked instead. Documented gap: a .env that sets
			// DATA_DIR to /var/lib/docker/volumes is not seen.
			for (const value of [
				"${DATA_DIR}",
				"${DATA_DIR}/x",
				"./${DATA_DIR}",
				"/srv/${APP}",
				"/var/lib/${X}",
				"/var/lib/docker/${X}",
				"/var/lib/docker/volumes${SUFFIX}",
				"/var/lib/docker/volumes$${LITERAL}x",
			]) {
				await expect(
					assertComposeVolumesBound(composeRow(source(value), off)),
				).resolves.toBeUndefined();
			}
		});

		it("still checks every declared volume for a variable source", async () => {
			mocks.query.mounts.findMany.mockResolvedValue([
				mountOf("victim", "org-b"),
			]);

			await expect(
				assertComposeVolumesBound(
					composeRow(
						`
services:
  web:
    volumes:
      - "\${SRC}:/data"
volumes:
  data:
    name: victim
`,
						off,
					),
				),
			).rejects.toThrow(/Compose volume "victim" is refused/);
		});

		it("still refuses an unresolved volume name, as before", async () => {
			await expect(
				assertComposeVolumesBound(
					composeRow(
						`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: \${NAME}
`,
						off,
					),
				),
			).rejects.toThrow(/Compose volume check failed/);
		});
	});

	describe("the written prefix", () => {
		const base = ["/etc/dokploy/compose/app/code"];

		it.each([
			["/var/lib/docker/volumes/${X}", true],
			["/var/lib/docker/volumes/x/${X}", true],
			["/var/lib/docker/volumes/", false],
			["/var/lib/docker/volumes${X}", false],
			["/var/lib/docker/${X}", false],
			["/var/lib/${X}", false],
			["${X}", false],
			["${X}/var/lib/docker/volumes", false],
			["/var/lib/docker/volumes/$${X}", false],
			["/var/lib/docker/volumes/$$/${X}", true],
			["../../../../../var/lib/docker/volumes/${X}", true],
			["./${X}", false],
		])("%s -> %s", (raw, expected) => {
			expect(unresolvedSourceReachesDockerVolumes(raw, base)).toBe(expected);
		});
	});

	it("resolveComposeMountedVolumes reports parents apart from paths inside", () => {
		const result = resolveComposeMountedVolumes(
			parse(`
services:
  web:
    volumes:
      - /var/lib:/a
      - /var/lib/docker/volumes/x:/b
      - /srv:/c
`),
			{ appName: APP, env: {} },
		);

		expect(result.forbiddenParents).toEqual(['bind mount "/var/lib"']);
		expect(result.forbidden).toEqual([
			'bind mount "/var/lib/docker/volumes/x"',
		]);
	});
});

describe("a volume recorded on the compose's own volume backup", () => {
	const shared = `
services:
  web:
    volumes:
      - shared:/data
volumes:
  shared:
    external: true
`;
	const sameOrgMount = {
		mountId: "mount-other",
		applicationId: "app-other",
		application: { appName: "other-app", serverId: null, ...orgOf("org-a") },
	};
	const ownVolumeBackup = {
		volumeBackupId: "vb-own",
		composeId: "compose-1",
		compose: { appName: APP, serverId: null, ...orgOf("org-a") },
	};
	const otherServiceVolumeBackup = {
		volumeBackupId: "vb-other",
		applicationId: "app-other",
		application: { appName: "other-app", serverId: null, ...orgOf("org-a") },
	};

	it("refuses a volume another service of the organization claims", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([sameOrgMount]);

		await expect(assertComposeVolumesBound(composeRow(shared))).rejects.toThrow(
			/Compose volume "shared" is refused/,
		);
	});

	it("refuses it when only another service has a volume backup row for it", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			otherServiceVolumeBackup,
		]);

		await expect(assertComposeVolumesBound(composeRow(shared))).rejects.toThrow(
			/Compose volume "shared" is refused/,
		);
	});

	it("accepts it once the compose has its own volume backup row, despite the other claim", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([sameOrgMount]);
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			otherServiceVolumeBackup,
			ownVolumeBackup,
		]);

		await expect(
			assertComposeVolumesBound(composeRow(shared)),
		).resolves.toBeUndefined();
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("does not accept another organization's claim because of it", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([mountOf("shared", "org-b")]);
		mocks.query.volumeBackups.findMany.mockResolvedValue([ownVolumeBackup]);

		await expect(assertComposeVolumesBound(composeRow(shared))).rejects.toThrow(
			/Compose volume "shared" is refused/,
		);
	});

	it("a volume backup row of a different compose is not its own record", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([sameOrgMount]);
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			{
				...ownVolumeBackup,
				composeId: "compose-2",
				compose: { appName: "compose-y", serverId: null, ...orgOf("org-a") },
			},
		]);

		await expect(assertComposeVolumesBound(composeRow(shared))).rejects.toThrow(
			/Compose volume "shared" is refused/,
		);
	});
});
