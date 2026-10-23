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

const { paths } = await import("@dokploy/server/constants");
const {
	assertComposeVolumesBound,
	commandUsesEnvFile,
	getCommandBaseDirectories,
	getCommandRunVolumes,
} = await import("@dokploy/server/services/compose-volume-binding");
const {
	dockerVolumesDirectoryReach,
	reachesDockerVolumesDirectory,
	resolveEnvironmentReferences,
	resolveComposeMountedVolumes,
	soleDefaultReach,
	unresolvedSourceClimbs,
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
			["/var/lib/docker/volumes${X}", true],
			["/var/lib/docker/${X}", true],
			["/var/lib/docker/other/${X}", false],
			["/var/lib/dockerx/${X}", false],
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

// Review round of PR #470.
const CODE_DIRECTORY = `${paths(false)
	.COMPOSE_PATH.replace(/\\/g, "/")
	.replace(/^[A-Za-z]:/, "")}/${APP}/code`;
const DEPLOYED = `${CODE_DIRECTORY}/docker-compose.yml`;
const NOTHING = "services:\n  web:\n    image: nginx\n";

describe("--project-directory moves the base of relative binds", () => {
	const withDirectory = (flag: string, source: string) =>
		composeRow(bind(source), {
			command: `compose --project-directory ${flag} -f ${DEPLOYED} up -d`,
		});
	const parentMessage = /contains Docker's own volume storage/;

	it.each([
		["/", "./"],
		["/", "."],
		["/var", "./lib"],
		["/var/lib", "./docker"],
		["/var/lib/docker", "."],
		["/var/lib/docker", "./"],
		["/etc", "../var/lib"],
		["../../../../../../../../../../../..", "."],
	])(
		"--project-directory %s with %s binds a parent",
		async (directory, source) => {
			await expect(
				assertComposeVolumesBound(withDirectory(directory, source)),
			).rejects.toThrow(parentMessage);
		},
	);

	it("reads --project-directory=/ too", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("./"), {
					command: `compose --project-directory=/ -f ${DEPLOYED} up -d`,
				}),
			),
		).rejects.toThrow(parentMessage);
	});

	it("reads a directory climbed to from the project directory", async () => {
		await expect(
			assertComposeVolumesBound(
				withDirectory("/var/lib/docker", "./volumes/x"),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
	});

	it("sees the directory of every file the command names", async () => {
		mocks.readFileSync.mockReturnValue(NOTHING);

		await expect(
			assertComposeVolumesBound(
				composeRow(bind("./docker"), {
					command: `compose -f /var/lib/x.yml -f ${DEPLOYED} up -d`,
				}),
			),
		).rejects.toThrow(parentMessage);
	});

	it("still allows a project directory that is not a parent", async () => {
		await expect(
			assertComposeVolumesBound(withDirectory("/srv/app", "./data")),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(withDirectory("..", ".")),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("./data"), {
					command: `compose -f ${DEPLOYED} up -d`,
				}),
			),
		).resolves.toBeUndefined();
	});

	it("lists the directories of a command", () => {
		const compose = (command: string) => composeRow("", { command }) as never;

		expect(getCommandBaseDirectories(compose(""))).toEqual([]);
		expect(
			getCommandBaseDirectories(
				compose(`compose --project-directory /var -f ${DEPLOYED} up -d`),
			),
		).toEqual(["/var", CODE_DIRECTORY]);
		expect(
			getCommandBaseDirectories(compose("compose -f ../shared/a.yml up -d")),
		).toEqual([CODE_DIRECTORY.replace(/\/code$/, "/shared")]);
	});

	it("does not trust the compose's variables when the command brings its own --env-file", async () => {
		const row = (command: string) =>
			composeRow(bind("${DATA}"), {
				env: "DATA=/var/lib/docker/volumes/x",
				command,
			});

		await expect(
			assertComposeVolumesBound(row(`compose -f ${DEPLOYED} up -d`)),
		).rejects.toThrow(/is Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				row(`compose --env-file other.env -f ${DEPLOYED} up -d`),
			),
		).resolves.toBeUndefined();
		expect(commandUsesEnvFile({ command: "compose --env-file a up -d" })).toBe(
			true,
		);
		expect(commandUsesEnvFile({ command: "compose --env-file=a up -d" })).toBe(
			true,
		);
		expect(commandUsesEnvFile({ command: "compose -f a up -d" })).toBe(false);
		expect(commandUsesEnvFile({ command: "" })).toBe(false);
	});
});

describe("run -v hidden by a glob, an operator or a backtick", () => {
	it("refuses a glob in front of the -v", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(NOTHING, {
					command: `compose -f ${DEPLOYED} run -e A=* -v /:/h web`,
				}),
			),
		).rejects.toThrow(/Compose command refused: .*shell pattern/);
	});

	it.each([
		"compose -f d.yml run -e A=* web",
		"compose -f d.yml run -e 'A=*' -v /:/h web && docker compose -f d.yml ps *",
		"compose -f d.yml ps * && docker compose -f d.yml run -v /:/h web",
		"compose -f d.yml run -v ?:/h web",
		"compose -f d.yml run web | cat",
		"compose -f d.yml run web; docker compose -f d.yml ps",
		"compose -f d.yml run -v /:/h web # comment",
	])("refuses %s", (command) => {
		expect(() => getCommandRunVolumes({ command } as never)).toThrow(
			/Compose command refused/,
		);
	});

	it("leaves a glob alone when nothing in the line is a run", () => {
		expect(
			getCommandRunVolumes({ command: "compose -f d.yml logs *" } as never),
		).toEqual([]);
		expect(
			getCommandRunVolumes({
				command: "compose -f d.yml up -d && docker compose -f d.yml ps",
			} as never),
		).toEqual([]);
	});

	it("quoted pattern characters are plain text", () => {
		expect(
			getCommandRunVolumes({
				command: "compose -f d.yml run -e 'A=*' -v /a:/b web",
			} as never),
		).toEqual(["/a:/b"]);
	});

	it.each([
		"/[v]ar/lib/docker:/h",
		"'/v*r/lib/docker:/h'",
		"'/va?/lib:/h'",
		"'{/var,/etc}:/h'",
	])("refuses a pattern character in a -v value: %s", async (volume) => {
		await expect(
			assertComposeVolumesBound(
				composeRow(NOTHING, {
					command: `compose -f ${DEPLOYED} run -v ${volume} web`,
				}),
			),
		).rejects.toThrow(/Compose volume check failed: command volume/);
	});

	it("refuses a backtick in a -v value", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(NOTHING, {
					command: `compose -f ${DEPLOYED} run -v "/\`true\`:/h" web`,
				}),
			),
		).rejects.toThrow(/Compose volume check failed: command volume/);
	});
});

describe("a variable followed by .. that cannot be resolved", () => {
	it.each([
		["${HOME}/../../../..", {}],
		["${HOME}/..", {}],
		["${PATH}/../x", {}],
		["${HOME}/data/../../..", {}],
		["/srv/${HOME}/../..", {}],
		["${HOME}/${NOPE:?err}/..", {}],
	])("refuses %s with the env file on", async (source, extra) => {
		await expect(
			assertComposeVolumesBound(composeRow(bind(source), extra)),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it.each([
		"${PWD}/../../../../..",
		"${DATA_DIR}/../..",
		"$PWD/../..",
		"./${X}/../..",
	])("refuses %s with the env file off", async (source) => {
		await expect(
			assertComposeVolumesBound(
				composeRow(bind(source), { createEnvFile: false }),
			),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it("refuses it for a stack, where PWD is the shell's", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("${PWD}/../../../../.."), { composeType: "stack" }),
			),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it("refuses it in the long syntax", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(longBind('"${PWD}/../.."'), { createEnvFile: false }),
			),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it("still resolves a variable that is known, and normalises the result", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("${BASE}/../../.."), { env: "BASE=/var/lib/docker" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(bind("${BASE}/../app"), { env: "BASE=/srv/data" }),
			),
		).resolves.toBeUndefined();
	});

	it("leaves a source that is only a variable, or a variable and a path", async () => {
		for (const source of ["${DATA_DIR}", "${DATA_DIR}/x", "${HOME}/data"]) {
			await expect(
				assertComposeVolumesBound(
					composeRow(bind(source), { createEnvFile: false }),
				),
			).resolves.toBeUndefined();
		}
		await expect(
			assertComposeVolumesBound(composeRow(bind("${HOME}/data"))),
		).resolves.toBeUndefined();
	});

	it("refuses Docker's own directory followed by a variable with the env file off", async () => {
		for (const source of [
			"/var/lib/docker/${X}",
			"/var/lib/docker/${X}/_data",
			"/var/lib/docker//${X}",
			"/var/./lib/docker/${X}",
		]) {
			await expect(
				assertComposeVolumesBound(
					composeRow(bind(source), { createEnvFile: false }),
				),
			).rejects.toThrow(/is Docker's own volume storage/);
		}
	});

	it.each([
		["${HOME}/..", true],
		["${PWD}/../../x", true],
		["/srv/${X}/..", true],
		["${X}..", true],
		["${X}/..x", false],
		["${X}/a..b", false],
		["${X}/data", false],
		["../${X}", true],
		["${X}/../x", true],
		["${X}", false],
	])("unresolvedSourceClimbs(%s) is %s", (raw, expected) => {
		expect(unresolvedSourceClimbs(raw)).toBe(expected);
	});
});

describe("the whole entry is interpolated before it is split", () => {
	const entry = (value: string) => `
services:
  web:
    volumes:
      - "${value}"
`;

	it("refuses a colon that comes from a default", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(entry("${X:-/:/h}"))),
		).rejects.toThrow(
			/Compose volume refused: bind mount .* contains Docker's/,
		);
	});

	it("refuses an entry that is only a variable holding SOURCE:TARGET", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${VOL}"), { env: "VOL=/:/h" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${VOL}"), {
					env: "VOL=/var/lib/docker/volumes/x:/h",
				}),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
	});

	it("refuses a source variable followed by a mode", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${A}:ro"), { env: "A=/:/x" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});

	it("refuses a source brought by two variables", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${A}${B}:/h"), { env: "A=/va\nB=r" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${A}${B}"), { env: "A=/var\nB=/lib:/h" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});

	it("fails closed on an entry that is only variables when they are not known", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${VOL}"), { createEnvFile: false }),
			),
		).rejects.toThrow(/Compose volume check failed: volume "\${VOL}"/);
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${X:-/:/h}"), { createEnvFile: false }),
			),
		).rejects.toThrow(/Compose volume check failed/);
		await expect(
			assertComposeVolumesBound(composeRow(entry("${HOME}"))),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it("keeps ${DATA_DIR}:/data and a variable target allowed", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${DATA_DIR}:/data"), { createEnvFile: false }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${A}:ro"), { createEnvFile: false }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("/srv/data:${TARGET}"), { createEnvFile: false }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("./data:${TARGET}"), { createEnvFile: false }),
			),
		).resolves.toBeUndefined();
	});

	it("still refuses a path source when only the target is unresolved", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("/:${TARGET}"), { createEnvFile: false }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});

	it("keeps an anonymous volume and a plain entry allowed", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(entry("/data"))),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(composeRow(entry("${DIR:-/data}"))),
		).resolves.toBeUndefined();
	});
});

describe("process links that collapse away", () => {
	it.each([
		"/proc/self/root/..",
		"/proc/self/cwd/..",
		"/proc/self/root/../..",
		"/proc/1/root/../x",
		"/tmp/../proc/self/root/..",
		"/proc/self/task/12/root/..",
		"/proc/./self/./root/./..",
	])("%s is refused", (path) => {
		expect(dockerVolumesDirectoryReach(path)).toBe("parent");
	});

	it("is refused as a bind of the compose", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(bind("/proc/self/root/.."))),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});

	it.each(["/proc/self", "/proc/self/status", "/proc/1/rootx/.."])(
		"%s is not",
		(path) => {
			expect(dockerVolumesDirectoryReach(path)).toBeNull();
		},
	);
});

// Round 2 of the review of PR #470.
describe("a path option that is not literal", () => {
	const projectDirectory = (value: string) =>
		composeRow(bind("."), {
			command: `compose --project-directory ${value} -f ${DEPLOYED} up -d`,
		});
	const refused = /Compose command refused: the --project-directory/;

	it.each([
		"$HOME/../..",
		"${HOME}/../..",
		'"`echo /`"',
		"/e*",
		"$X",
		"${X}",
		"/va?",
		"/[v]ar",
		"/{var,etc}",
		'"$(echo /)"',
	])("refuses --project-directory %s", async (value) => {
		await expect(
			assertComposeVolumesBound(projectDirectory(value)),
		).rejects.toThrow(refused);
	});

	it.each(["$X", "/e*", "$HOME/../..", '"`echo /`"'])(
		"refuses --project-directory=%s",
		async (value) => {
			await expect(
				assertComposeVolumesBound(
					composeRow(bind("."), {
						command: `compose --project-directory=${value} -f ${DEPLOYED} up -d`,
					}),
				),
			).rejects.toThrow(refused);
		},
	);

	it.each([
		["-f $X", /compose file "\$X"/],
		["-f *.yml", /compose file "\*\.yml"/],
		["--file=$X", /compose file "\$X"/],
		["--file ${X}/a.yml", /compose file/],
		["-f/etc/*.yml", /compose file/],
		["--env-file $X", /--env-file "\$X"/],
		["--env-file=*.env", /--env-file "\*\.env"/],
		["--env-file '[a].env'", /--env-file/],
	])("refuses %s", async (option, message) => {
		await expect(
			assertComposeVolumesBound(
				composeRow(NOTHING, {
					command: `compose ${option} -f ${DEPLOYED} up -d`,
				}),
			),
		).rejects.toThrow(message);
	});

	it("refuses it in a chained command and for a stack", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(NOTHING, {
					command: `compose -f ${DEPLOYED} up -d && docker compose --project-directory $X -f ${DEPLOYED} ps`,
				}),
			),
		).rejects.toThrow(refused);
		await expect(
			assertComposeVolumesBound(
				composeRow(NOTHING, {
					composeType: "stack",
					command: "stack deploy -c /srv/*.yml app",
				}),
			),
		).rejects.toThrow(/Compose command refused: the compose file/);
	});

	it("still allows literal paths, quoted or not", async () => {
		for (const value of [
			"/srv/app",
			'"/srv/app"',
			"'/srv/my app'",
			"..",
			"./sub",
		]) {
			await expect(
				assertComposeVolumesBound(
					composeRow(bind("./data"), {
						command: `compose --project-directory ${value} -f ${DEPLOYED} up -d`,
					}),
				),
			).resolves.toBeUndefined();
		}
	});
});

describe("a source with a variable and a ..", () => {
	const off = { createEnvFile: false };
	const entry = (value: string) => `
services:
  web:
    volumes:
      - "${value}"
`;
	// Enough `..` to reach `/` from the compose directory wherever the tests run.
	const CLIMB = Array(CODE_DIRECTORY.split("/").length + 1)
		.fill("..")
		.join("/");
	const climbs = /Compose volume check failed/;
	const refused = /Compose volume (check failed|refused)/;
	const parent = /contains Docker's own volume storage/;

	it.each([
		"${HOME}/${U:-..}/${U:-..}/${U:-..}/${U:-..}/${U:-..}:/h",
		"${A}${U:-/../../../../..}:/h",
		"${X:-${HOME}/../..}:/h",
		"${X:-$HOME/../..}:/h",
		"${X:-/srv}/../../..:/h",
		"${HOME}/../..:/h",
		"/srv/${X:-..}/..:/h",
	])("refuses %s with the env file on", async (source) => {
		await expect(
			assertComposeVolumesBound(composeRow(entry(source))),
		).rejects.toThrow(refused);
	});

	it.each([
		"${A}/${U:-..}/${U:-..}/${U:-..}/${U:-..}/${U:-..}:/h",
		"${A}${U:-/../../../../..}:/h",
		"${X:-${HOME}/../..}:/h",
		"${X:-$HOME/../..}:/h",
		"${X:-/srv}/../../..:/h",
		"${X:-${Y:-..}}:/h",
		"/srv/${X:-..}/..:/h",
	])("refuses %s with the env file off", async (source) => {
		await expect(
			assertComposeVolumesBound(composeRow(entry(source), off)),
		).rejects.toThrow(climbs);
	});

	it("refuses the long-syntax bind of the same sources", async () => {
		for (const source of [
			"${A}/${U:-..}/${U:-..}/${U:-..}/${U:-..}/${U:-..}",
			"${A}${U:-/../../../../..}",
			"${X:-${HOME}/../..}",
			"${X:-/srv}/../../..",
		]) {
			await expect(
				assertComposeVolumesBound(composeRow(longBind(`"${source}"`), off)),
			).rejects.toThrow(climbs);
		}
	});

	it("allows a lone variable with a literal default that is not a parent", async () => {
		for (const source of [
			"${DATA_DIR:-../data}:/data",
			"${DATA_DIR-../data}:/data",
			"${DATA_DIR:-./data}:/data:ro",
			"${X:-/srv}:/h",
			"${DATA_DIR:-/srv/data}:/data",
			"${DATA_DIR:-data}:/data",
			"${DATA_DIR:-../../data}:/data",
		]) {
			await expect(
				assertComposeVolumesBound(composeRow(entry(source), off)),
			).resolves.toBeUndefined();
			await expect(
				assertComposeVolumesBound(composeRow(entry(source))),
			).resolves.toBeUndefined();
		}
	});

	it("allows a source with a variable and no ..", async () => {
		for (const source of [
			"${HOME}/data:/d",
			"${DATA_DIR}:/data",
			"${DATA_DIR}/x:/data",
			"./${X}/data:/d",
		]) {
			await expect(
				assertComposeVolumesBound(composeRow(entry(source), off)),
			).resolves.toBeUndefined();
		}
		await expect(
			assertComposeVolumesBound(composeRow(entry("${HOME}/data:/d"))),
		).resolves.toBeUndefined();
	});

	it("judges the lone default as a path, so one that reaches a parent is refused", async () => {
		for (const source of [
			`\${X:-${CLIMB}}:/h`,
			`\${X-${CLIMB}}:/h`,
			"${X:-/}:/h",
			"${X:-/var/lib}:/h",
			"${X:-/var/lib/docker}:/h",
		]) {
			await expect(
				assertComposeVolumesBound(composeRow(entry(source), off)),
			).rejects.toThrow(parent);
		}
	});

	it("refuses a lone default inside the storage", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${X:-/var/lib/docker/volumes/v}:/h"), off),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
	});

	it("is not an exception when the default holds a variable or braces", async () => {
		for (const source of [
			"${X:-${Y:-../data}}:/h",
			"${X:-$Y/../data}:/h",
			"${X:-../data}${Y}:/h",
			"${Y}${X:-../data}:/h",
		]) {
			await expect(
				assertComposeVolumesBound(composeRow(entry(source), off)),
			).rejects.toThrow(climbs);
		}
	});

	it.each([
		["${DATA_DIR:-../data}", true],
		["${X:-${Y:-..}}", true],
		["${X:-..}/..", true],
		["${X}/..", true],
		["${X}..", true],
		["${X}${U:-/..}", true],
		["${X}/..x", false],
		["${X}/a..b", false],
		["${X}/data", false],
		["${X}", false],
	])("unresolvedSourceClimbs(%s) is %s", (raw, expected) => {
		expect(unresolvedSourceClimbs(raw)).toBe(expected);
	});

	it("judges only a lone literal default", () => {
		const base = ["/etc/dokploy/compose/app/code"];

		expect(soleDefaultReach("${X:-../data}", base)).toBeNull();
		expect(soleDefaultReach("${X-../data}", base)).toBeNull();
		expect(soleDefaultReach("${X:-../../../../..}", base)).toBe("parent");
		expect(soleDefaultReach("${X:-../../../../../..}", base)).toBe("parent");
		expect(soleDefaultReach("${X:-/}", base)).toBe("parent");
		expect(soleDefaultReach("${X:-data}", base)).toBeNull();
		expect(soleDefaultReach("${X:-}", base)).toBeNull();
		expect(soleDefaultReach("${X:-/var/lib/docker/volumes/v}", base)).toBe(
			"inside",
		);
		expect(soleDefaultReach("${X}", base)).toBeUndefined();
		expect(soleDefaultReach("${X:?err}", base)).toBeUndefined();
		expect(soleDefaultReach("${X:+../..}", base)).toBeUndefined();
		expect(soleDefaultReach("/srv/${X:-..}", base)).toBeUndefined();
		expect(soleDefaultReach("${X:-..}/a", base)).toBeUndefined();
		expect(soleDefaultReach("${X:-${Y}}", base)).toBeUndefined();
		expect(soleDefaultReach("${X:-$Y}", base)).toBeUndefined();
	});
});

// Round 4 of the review of PR #470: a .. that a known variable brings next to
// an unknown one.
describe("a .. brought by a variable next to an unknown one", () => {
	const entry = (value: string) => `
services:
  web:
    volumes:
      - "${value}:/h"
`;
	const failed = /Compose volume check failed/;

	it.each([
		["B=..", "${HOME}/${B}/${B}/${B}/${B}/${B}"],
		["B=..", "${PATH}/${B}/${B}/${B}/${B}/${B}"],
		["UP=../../../../..", "${HOME}/${UP}"],
		["E=", "${HOME}/.${E}./.${E}./.${E}./.${E}./.${E}."],
		["B=..", "${HOME}/${B}"],
		["UP=../..", "${PATH}/x/${UP}"],
		["B=..", "$HOME/$B/$B"],
		["", "${HOME}/.${U}./.${U}./.${U}./.${U}./.${U}."],
		["", "${HOME}/.${U:-}./.${U:-}."],
		["", "${HOME}/${U:-..}"],
		["UP=..", "${HOME}/${UP:-x}/${UP}"],
	])("refuses %s with %s (env file on)", async (env, source) => {
		await expect(
			assertComposeVolumesBound(composeRow(entry(source), { env })),
		).rejects.toThrow(failed);
	});

	it.each(["${A}/.${U}./.${U}./.${U}.", "${A}/.${U}.", "${A}/.${U:-}."])(
		"refuses %s when no variable is known (env file off)",
		async (source) => {
			await expect(
				assertComposeVolumesBound(
					composeRow(entry(source), { createEnvFile: false }),
				),
			).rejects.toThrow(failed);
		},
	);

	it("refuses the same in the long syntax", async () => {
		for (const [env, source] of [
			["B=..", "${HOME}/${B}/${B}/${B}/${B}/${B}"],
			["B=..", "${PATH}/${B}/${B}/${B}/${B}/${B}"],
			["UP=../../../../..", "${HOME}/${UP}"],
			["E=", "${HOME}/.${E}./.${E}./.${E}./.${E}./.${E}."],
		] as const) {
			await expect(
				assertComposeVolumesBound(composeRow(longBind(`"${source}"`), { env })),
			).rejects.toThrow(failed);
		}
	});

	it("refuses it stack too, where PWD and HOME are the shell's", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${HOME}/${B}/${B}"), {
					composeType: "stack",
					env: "B=..",
				}),
			),
		).rejects.toThrow(failed);
	});

	it.each([
		["", "${HOME}/.cache"],
		["", "${HOME}/data"],
		["", "${HOME}/.config/app"],
		["", "${HOME}/.${U}x"],
		["", "${HOME}/a.${U}b"],
		["DATA_DIR=/srv", "${DATA_DIR}/x"],
		["APP=app", "/srv/${APP}/data"],
		["APP=app", "${HOME}/${APP}/data"],
		["B=beta", "${HOME}/${B}/data"],
		["", "${DATA_DIR:-../data}"],
		["", "${DATA_DIR:-./data}"],
	])("still allows %s with %s", async (env, source) => {
		await expect(
			assertComposeVolumesBound(composeRow(entry(source), { env })),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(entry(source), { env, createEnvFile: false }),
			),
		).resolves.toBeUndefined();
	});
});

// Round 5 of the review of PR #470: a known value that refers to variables.
describe("values of the environment that refer to variables", () => {
	const entry = (value: string) => `
services:
  web:
    volumes:
      - "${value}:/h"
`;
	const refused = /Compose volume (check failed|refused)/;
	const failed = /Compose volume check failed/;

	it.each([
		["B=/\nV=${B}", "${V}"],
		["B=/\nV=$B", "${V}"],
		["D=docker\nV=/var/lib/${D}", "${V}"],
		["V=/var/lib/${D}\nD=docker", "${V}"],
		["V=${B:-/}", "${V}"],
		["B=..\nV=${B}/${B}/${B}/${B}/${B}", "${HOME}/${V}"],
		["B=..\nV=${HOME}/${B}/${B}/${B}/${B}/${B}", "${V}"],
		["B=/\nV=${B}${B}\nW=${V}", "${W}"],
		["B=/\nV=${B:-x}", "${V}"],
		["B=..\nV=${B}/${B}", "${PATH}/${V}/${V}/${V}"],
	])("refuses the short syntax: %j with %s", async (env, source) => {
		await expect(
			assertComposeVolumesBound(composeRow(entry(source), { env })),
		).rejects.toThrow(refused);
	});

	it.each([
		["B=/\nV=${B}", "${V}"],
		["B=/\nV=$B", "${V}"],
		["D=docker\nV=/var/lib/${D}", "${V}"],
		["V=/var/lib/${D}\nD=docker", "${V}"],
		["V=${B:-/}", "${V}"],
		["B=..\nV=${B}/${B}/${B}/${B}/${B}", "${HOME}/${V}"],
	])("refuses the long syntax: %j with %s", async (env, source) => {
		await expect(
			assertComposeVolumesBound(composeRow(longBind(`"${source}"`), { env })),
		).rejects.toThrow(refused);
	});

	it("refuses it for a stack too", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${V}"), {
					composeType: "stack",
					env: "B=/\nV=${B}",
				}),
			),
		).rejects.toThrow(refused);
	});

	it("follows the value to the path it is", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${V}"), {
					env: "B=/\nV=${B}var/lib/docker/volumes",
				}),
			),
		).rejects.toThrow(/is Docker's own volume storage/);
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${V}"), { env: "B=/var\nV=${B}/lib" }),
			),
		).rejects.toThrow(/contains Docker's own volume storage/);
	});

	it("refuses a cycle, and a self reference, without hanging", async () => {
		for (const [env, source] of [
			["A=${B}\nB=${A}", "${A}"],
			["A=${B}\nB=${A}", "${B}"],
			["A=${A}", "${A}"],
			["A=x${A}", "${A}"],
			["A=${B}\nB=${C}\nC=${A}", "${C}"],
			["V=${NOPE:?missing}", "${V}"],
		] as const) {
			await expect(
				assertComposeVolumesBound(composeRow(entry(source), { env })),
			).rejects.toThrow(failed);
		}
	});

	it("refuses a variable that refers to one it cannot follow, in a default too", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${V:-../data}"), { env: "V=${LATER}\nLATER=/" }),
			),
		).rejects.toThrow(failed);
	});

	it("keeps $$ a literal $", async () => {
		// V is the text $B, not the value of B.
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${V}"), { env: "B=/\nV=$$B" }),
			),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(entry("${V}"), { env: "B=/\nV=a$$b" }),
			),
		).resolves.toBeUndefined();
		expect(
			resolveEnvironmentReferences({ B: "/", V: "$$B", W: "a$$" }),
		).toEqual({ B: "/", V: "$B", W: "a$" });
	});

	it("still allows a value that resolves to a harmless path", async () => {
		for (const [env, source] of [
			["B=/srv\nV=${B}/data", "${V}"],
			["B=/srv\nV=$B/data", "${V}"],
			["V=${ABSENT}/x", "${V}"],
			["V=${ABSENT:-/srv}", "${V}"],
			["B=./data\nV=${B}", "${V}"],
			["V=${HOME}/x", "${V}"],
			["V=${HOME}/.cache", "${V}"],
			["B=beta\nV=${HOME}/${B}", "${V}"],
		] as const) {
			await expect(
				assertComposeVolumesBound(composeRow(entry(source), { env })),
			).resolves.toBeUndefined();
		}
		await expect(
			assertComposeVolumesBound(composeRow(entry("${DATA_DIR}"))),
		).resolves.toBeUndefined();
	});

	it("resolves the map in file order", () => {
		const resolve = resolveEnvironmentReferences;
		const UNKNOWN = "\u0001";
		const UNRESOLVED = "\u0002";

		expect(resolve({ B: "/srv", V: "${B}/data" })).toEqual({
			B: "/srv",
			V: "/srv/data",
		});
		expect(resolve({ V: "${B}/data", B: "/srv" })).toEqual({
			V: UNRESOLVED,
			B: "/srv",
		});
		expect(resolve({ A: "${B}", B: "${A}" })).toEqual({
			A: UNRESOLVED,
			B: UNRESOLVED,
		});
		expect(resolve({ A: "${A}" })).toEqual({ A: UNRESOLVED });
		expect(resolve({ B: "x", V: "${B:-y}${C:-z}${B:+q}" })).toEqual({
			B: "x",
			V: "xzq",
		});
		expect(resolve({ B: "", V: "${B:-y}${B-z}${B:+q}${B+r}" })).toEqual({
			B: "",
			V: "yr",
		});
		expect(resolve({ V: "${HOME}/x" }, ["HOME"])).toEqual({
			V: `${UNKNOWN}/x`,
		});
		expect(resolve({ V: "${C:?e}" })).toEqual({ V: UNRESOLVED });
		expect(resolve({ V: "plain" })).toEqual({ V: "plain" });
	});
});
