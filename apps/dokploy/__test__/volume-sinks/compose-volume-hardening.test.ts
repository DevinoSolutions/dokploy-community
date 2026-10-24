import { beforeEach, describe, expect, it, vi } from "vitest";

// Review round for T-6822: variable forms Docker reads differently from a
// naive check, Docker's own volume directory, other composes' declared names,
// and the custom command.
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
		readDotenv: vi.fn(),
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

// The `.env` of the project directory (T-7160). Not there unless a test says so.
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	open: async (path: string) => {
		const { dotenvHandle } = await import("./dotenv-fs-mock");
		const result = await mocks.readDotenv(path);
		return typeof result === "string" ? dotenvHandle(result) : result;
	},
}));

const fsError = (code: string) => Object.assign(new Error(code), { code });

const { paths } = await import("@dokploy/server/constants");
const { assertComposeVolumesBound } = await import(
	"@dokploy/server/services/compose-volume-binding"
);
const { resolveComposeMountedVolumes, reachesDockerVolumesDirectory } =
	await import("@dokploy/server/utils/volume-backups/compose-volumes");
const { parse } = await import("yaml");
const { assertComposeFileVolumesBound } = await import(
	"@dokploy/server/services/compose-volume-binding"
);
const { findRefusedVolumeMounts, loadVolumeBindingFacts } = await import(
	"@dokploy/server/services/volume-binding"
);
const { evaluateVolumeBinding } = await import(
	"@dokploy/server/utils/volume-backups/binding"
);

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

// The bound values of a drizzle where clause.
const sqlParams = (node: unknown): unknown[] => {
	const found: unknown[] = [];
	const visit = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
		if (chunks) {
			for (const chunk of chunks) visit(chunk);
			return;
		}
		if (
			(value as { constructor?: { name?: string } }).constructor?.name ===
			"Param"
		) {
			found.push((value as { value: unknown }).value);
		}
	};
	visit(node);
	return found;
};

const claimEverything = () =>
	mocks.query.mounts.findMany.mockResolvedValue([
		{
			mountId: "mount-b",
			mariadbId: "m-b",
			mariadb: { appName: "m-b", serverId: null, ...orgOf("org-b") },
		},
	]);

const withVolume = (definition: string) => `
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
${definition}
`;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.readDotenv.mockRejectedValue(fsError("ENOENT"));
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

describe("external written as a string or a variable", () => {
	const resolveNames = (yaml: string, env: Record<string, string> = {}) =>
		resolveComposeMountedVolumes(parse(yaml), {
			appName: APP,
			env,
		}).uses.map((use) => use.volumeName);

	const definition = (external: string) =>
		withVolume(`    name: victim\n    external: ${external}`);

	it("reads external: ${E} and the string forms of true", () => {
		expect(resolveNames(definition("${E}"), { E: "true" })).toEqual(["victim"]);
		expect(resolveNames(definition('"TRUE"'))).toEqual(["victim"]);
		expect(resolveNames(definition("1"))).toEqual(["victim"]);
	});

	it("an external key without a name is the key, whatever the spelling", () => {
		expect(
			resolveNames(withVolume("    external: ${E}"), { E: "True" }),
		).toEqual(["data"]);
	});

	it("still treats a false value as not external", () => {
		// name: is used as is with or without external.
		expect(resolveNames(definition('"false"'))).toEqual(["victim"]);
		expect(resolveNames(withVolume('    external: "false"'))).toEqual([
			`${APP}_data`,
			`${APP.toLowerCase()}_data`,
		]);
	});

	it("cannot check external from a variable that is not provided", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(withVolume("    external: ${E}"))),
		).rejects.toThrow(/Compose volume check failed/);
	});

	it("refuses external: ${E} when E=true makes it a foreign volume", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume("    external: ${E}"), { env: "E=true" }),
			),
		).rejects.toThrow(/Compose volume "data" is refused/);
	});

	it("refuses external: TRUE", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(composeRow(withVolume('    external: "TRUE"'))),
		).rejects.toThrow(/Compose volume "data" is refused/);
	});
});

describe("variables set to an empty value", () => {
	const yaml = withVolume("    name: ${A-app_own}${A+victim}");

	it("docker compose sees A= as set", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(composeRow(yaml, { env: "A=" })),
		).rejects.toThrow('Compose volume "${A-app_own}${A+victim}" is refused');
		// The message shows the compose's text; the log has the resolved name.
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ volumeName: "victim" }),
			expect.any(String),
		);
	});

	it("a stack does not get an empty variable at all", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, { env: "A=", composeType: "stack" }),
			),
		).rejects.toThrow('Compose volume "${A-app_own}${A+victim}" is refused');
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ volumeName: "app_own" }),
			expect.any(String),
		);
	});

	it("knows the deploy shell's PATH and HOME are set, without knowing them", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume("    name: x${HOME+victim}")),
			),
		).rejects.toThrow('Compose volume "x${HOME+victim}" is refused');
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ volumeName: "xvictim" }),
			expect.any(String),
		);
		await expect(
			assertComposeVolumesBound(composeRow(withVolume("    name: ${HOME}"))),
		).rejects.toThrow(/Compose volume check failed/);
		// A HOME the service sets itself does not override the process variable.
		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume("    name: ${HOME:-fallback}"), {
					env: "HOME=victim",
				}),
			),
		).rejects.toThrow(/Compose volume check failed/);
	});
});

describe("Docker's volume storage directory", () => {
	it.each([
		"/var/lib/docker/volumes",
		"/var/lib/docker/volumes/victim/_data",
		"/var/lib/docker/volumes/",
		"//var//lib/docker/volumes/victim",
		"/var/lib/docker/other/../volumes/victim",
		"/var/lib/docker/volumes/../volumes/victim",
		"/../../var/lib/docker/volumes/victim",
	])("reaches %s", (path) => {
		expect(reachesDockerVolumesDirectory(path)).toBe(true);
	});

	it("resolves relative paths and ~ through the base directories", () => {
		expect(
			reachesDockerVolumesDirectory("../../../../../var/lib/docker/volumes/x", [
				"/etc/dokploy/compose/app/code",
			]),
		).toBe(true);
		expect(reachesDockerVolumesDirectory("~/../var/lib/docker/volumes/x")).toBe(
			true,
		);
		expect(reachesDockerVolumesDirectory("./data", ["/etc/dokploy"])).toBe(
			false,
		);
	});

	it.each([
		"/var/lib/dockerx",
		"/var/lib/docker/volumes-other",
		"/var/lib/docker/containers/x",
		"/srv/data",
	])("does not refuse %s", (path) => {
		expect(reachesDockerVolumesDirectory(path)).toBe(false);
	});

	const refused = /is Docker's own volume storage/;

	it("refuses a short-syntax bind of it", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - /var/lib/docker/volumes/victim/_data:/data
`),
			),
		).rejects.toThrow(refused);
	});

	it("refuses a long-syntax bind with a hidden path", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - type: bind
        source: /srv/../var/lib/docker//volumes/victim/
        target: /data
`),
			),
		).rejects.toThrow(refused);
	});

	it("refuses a relative bind that climbs to it", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(
					`
services:
  web:
    volumes:
      - ../../../../../var/lib/docker/volumes/victim:/data
`,
					{},
				),
			),
		).rejects.toThrow(refused);
	});

	it("refuses a bind written through a variable that Dokploy resolves", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(
					`
services:
  web:
    volumes:
      - \${DIR}/victim:/data
`,
					{ env: "DIR=/var/lib/docker/volumes" },
				),
			),
		).rejects.toThrow(refused);
	});

	it("refuses a local-driver volume whose device is it", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(
					withVolume(`    driver: local
    driver_opts:
      type: none
      o: bind
      device: /var/lib/docker/volumes/victim/_data`),
				),
			),
		).rejects.toThrow(refused);
	});

	it("leaves other host paths alone", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - /var/lib/docker/containers:/containers:ro
      - /srv/data:/data
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
`),
			),
		).resolves.toBeUndefined();
	});
});

describe("volumes other composes declare", () => {
	const declaring = (
		composeFile: string,
		organizationId = "org-b",
		composeStatus = "done",
	) => ({
		composeId: "compose-other",
		appName: "other-compose",
		serverId: null,
		composeFile,
		composeStatus,
		...orgOf(organizationId),
	});
	const answerDeclarations = (rows: unknown[]) => {
		mocks.query.deployments.findFirst.mockResolvedValue({ deploymentId: "d" });
		return mocks.query.compose.findMany.mockImplementation(
			async (args: { columns?: { composeFile?: boolean } }) =>
				args?.columns?.composeFile ? rows : [],
		);
	};
	const yaml = `
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    external: true
    name: pgdata
`;

	it("refuses a name another organization's compose declares", async () => {
		answerDeclarations([declaring("volumes:\n  pg:\n    name: pgdata\n")]);

		await expect(assertComposeVolumesBound(composeRow(yaml))).rejects.toThrow(
			/Compose volume "pgdata" is refused/,
		);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				conflictingRows: [{ source: "composeFile", id: "other-compose" }],
			}),
			expect.stringContaining("refused"),
		);
	});

	it("refuses a name a compose of the same organization declares as external", async () => {
		answerDeclarations([
			declaring("volumes:\n  pgdata:\n    external: true\n", "org-a"),
		]);

		await expect(assertComposeVolumesBound(composeRow(yaml))).rejects.toThrow(
			/Compose volume "pgdata" is refused/,
		);
	});

	it("lets a compose that records the volume itself keep sharing it", async () => {
		answerDeclarations([
			declaring("volumes:\n  pgdata:\n    external: true\n", "org-a"),
		]);
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-own",
				composeId: "compose-1",
				compose: { appName: APP, serverId: null, ...orgOf("org-a") },
			},
		]);

		await expect(
			assertComposeVolumesBound(composeRow(yaml)),
		).resolves.toBeUndefined();
	});

	it("ignores a compose that does not declare the name", async () => {
		answerDeclarations([
			declaring("volumes:\n  pg:\n    name: pgdata-extra\n"),
		]);

		await expect(
			assertComposeVolumesBound(composeRow(yaml)),
		).resolves.toBeUndefined();
	});

	it("never blocks the compose's own namespace", async () => {
		answerDeclarations([declaring(`volumes:\n  pg:\n    name: ${APP}-data\n`)]);

		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume(`    name: ${APP}-data`)),
			),
		).resolves.toBeUndefined();
	});

	it("claims only through a deployment that finished", async () => {
		answerDeclarations([
			declaring("volumes:\n  pg:\n    name: pgdata\n", "org-b", "error"),
		]);

		// the compose was saved, or its deploys were refused: only error rows
		mocks.query.deployments.findFirst.mockResolvedValue(undefined);
		await expect(
			assertComposeVolumesBound(composeRow(yaml)),
		).resolves.toBeUndefined();

		// the question asked is "a deployment of that compose with status done",
		// whatever composeStatus says
		const asked = mocks.query.deployments.findFirst.mock.calls[0]?.[0];
		expect(sqlParams(asked.where)).toEqual(
			expect.arrayContaining(["compose-other", "done"]),
		);

		mocks.query.deployments.findFirst.mockResolvedValue({ deploymentId: "d" });
		await expect(assertComposeVolumesBound(composeRow(yaml))).rejects.toThrow(
			/Compose volume "pgdata" is refused/,
		);
	});

	it("does not read composeStatus at all", async () => {
		answerDeclarations([]);
		await assertComposeVolumesBound(composeRow(yaml));

		const declarationQuery = mocks.query.compose.findMany.mock.calls
			.map((call) => call[0])
			.find((args) => args?.columns?.composeFile);
		expect(declarationQuery.columns.composeStatus).toBeUndefined();
	});
});

describe("another organization's compose declaration on the other volume checks", () => {
	const declaration = {
		composeId: "compose-other",
		appName: "other-compose",
		serverId: null,
		composeFile: "volumes:\n  pg:\n    name: pgdata\n",
		...orgOf("org-b"),
	};
	const facts = async (volumeName: string) => {
		mocks.query.applications.findFirst.mockResolvedValue({
			appName: "app-mine-Zz1111",
			serverId: null,
			...orgOf("org-a"),
		});
		mocks.query.deployments.findFirst.mockResolvedValue({ deploymentId: "d" });
		mocks.query.compose.findMany.mockImplementation(
			async (args: { columns?: { composeFile?: boolean } }) =>
				args?.columns?.composeFile ? [declaration] : [],
		);
		return loadVolumeBindingFacts({
			serviceType: "application",
			serviceId: "app-1",
			volumeName,
		});
	};
	const ownMount = {
		mountId: "mount-mine",
		applicationId: "app-1",
		application: {
			appName: "app-mine-Zz1111",
			serverId: null,
			...orgOf("org-a"),
		},
	};
	const ownVolumeBackup = {
		volumeBackupId: "vb-mine",
		applicationId: "app-1",
		application: {
			appName: "app-mine-Zz1111",
			serverId: null,
			...orgOf("org-a"),
		},
	};

	it("claims against a name nobody has recorded, once the compose deployed", async () => {
		const result = await facts("pgdata");

		expect(result.otherOrganizationClaims).toEqual([
			{ source: "composeFile", id: "other-compose" },
		]);
		// creating a mount or a volume backup for it is refused, owner or not
		for (const privileged of [true, false]) {
			expect(evaluateVolumeBinding(result, { privileged }).ok).toBe(false);
		}
	});

	it("does not claim before the compose has a done deployment", async () => {
		mocks.query.deployments.findFirst.mockResolvedValue(undefined);
		const result = await facts("pgdata");
		mocks.query.deployments.findFirst.mockResolvedValue(undefined);
		const again = await loadVolumeBindingFacts({
			serviceType: "application",
			serviceId: "app-1",
			volumeName: "pgdata",
		});

		expect(result.otherOrganizationClaims).toHaveLength(1);
		expect(again.otherOrganizationClaims).toEqual([]);
	});

	it("is not counted for a name in the service's own namespace", async () => {
		const result = await facts("app-mine-Zz1111-data");

		expect(result.otherOrganizationClaims).toEqual([]);
		expect(evaluateVolumeBinding(result, { privileged: false }).ok).toBe(true);
	});

	it("never evicts a service's own mount: edit, deploy and backup keep working", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([ownMount]);
		const result = await facts("pgdata");

		expect(result.otherOrganizationClaims).toEqual([]);
		expect(mocks.query.deployments.findFirst).not.toHaveBeenCalled();
		// mount edit / volume backup on the existing row
		expect(evaluateVolumeBinding(result, { privileged: true }).ok).toBe(true);
		// application deploy with the stored mount
		await expect(
			findRefusedVolumeMounts([{ type: "volume", volumeName: "pgdata" }], {
				serviceType: "application",
				serviceId: "app-1",
			}),
		).resolves.toEqual([]);
	});

	it("never evicts a service's own volume backup row either", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([ownVolumeBackup]);
		const result = await facts("pgdata");

		expect(result.otherOrganizationClaims).toEqual([]);
	});

	it("still refuses another organization's mount row (#460)", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-b",
				mariadbId: "m-b",
				mariadb: { appName: "m-b", serverId: null, ...orgOf("org-b") },
			},
			ownMount,
		]);
		const result = await facts("pgdata");

		expect(result.otherOrganizationClaims).toEqual([
			{ source: "mount", id: "mount-b" },
		]);
	});
});

describe("composeStatus cannot be written through compose.update", () => {
	it("is dropped from the input", async () => {
		const { apiUpdateCompose } = await import(
			"@dokploy/server/db/schema/compose"
		);

		const parsed = apiUpdateCompose.parse({
			composeId: "compose-1",
			composeStatus: "done",
			name: "renamed",
		});

		expect(parsed).toEqual({ composeId: "compose-1", name: "renamed" });
	});
});

describe("save-time check of a raw compose file", () => {
	const typed = `
services:
  web:
    volumes:
      - shared:/data
      - data:/more
volumes:
  shared:
    external: true
  data:
`;

	it("applies the randomize renames a deploy applies", async () => {
		claimEverything();

		await expect(
			assertComposeFileVolumesBound(
				composeRow(typed, { randomize: true, suffix: "sfx" }),
				typed,
			),
		).rejects.toThrow('Compose volume "shared-sfx" is refused');
	});

	it("applies the isolated renames, and still refuses an explicit name", async () => {
		claimEverything();

		await expect(
			assertComposeFileVolumesBound(
				composeRow(typed, {
					isolatedDeployment: true,
					isolatedDeploymentsVolume: true,
				}),
				typed,
			),
		).rejects.toThrow(`Compose volume "shared-${APP}" is refused`);
		await expect(
			assertComposeFileVolumesBound(
				composeRow(typed, { isolatedDeployment: true }),
				withVolume("    name: victim"),
			),
		).rejects.toThrow('Compose volume "victim" is refused');
	});

	it("leaves a compose's own derived names alone with randomize on", async () => {
		await expect(
			assertComposeFileVolumesBound(
				composeRow(typed, { randomize: true, suffix: "sfx" }),
				withVolume(""),
			),
		).resolves.toBeUndefined();
	});
});

describe("YAML anchors and merge keys", () => {
	it("checks a volume definition that is merged in", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(`
x-shared: &shared
  external: true
  name: victim
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    <<: *shared
`),
			),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});

	it("checks service volumes that come from an anchor", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(`
x-mounts: &mounts
  volumes:
    - data:/data
services:
  web:
    <<: *mounts
volumes:
  data:
    name: victim
`),
			),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});
});

describe("custom command", () => {
	const yaml = `
services:
  web:
    image: nginx
`;
	const codeDirectory = `${paths(false)
		.COMPOSE_PATH.replace(/\\/g, "/")
		.replace(/^[A-Za-z]:/, "")}/${APP}/code`;
	const command = (value: string) => composeRow(yaml, { command: value });

	it("does not mistake rm -f, an absolute path to the same file, or other programs for another file", async () => {
		for (const value of [
			`compose -p ${APP} -f docker-compose.yml up -d && docker compose -p ${APP} -f docker-compose.yml rm -f web`,
			`compose -p ${APP} -f ${codeDirectory}/docker-compose.yml up -d`,
			`compose -p ${APP} -f ./docker-compose.yml logs -f web`,
			`compose -p ${APP} -f docker-compose.yml down`,
		]) {
			await expect(
				assertComposeVolumesBound(command(value)),
			).resolves.toBeUndefined();
		}
	});

	it("refuses a command that runs down or rm without naming a file (T-7161: they load the project)", async () => {
		for (const value of [
			`compose -p ${APP} down`,
			`compose -p ${APP} -f docker-compose.yml up -d && docker compose -p ${APP} rm -f web`,
		]) {
			await expect(assertComposeVolumesBound(command(value))).rejects.toThrow(
				/without naming a compose file/,
			);
		}
	});

	it("refuses a command that starts containers without naming a file", async () => {
		await expect(
			assertComposeVolumesBound(command(`compose -p ${APP} up -d`)),
		).rejects.toThrow(/without naming a compose file/);
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, {
					composeType: "stack",
					command: `stack deploy ${APP} --prune`,
				}),
			),
		).rejects.toThrow(/without naming a compose file/);
	});

	it("allows a stack command with the deployed file", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, {
					composeType: "stack",
					command: `stack deploy -c docker-compose.yml ${APP} --prune`,
				}),
			),
		).resolves.toBeUndefined();
	});

	it("checks the volumes of an override file too", async () => {
		claimEverything();
		mocks.readFileSync.mockReturnValue(`
services:
  web:
    volumes:
      - victim:/data
volumes:
  victim:
    external: true
`);

		await expect(
			assertComposeVolumesBound(
				command(
					`compose -p ${APP} -f docker-compose.yml -f override.yml up -d`,
				),
			),
		).rejects.toThrow(/Compose volume "victim" is refused/);
		expect(mocks.readFileSync).toHaveBeenCalledWith(
			`${codeDirectory}/override.yml`,
			"utf8",
		);
	});

	it("allows an override file whose volumes are the compose's own", async () => {
		mocks.readFileSync.mockReturnValue(`
services:
  web:
    environment:
      DEBUG: "1"
`);

		await expect(
			assertComposeVolumesBound(
				command(
					`compose -p ${APP} -f docker-compose.yml -f override.yml up -d`,
				),
			),
		).resolves.toBeUndefined();
	});

	it("refuses an override file it cannot read", async () => {
		mocks.readFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});

		await expect(
			assertComposeVolumesBound(
				command(`compose -p ${APP} -f other.yml up -d`),
			),
		).rejects.toThrow(/could not be read/);
	});

	const CLEAN_OVERRIDE = `
services:
  web:
    environment:
      DEBUG: "1"
`;

	it.each([
		["-f=override.yml", "up -d"],
		["--file=override.yml", "up -d"],
		["-foverride.yml", "up -d"],
		["--file override.yml", "up -d"],
	])("reads %s as a file", async (flag) => {
		mocks.readFileSync.mockReturnValue(CLEAN_OVERRIDE);

		await assertComposeVolumesBound(
			command(`compose -p ${APP} -f docker-compose.yml ${flag} up -d`),
		);

		expect(mocks.readFileSync).toHaveBeenCalledWith(
			`${codeDirectory}/override.yml`,
			"utf8",
		);
	});

	it("reads -c=path and --compose-file=path of a stack", async () => {
		mocks.readFileSync.mockReturnValue(CLEAN_OVERRIDE);

		for (const flag of ["-c=override.yml", "--compose-file=override.yml"]) {
			mocks.readFileSync.mockClear();
			await assertComposeVolumesBound(
				composeRow(yaml, {
					composeType: "stack",
					command: `stack deploy -c docker-compose.yml ${flag} ${APP}`,
				}),
			);
			expect(mocks.readFileSync).toHaveBeenCalledWith(
				`${codeDirectory}/override.yml`,
				"utf8",
			);
		}
	});

	it("skips docker's own options before compose and still applies the rules", async () => {
		mocks.readFileSync.mockReturnValue(CLEAN_OVERRIDE);

		for (const prefix of ["--log-level debug", "-l info", "-D"]) {
			mocks.readFileSync.mockClear();
			// a compose command that starts containers must still name a file
			await expect(
				assertComposeVolumesBound(command(`${prefix} compose -p ${APP} up -d`)),
			).rejects.toThrow(/without naming a compose file/);
			await expect(
				assertComposeVolumesBound(
					command(
						`compose -p ${APP} -f docker-compose.yml up -d && docker ${prefix} compose -p ${APP} up -d`,
					),
				),
			).rejects.toThrow(/without naming a compose file/);
			// and an override file after them is still read
			await assertComposeVolumesBound(
				command(`${prefix} compose -p ${APP} -f override.yml up -d`),
			);
			expect(mocks.readFileSync).toHaveBeenCalledWith(
				`${codeDirectory}/override.yml`,
				"utf8",
			);
		}
	});

	it("skips docker's options before stack too", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, {
					composeType: "stack",
					command: `--log-level debug stack deploy ${APP}`,
				}),
			),
		).rejects.toThrow(/without naming a compose file/);
	});

	it("reads a relative file from --project-directory as well", async () => {
		mocks.readFileSync.mockReturnValue(CLEAN_OVERRIDE);

		await assertComposeVolumesBound(
			command(
				`compose -p ${APP} --project-directory /srv/other -f override.yml up -d`,
			),
		);

		const read = mocks.readFileSync.mock.calls.map((call) => call[0]);
		expect(read).toContain("/srv/other/override.yml");
		expect(read).toContain(`${codeDirectory}/override.yml`);
	});

	it("takes the deployed file for granted when --project-directory is the code directory", async () => {
		await assertComposeVolumesBound(
			command(
				`compose -p ${APP} --project-directory ${codeDirectory} -f ./docker-compose.yml up -d --build`,
			),
		);

		expect(mocks.readFileSync).not.toHaveBeenCalled();
	});

	it("does not take a file for the deployed one when --project-directory moves it", async () => {
		mocks.readFileSync.mockReturnValue(CLEAN_OVERRIDE);

		await assertComposeVolumesBound(
			command(
				`compose -p ${APP} --project-directory /srv/other -f docker-compose.yml up -d`,
			),
		);

		expect(mocks.readFileSync.mock.calls.map((call) => call[0])).toEqual([
			"/srv/other/docker-compose.yml",
		]);
	});

	it("uses the volume definition of the main file for a key an override mounts", async () => {
		claimEverything();
		mocks.readFileSync.mockReturnValue(`
services:
  web:
    volumes:
      - data:/extra
`);

		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume("    name: victim"), {
					command: `compose -p ${APP} -f docker-compose.yml -f override.yml up -d`,
				}),
			),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});
});
