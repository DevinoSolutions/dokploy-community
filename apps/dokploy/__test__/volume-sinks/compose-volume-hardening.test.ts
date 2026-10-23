import { inspect } from "node:util";
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
const { assertComposeVolumesBound } = await import(
	"@dokploy/server/services/compose-volume-binding"
);
const { resolveComposeMountedVolumes, reachesDockerVolumesDirectory } =
	await import("@dokploy/server/utils/volume-backups/compose-volumes");
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
			assertComposeVolumesBound(
				composeRow(withVolume("    external: ${E}")),
			),
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
			assertComposeVolumesBound(
				composeRow(withVolume('    external: "TRUE"')),
			),
		).rejects.toThrow(/Compose volume "data" is refused/);
	});
});

describe("variables set to an empty value", () => {
	const yaml = withVolume("    name: ${A-app_own}${A+victim}");

	it("docker compose sees A= as set", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(composeRow(yaml, { env: "A=" })),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});

	it("a stack does not get an empty variable at all", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(yaml, { env: "A=", composeType: "stack" }),
			),
		).rejects.toThrow(/Compose volume "app_own" is refused/);
	});

	it("knows the deploy shell's PATH and HOME are set, without knowing them", async () => {
		claimEverything();

		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume("    name: x${HOME+victim}")),
			),
		).rejects.toThrow(/Compose volume "xvictim" is refused/);
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
		"/var/lib/docker",
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
      - /var/lib/docker:/docker:ro
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
	const declaring = (composeFile: string, organizationId = "org-b") => ({
		appName: "other-compose",
		serverId: null,
		composeFile,
		...orgOf(organizationId),
	});
	const answerDeclarations = (rows: unknown[]) =>
		mocks.query.compose.findMany.mockImplementation(
			async (args: { columns?: { composeFile?: boolean } }) =>
				args?.columns?.composeFile ? rows : [],
		);
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
		answerDeclarations([
			declaring("volumes:\n  pg:\n    name: pgdata\n"),
		]);

		await expect(assertComposeVolumesBound(composeRow(yaml))).rejects.toThrow(
			/Compose volume "pgdata" is refused/,
		);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({ declaredByComposeFiles: ["other-compose"] }),
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

	it("ignores a compose that does not declare the name", async () => {
		answerDeclarations([
			declaring("volumes:\n  pg:\n    name: pgdata-extra\n"),
		]);

		await expect(
			assertComposeVolumesBound(composeRow(yaml)),
		).resolves.toBeUndefined();
	});

	it("never blocks the compose's own namespace", async () => {
		answerDeclarations([
			declaring(`volumes:\n  pg:\n    name: ${APP}-data\n`),
		]);

		await expect(
			assertComposeVolumesBound(
				composeRow(withVolume(`    name: ${APP}-data`)),
			),
		).resolves.toBeUndefined();
	});

	it("asks for deployed composes of the same server only", async () => {
		answerDeclarations([]);
		await assertComposeVolumesBound(composeRow(yaml));

		const declarationQuery = mocks.query.compose.findMany.mock.calls
			.map((call) => call[0])
			.find((args) => args?.columns?.composeFile);
		expect(declarationQuery).toBeDefined();
		expect(inspect(declarationQuery.where, { depth: 8 })).toContain("done");
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
			`compose -p ${APP} -f docker-compose.yml up -d && docker compose -p ${APP} rm -f web`,
			`compose -p ${APP} -f ${codeDirectory}/docker-compose.yml up -d`,
			`compose -p ${APP} -f ./docker-compose.yml logs -f web`,
			`compose -p ${APP} down`,
		]) {
			await expect(
				assertComposeVolumesBound(command(value)),
			).resolves.toBeUndefined();
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
