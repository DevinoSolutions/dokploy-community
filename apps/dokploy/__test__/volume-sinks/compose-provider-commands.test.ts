import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7161 review: a `docker compose` command that loads the compose files (a
// loader such as up/build/pull, or a label-driven one such as down/stop with no
// project name) must name them with -f, and every -f any command names is
// parsed, so a chained command cannot bring a file that the check never saw
// (also through a short-flag bundle or an emptied project name). A compose that
// cannot be parsed, or that has several YAML documents, is refused instead of
// skipped. `models:` uses the host's shared model runner.
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
		readDotenv: vi.fn(),
		readFileSync: vi.fn(),
		existsSync: vi.fn(),
		execAsyncRemote: vi.fn(),
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
	existsSync: mocks.existsSync,
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	open: async (path: string) => {
		const { dotenvHandle } = await import("./dotenv-fs-mock");
		const result = await mocks.readDotenv(path);
		return typeof result === "string" ? dotenvHandle(result) : result;
	},
}));

const fsError = (code: string) => Object.assign(new Error(code), { code });

const {
	assertComposeVolumesBound,
	assertComposeFileVolumesBound,
	assertComposeFileOnDiskVolumesBound,
} = await import("@dokploy/server/services/compose-volume-binding");
const { resolveComposeMountedVolumes } = await import(
	"@dokploy/server/utils/volume-backups/compose-volumes"
);
const { paths } = await import("@dokploy/server/constants");
const { parse } = await import("yaml");

const APP = "compose-x-AbC123";
const VICTIM = "/var/lib/docker/volumes/victim_data/_data";
const CODE = `${paths(false)
	.COMPOSE_PATH.replace(/\\/g, "/")
	.replace(/^[A-Za-z]:/, "")}/${APP}/code`;
const DEPLOYED = `${CODE}/docker-compose.yml`;

const service = (body: string) => `
services:
  web:
    image: nginx
${body}
`;

const PROVIDER = `
services:
  x:
    provider:
      type: /bin/sh
`;
const BAD_MOUNT = service(`    volumes:\n      - "${VICTIM}:/x"`);
const CLEAN = service("    environment:\n      A: b");

const composeRow = (composeFile: string, overrides = {}) =>
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

beforeEach(() => {
	vi.resetAllMocks();
	mocks.readDotenv.mockRejectedValue(fsError("ENOENT"));
	mocks.existsSync.mockReturnValue(false);
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
});

describe("custom commands that chain compose subcommands", () => {
	const run = (command: string) =>
		assertComposeVolumesBound(composeRow(service(""), { command }));
	const SUBCOMMANDS = [
		"pull",
		"down",
		"down -v",
		"stop",
		"restart",
		"start",
		"config",
		"run web true",
		"exec web true",
		"logs",
		"ps",
		"kill",
		"build",
	];

	it("parses the -f file of every subcommand that loads the project", async () => {
		for (const sub of SUBCOMMANDS) {
			const command = `compose -f ${DEPLOYED} up -d && docker compose -f /tmp/evil.yml ${sub}`;
			mocks.readFileSync.mockReturnValue(PROVIDER);
			await expect(run(command)).rejects.toThrow(/declares a provider/);
			mocks.readFileSync.mockReturnValue(BAD_MOUNT);
			await expect(run(command)).rejects.toThrow(/Docker's own volume storage/);
		}
	});

	it("catches the file when the chain starts with the other subcommand", async () => {
		mocks.readFileSync.mockReturnValue(PROVIDER);
		for (const sub of ["down", "down -v", "stop", "pull"]) {
			await expect(
				run(
					`compose -f /tmp/evil.yml ${sub} && docker compose -f ${DEPLOYED} up -d`,
				),
			).rejects.toThrow(/declares a provider/);
			await expect(
				run(
					`compose -f ${DEPLOYED} up -d && docker-compose -f /tmp/evil.yml ${sub}`,
				),
			).rejects.toThrow(/declares a provider/);
		}
	});

	it("refuses a project-loading subcommand that names no file", async () => {
		for (const sub of SUBCOMMANDS) {
			await expect(
				run(`compose -f ${DEPLOYED} up -d && docker compose ${sub}`),
			).rejects.toThrow(/without naming a compose file/);
		}
		await expect(
			run(`compose down && docker compose -f ${DEPLOYED} up -d`),
		).rejects.toThrow(/without naming a compose file/);
	});

	it("refuses a loader without -f even with a project name", async () => {
		for (const sub of [
			"up -d",
			"pull",
			"build",
			"create",
			"config",
			"run web true",
		]) {
			await expect(run(`compose -p ${APP} ${sub}`)).rejects.toThrow(
				/without naming a compose file/,
			);
			await expect(run(`compose --project-name=${APP} ${sub}`)).rejects.toThrow(
				/without naming a compose file/,
			);
		}
	});

	it("lets a label-driven command with a project name and no -f through", async () => {
		const LABEL_DRIVEN = [
			"down",
			"down -v",
			"stop",
			"start",
			"restart",
			"kill",
			"rm -f web",
			"ps",
			"logs -f web",
			"exec web true",
			"images",
			"port web 80",
			"top",
			"pause",
			"unpause",
			"wait web",
		];
		for (const name of [
			`-p ${APP}`,
			`--project-name ${APP}`,
			`--project-name=${APP}`,
			`-p=${APP}`,
			`-p${APP}`,
		]) {
			for (const sub of LABEL_DRIVEN) {
				await expect(
					run(`compose -f ${DEPLOYED} up -d && docker compose ${name} ${sub}`),
				).resolves.toBeUndefined();
			}
		}
		await expect(
			run(
				`compose -p ${APP} -f ${DEPLOYED} up -d && docker-compose -p ${APP} down`,
			),
		).resolves.toBeUndefined();
	});

	it("refuses a label-driven command without a project name and without -f", async () => {
		for (const value of ["down", "stop", "ps", "exec web true", "logs"]) {
			await expect(
				run(`compose -f ${DEPLOYED} up -d && docker compose ${value}`),
			).rejects.toThrow(/without naming a compose file/);
		}
		// An empty name is no name.
		await expect(
			run(
				`compose -f ${DEPLOYED} up -d && docker compose --project-name= down`,
			),
		).rejects.toThrow(/without naming a compose file/);
	});

	it("reads a -f hidden in a bundle of short flags", async () => {
		mocks.readFileSync.mockReturnValue(PROVIDER);
		for (const command of [
			`compose -p ${APP} -vf/tmp/evil.yml down`,
			`compose -p ${APP} -vf=/tmp/evil.yml down`,
			`compose -p ${APP} -vf /tmp/evil.yml down`,
			`compose -f ${DEPLOYED} -vf/tmp/evil.yml up -d`,
			"compose -f /tmp/ok.yml -hvf/tmp/evil.yml up -d",
			`compose -p ${APP} -f/tmp/evil.yml down`,
			`compose -p ${APP} -f=/tmp/evil.yml down`,
		]) {
			await expect(run(command)).rejects.toThrow(/declares a provider/);
		}
	});

	it("refuses a bundle it does not understand", async () => {
		for (const command of [
			`compose -p ${APP} -xf/tmp/evil.yml down`,
			`compose -f ${DEPLOYED} -Pp ${APP} up -d`,
		]) {
			await expect(run(command)).rejects.toThrow(/is not understood/);
		}
	});

	it("lets bundles of booleans and a project name through", async () => {
		await expect(run(`compose -p ${APP} -v down`)).resolves.toBeUndefined();
		await expect(run(`compose -vp ${APP} down`)).resolves.toBeUndefined();
		await expect(run(`compose -vp${APP} down`)).resolves.toBeUndefined();
		await expect(run(`compose -vp=${APP} ps`)).resolves.toBeUndefined();
		mocks.readFileSync.mockReturnValue(CLEAN);
		await expect(
			run(
				`compose -vf ${DEPLOYED} up -d && docker compose -vf/tmp/ok.yml pull`,
			),
		).resolves.toBeUndefined();
	});

	it("lets the last project name decide", async () => {
		for (const command of [
			`compose -p ${APP} -p '' down`,
			`compose -p ${APP} -p= down`,
			`compose -p ${APP} --project-name= down`,
			`compose -p ${APP} --project-name '' down`,
			`compose -p ${APP} --project-name="" down`,
			`compose --project-name ${APP} --project-name= stop`,
			`compose -p ${APP} -vp '' down`,
		]) {
			await expect(run(command)).rejects.toThrow(
				/without naming a compose file|invalid|not understood/,
			);
		}
		await expect(run(`compose -p '' -p ${APP} down`)).resolves.toBeUndefined();
		await expect(
			run(`compose --project-name= --project-name ${APP} down`),
		).resolves.toBeUndefined();
	});

	it("still parses a -f given to a label-driven command with a project name", async () => {
		mocks.readFileSync.mockReturnValue(PROVIDER);
		for (const sub of ["down -v", "stop", "ps", "exec web true"]) {
			await expect(
				run(
					`compose -f ${DEPLOYED} up -d && docker compose -p ${APP} -f /tmp/evil.yml ${sub}`,
				),
			).rejects.toThrow(/declares a provider/);
		}
		mocks.readFileSync.mockReturnValue(BAD_MOUNT);
		await expect(
			run(
				`compose -f ${DEPLOYED} up -d && docker compose -p ${APP} -f /tmp/evil.yml down -v`,
			),
		).rejects.toThrow(/Docker's own volume storage/);
	});

	it("lets the deployed file and clean overrides through, and version", async () => {
		mocks.readFileSync.mockReturnValue(CLEAN);
		for (const sub of SUBCOMMANDS) {
			await expect(
				run(
					`compose -f ${DEPLOYED} up -d && docker compose -f ${DEPLOYED} ${sub} && docker compose -f /tmp/ok.yml ${sub}`,
				),
			).resolves.toBeUndefined();
		}
		await expect(
			run(`compose -f ${DEPLOYED} up -d && docker compose version`),
		).resolves.toBeUndefined();
	});

	it("reads every -f of a segment and resolves a relative file", async () => {
		mocks.readFileSync.mockReturnValue(PROVIDER);
		await expect(
			run(`compose -f ${DEPLOYED} -f evil.yml pull`),
		).rejects.toThrow(/declares a provider/);
		await expect(
			run(
				`compose --file=evil.yml stop && docker compose -f ${DEPLOYED} up -d`,
			),
		).rejects.toThrow(/declares a provider/);
	});

	it("refuses an override file that has two YAML documents", async () => {
		mocks.readFileSync.mockReturnValue(`${CLEAN}\n---\n${PROVIDER}`);
		await expect(
			run(
				`compose -f ${DEPLOYED} up -d && docker compose -f /tmp/evil.yml pull`,
			),
		).rejects.toThrow(/more than one YAML document/);
	});
});

describe("multi-document YAML and unparsable files", () => {
	const TWO = `${CLEAN}\n---\n${service("")}`;

	it("refuses a raw compose with two documents at deploy and on save", async () => {
		await expect(assertComposeVolumesBound(composeRow(TWO))).rejects.toThrow(
			/more than one YAML document/,
		);
		await expect(
			assertComposeFileVolumesBound(composeRow("") as never, TWO),
		).rejects.toThrow(/more than one YAML document/);
	});

	it("refuses a git compose with two documents after the clone", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.readFileSync.mockReturnValue(TWO);
		await expect(
			assertComposeVolumesBound(
				composeRow("", {
					sourceType: "git",
					composePath: "./docker-compose.yml",
				}),
			),
		).rejects.toThrow(/more than one YAML document/);
	});

	it("still lets invalid YAML go to the editor on save", async () => {
		await expect(
			assertComposeFileVolumesBound(composeRow("") as never, "a: [b"),
		).resolves.toBeUndefined();
	});

	describe("Start (the file on disk)", () => {
		const start = (row = {}) =>
			assertComposeFileOnDiskVolumesBound(
				composeRow("", {
					sourceType: "git",
					composePath: "./docker-compose.yml",
					...row,
				}),
			);

		it("refuses a file with two documents", async () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readFileSync.mockReturnValue(TWO);
			await expect(start()).rejects.toThrow(/more than one YAML document/);
		});

		it("refuses a file that is not valid YAML", async () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readFileSync.mockReturnValue("a: [b");
			await expect(start()).rejects.toThrow(/not valid YAML/);
		});

		it("refuses a file that cannot be read", async () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readFileSync.mockImplementation(() => {
				throw fsError("EACCES");
			});
			await expect(start()).rejects.toThrow(/could not be read/);
		});

		it("refuses a provider in the file, remote too", async () => {
			mocks.existsSync.mockReturnValue(true);
			mocks.readFileSync.mockReturnValue(PROVIDER);
			await expect(start()).rejects.toThrow(/declares a provider/);
			mocks.execAsyncRemote.mockResolvedValue({
				stdout: PROVIDER,
				stderr: "",
			});
			await expect(start({ serverId: "srv-1" })).rejects.toThrow(
				/declares a provider/,
			);
			mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
			await expect(start({ serverId: "srv-1" })).rejects.toThrow(
				/could not be read/,
			);
		});

		it("does nothing when there is no file, and starts a clean one", async () => {
			mocks.existsSync.mockReturnValue(false);
			await expect(start()).resolves.toBeUndefined();
			mocks.existsSync.mockReturnValue(true);
			mocks.readFileSync.mockReturnValue(CLEAN);
			await expect(start()).resolves.toBeUndefined();
		});
	});
});

describe("a remote git compose with two documents", () => {
	it("stops at the render step before any docker command", async () => {
		const { renderComposeWithDomains } = await import(
			"@dokploy/server/utils/docker/domain"
		);
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: `${CLEAN}\n---\n${PROVIDER}`,
			stderr: "",
		});
		const row = composeRow("", {
			sourceType: "git",
			composePath: "./docker-compose.yml",
			serverId: "srv-1",
		});
		const rendered = await renderComposeWithDomains(row, []);
		expect(rendered).toHaveProperty("errorCommand");
		const { errorCommand } = rendered as { errorCommand: string };
		expect(errorCommand).toMatch(/exit 1/);
		expect(errorCommand).not.toMatch(/docker/);
	});
});

describe("models", () => {
	const models = (yaml: string) =>
		resolveComposeMountedVolumes(parse(yaml, { merge: true }), {
			appName: APP,
			env: {},
			strict: false,
			baseDirs: [CODE],
		}).models;

	it("refuses top-level models and a service, hook or job that uses them", () => {
		expect(
			models(`
models:
  llm:
    model: ai/smollm2
services:
  web:
    image: nginx
`),
		).toEqual(["top-level models"]);
		expect(
			models(`
services:
  web:
    image: nginx
    models:
      - llm
    pre_start:
      - image: alpine
        models:
          llm: {}
jobs:
  j:
    image: alpine
    models: [llm]
`),
		).toEqual([
			'service "web" (models)',
			'service "web" pre_start[0] (models)',
			'job "j" (models)',
		]);
	});

	it("leaves a compose without models alone", () => {
		expect(
			models(`
models: {}
services:
  web:
    image: nginx
    models: []
    labels:
      models: x
`),
		).toEqual([]);
	});

	it("refuses them at deploy", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
models:
  llm:
    model: ai/smollm2
services:
  web:
    image: nginx
    models: [llm]
`),
			),
		).rejects.toThrow(/Compose refused: top-level models uses `models`/);
	});
});
