import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7135: a compose's deploy and its custom command may only act on the
// compose's own Compose project and stack, and `down -v` removes every
// non-external top-level volume of the project it loads, mounted or not.
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

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	open: async (path: string) => {
		const { dotenvHandle } = await import("./dotenv-fs-mock");
		const result = await mocks.readDotenv(path);
		return typeof result === "string" ? dotenvHandle(result) : result;
	},
}));

const fsError = (code: string) => Object.assign(new Error(code), { code });

const { assertComposeVolumesBound } = await import(
	"@dokploy/server/services/compose-volume-binding"
);
const { paths } = await import("@dokploy/server/constants");
const { createCommand } = await import(
	"@dokploy/server/utils/builders/compose"
);

const APP = "compose-x-abc123";
const OTHER = "compose-y-xyz789";
const CODE = `${paths(false)
	.COMPOSE_PATH.replace(/\\/g, "/")
	.replace(/^[A-Za-z]:/, "")}/${APP}/code`;
const DEPLOYED = `${CODE}/docker-compose.yml`;

const service = (body = "") => `
services:
  web:
    image: nginx
${body}
`;

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

// Another organization's service claims every volume name asked about.
const claimEverything = () =>
	mocks.query.mounts.findMany.mockResolvedValue([
		{
			mountId: "mount-b",
			mariadbId: "m-b",
			mariadb: {
				appName: "m-b",
				serverId: null,
				environment: { project: { organizationId: "org-b" } },
			},
		},
	]);

beforeEach(() => {
	vi.resetAllMocks();
	mocks.readDotenv.mockRejectedValue(fsError("ENOENT"));
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
	mocks.query.compose.findFirst.mockResolvedValue({
		appName: APP,
		serverId: null,
		composeFile: "",
		environment: { project: { organizationId: "org-a" } },
	});
});

const run = (command: string, overrides = {}, file = service()) =>
	assertComposeVolumesBound(composeRow(file, { command, ...overrides }));

const projectRefusal = (name: string) =>
	new RegExp(`passes the project name "${name}", which is not this compose's`);

describe("-p / --project-name of a custom command (gap 1)", () => {
	it.each(["-p", "--project-name"])(
		"refuses another compose's project given with %s, the actions that remove or stop",
		async (flag) => {
			for (const action of [
				"down -v",
				"down --volumes",
				"stop",
				"rm -f",
				"kill",
			]) {
				await expect(run(`compose ${flag} ${OTHER} ${action}`)).rejects.toThrow(
					projectRefusal(OTHER),
				);
			}
		},
	);

	it.each([
		`compose -p ${OTHER} down -v`,
		`compose -p=${OTHER} down -v`,
		`compose -p${OTHER} down -v`,
		`compose --project-name ${OTHER} down -v`,
		`compose --project-name=${OTHER} down -v`,
		`compose -vp ${OTHER} down -v`,
		`compose -vp${OTHER} down -v`,
		`compose -vp=${OTHER} down -v`,
		`compose -hvp ${OTHER} down`,
		`compose -f ${DEPLOYED} -p ${OTHER} down -v`,
		`compose -p ${OTHER} -f ${DEPLOYED} up -d`,
		`compose -p ${OTHER} logs`,
		`compose -p ${OTHER} ps`,
		`compose -p ${OTHER} -f ${DEPLOYED} build`,
		`compose -p ${OTHER} exec web true`,
		`compose -p ${OTHER} -f ${DEPLOYED} run web true`,
	])("refuses %s", async (command) => {
		await expect(run(command)).rejects.toThrow(projectRefusal(OTHER));
	});

	it("refuses it in any segment of a chain", async () => {
		await expect(
			run(
				`compose -p ${APP} -f ${DEPLOYED} up -d && docker compose -p ${OTHER} down -v`,
			),
		).rejects.toThrow(projectRefusal(OTHER));
		await expect(
			run(
				`compose -p ${APP} -f ${DEPLOYED} up -d && docker-compose -p ${OTHER} stop`,
			),
		).rejects.toThrow(projectRefusal(OTHER));
	});

	it("the last project name decides, as in pflag", async () => {
		await expect(run(`compose -p ${APP} -p ${OTHER} down -v`)).rejects.toThrow(
			projectRefusal(OTHER),
		);
		await expect(
			run(`compose --project-name ${APP} -p${OTHER} down`),
		).rejects.toThrow(projectRefusal(OTHER));
		await expect(
			run(`compose -p ${OTHER} -p ${APP} down -v`),
		).resolves.toBeUndefined();
		await expect(
			run(`compose --project-name=${OTHER} --project-name=${APP} stop`),
		).resolves.toBeUndefined();
		// An emptied name is no name: then the .env Dokploy writes names it.
		await expect(
			run(`compose -p ${OTHER} -p '' -f ${DEPLOYED} up -d`),
		).resolves.toBeUndefined();
	});

	it("lets the compose's own project name through, in every spelling", async () => {
		for (const command of [
			`compose -p ${APP} down -v`,
			`compose -p=${APP} down -v`,
			`compose -p${APP} stop`,
			`compose --project-name ${APP} rm -f`,
			`compose --project-name=${APP} down`,
			`compose -vp ${APP} down`,
			`compose -vp${APP} down`,
			`compose -p ${APP} -f ${DEPLOYED} up -d && docker compose -p ${APP} ps`,
			`compose -p ${APP} -f ${DEPLOYED} up -d --build --remove-orphans`,
		]) {
			await expect(run(command)).resolves.toBeUndefined();
		}
	});

	it("refuses a project name that is not the preview's own", async () => {
		// A preview deploys the base compose's command as the preview row, whose
		// appName is `preview-<appName>-<id>`: -p <base appName> would act on
		// the base project.
		const preview = `preview-${APP}-q1w2e3`;
		const previewFile = DEPLOYED.replace(`/${APP}/`, `/${preview}/`);
		await expect(
			run(`compose -p ${APP} -f ${previewFile} up -d`, { appName: preview }),
		).rejects.toThrow(projectRefusal(APP));
	});
});

describe("a command that names no project", () => {
	it("is allowed when the .env Dokploy writes names the project", async () => {
		await expect(run(`compose -f ${DEPLOYED} up -d`)).resolves.toBeUndefined();
		await expect(
			run(`compose -f ${DEPLOYED} down -v && docker compose -f ${DEPLOYED} ps`),
		).resolves.toBeUndefined();
		await expect(
			run("compose -f ./docker-compose.yml up -d"),
		).resolves.toBeUndefined();
	});

	it("is refused when the compose writes no .env (create env file off)", async () => {
		await expect(
			run(`compose -f ${DEPLOYED} up -d`, { createEnvFile: false }),
		).rejects.toThrow(/passes no project name/);
	});

	it("is refused with an --env-file (it replaces the .env that names the project)", async () => {
		await expect(
			run(`compose --env-file other.env -f ${DEPLOYED} up -d`),
		).rejects.toThrow(/passes no project name and it passes --env-file/);
		await expect(
			run(`compose --env-file=other.env -f ${DEPLOYED} down -v`),
		).rejects.toThrow(/passes no project name/);
		// -p wins over a COMPOSE_PROJECT_NAME of that file.
		await expect(
			run(`compose -p ${APP} --env-file other.env -f ${DEPLOYED} up -d`),
		).resolves.toBeUndefined();
	});

	it.each([
		"--project-directory ..",
		`--project-directory=/etc/dokploy/compose/${OTHER}`,
		"--workdir ..",
		`--workdir=/etc/dokploy/compose/${OTHER}/code`,
	])(
		"is refused with %s (the project is named after, and read from, that directory)",
		async (flag) => {
			await expect(run(`compose ${flag} -f ${DEPLOYED} up -d`)).rejects.toThrow(
				/passes no project name and its project directory/,
			);
			await expect(
				run(`compose -p ${APP} ${flag} -f ${DEPLOYED} up -d`),
			).resolves.toBeUndefined();
		},
	);

	it("is refused with a file outside the directory of the .env", async () => {
		mocks.readFileSync.mockReturnValue(service());
		await expect(
			run(`compose -f ../../${OTHER}/code/docker-compose.yml down -v`),
		).rejects.toThrow(/passes no project name and its project directory/);
		await expect(run("compose -f /tmp/c.yml down -v")).rejects.toThrow(
			/passes no project name and its project directory/,
		);
	});

	it("does not matter for version, config and pull", async () => {
		mocks.readFileSync.mockReturnValue(service());
		await expect(
			run(
				`compose -f ${DEPLOYED} up -d && docker compose version && docker compose -f /tmp/c.yml config && docker compose -f /tmp/c.yml pull`,
			),
		).resolves.toBeUndefined();
	});
});

describe("top-level name: of the compose files (gap 2)", () => {
	// Compose (docker/compose cmd/compose + compose-go cli/options.go
	// withNamePrecedenceLoad): -p, then COMPOSE_PROJECT_NAME of the environment or
	// the .env, then the name: of a file, then the name of the project directory.
	// A name: that is not the compose's own is refused whenever a command passes
	// no -p, so that it cannot take effect in any version.
	const named = (name: string) => `name: ${name}\n${service()}`;

	it("refuses a name: that differs when a command passes no -p", async () => {
		await expect(
			run(`compose -f ${DEPLOYED} up -d`, {}, named(OTHER)),
		).rejects.toThrow(/sets the project name with "name: compose-y-xyz789"/);
		await expect(
			run(
				`compose -f ${DEPLOYED} down -v`,
				{},
				named('"has spaces and, other things"'),
			),
		).rejects.toThrow(/sets the project name/);
		// One command without a name is enough.
		await expect(
			run(
				`compose -p ${APP} -f ${DEPLOYED} up -d && docker compose -f ${DEPLOYED} down -v`,
				{},
				named(OTHER),
			),
		).rejects.toThrow(/sets the project name/);
	});

	it("allows a name: that equals the appName", async () => {
		await expect(
			run(`compose -f ${DEPLOYED} up -d`, {}, named(APP)),
		).resolves.toBeUndefined();
	});

	it("-p wins over name:, so it has no effect when every command passes one", async () => {
		await expect(
			run(
				`compose -p ${APP} -f ${DEPLOYED} up -d && docker compose -p ${APP} down`,
				{},
				named(OTHER),
			),
		).resolves.toBeUndefined();
		// The default command always passes -p: nothing to refuse.
		await expect(
			assertComposeVolumesBound(composeRow(named(OTHER))),
		).resolves.toBeUndefined();
	});

	it("looks at the override files a command names", async () => {
		mocks.readFileSync.mockReturnValue(named(OTHER));
		await expect(
			run(`compose -f ${DEPLOYED} -f /srv/override.yml up -d`),
		).rejects.toThrow(/sets the project name/);
		mocks.readFileSync.mockReturnValue(named(APP));
		await expect(
			run(`compose -f ${DEPLOYED} -f /srv/override.yml up -d`),
		).resolves.toBeUndefined();
		mocks.readFileSync.mockReturnValue(named(OTHER));
		await expect(
			run(`compose -p ${APP} -f ${DEPLOYED} -f /srv/override.yml up -d`),
		).resolves.toBeUndefined();
	});
});

describe("stack names of a custom command (gap 3)", () => {
	const stack = (command: string) => run(command, { composeType: "stack" });

	it.each([
		`stack rm ${OTHER}`,
		`stack ps ${OTHER}`,
		`stack services ${OTHER}`,
		`stack deploy -c docker-compose.yml ${OTHER}`,
		`stack deploy --compose-file docker-compose.yml ${OTHER} --prune`,
		`stack deploy --compose-file=docker-compose.yml --prune ${OTHER}`,
		`stack deploy -cdocker-compose.yml ${OTHER}`,
		`stack ps -f name=web ${OTHER}`,
		`stack ps --filter name=web ${OTHER}`,
		`stack services --format '{{.Name}}' ${OTHER}`,
		`stack rm ${APP} ${OTHER}`,
		`stack rm ${OTHER} ${APP}`,
		`stack rm -- ${OTHER}`,
	])("refuses %s", async (command) => {
		await expect(stack(command)).rejects.toThrow(
			/names the stack "compose-y-xyz789", which is not this compose's own|not understood|shell control/,
		);
	});

	it("refuses an option it does not know, which could take a name", async () => {
		await expect(
			stack(`stack deploy -c docker-compose.yml --unknown ${APP}`),
		).rejects.toThrow(/docker stack option "--unknown" is not understood/);
	});

	it("lets the compose's own stack through", async () => {
		for (const command of [
			`stack deploy -c docker-compose.yml ${APP}`,
			`stack deploy -c docker-compose.yml ${APP} --prune --with-registry-auth`,
			`stack deploy --prune --with-registry-auth --compose-file docker-compose.yml ${APP}`,
			`stack deploy --detach=false -c docker-compose.yml ${APP}`,
			`stack deploy -c docker-compose.yml ${APP} --resolve-image never`,
			`stack ps ${APP}`,
			`stack ps -f name=web --no-trunc ${APP}`,
			`stack services -q ${APP}`,
			`stack rm ${APP}`,
		]) {
			await expect(stack(command)).resolves.toBeUndefined();
		}
	});
});

describe("volumes that no service mounts (gap 4)", () => {
	const declared = (definition: string) => `
services:
  web:
    image: nginx
volumes:
  unused:
${definition}
`;

	it("refuses an unmounted volume that names another compose's volume, with down -v", async () => {
		claimEverything();
		await expect(
			run(
				`compose -p ${APP} -f ${DEPLOYED} up -d && docker compose -p ${APP} -f /srv/evil.yml down -v`,
				{},
				service(),
			),
		).rejects.toThrow();
		// The deployed file itself: the freshVolumes teardown runs
		// `down --volumes` on it too.
		await expect(
			assertComposeVolumesBound(
				composeRow(declared("    name: victim_data"), { command: "" }),
			),
		).rejects.toThrow(/Compose volume "victim_data" is refused/);
	});

	it("refuses it in an override file the command passes to down -v", async () => {
		claimEverything();
		mocks.readFileSync.mockReturnValue(declared("    name: victim_data"));
		await expect(
			run(`compose -p ${APP} -f ${DEPLOYED} -f /srv/evil.yml down -v`),
		).rejects.toThrow(/Compose volume "victim_data" is refused/);
	});

	it("keeps the volume of another compose out even when only declared", async () => {
		claimEverything();
		await expect(
			assertComposeVolumesBound(
				composeRow(declared("    name: ${V:-victim_data}")),
			),
		).rejects.toThrow(/is refused/);
	});

	it("allows the default name and an own-namespace name", async () => {
		for (const definition of ["    {}", `    name: ${APP}_cache`]) {
			await expect(
				assertComposeVolumesBound(composeRow(declared(definition))),
			).resolves.toBeUndefined();
		}
	});

	it("allows an external declaration, which down -v never removes", async () => {
		claimEverything();
		for (const definition of [
			"    {}",
			// `down -v` never removes an external volume, and nothing mounts it.
			"    name: victim_data\n    external: true",
			"    external: true",
		]) {
			await expect(
				assertComposeVolumesBound(composeRow(declared(definition))),
			).resolves.toBeUndefined();
		}
	});

	it("cannot tell the name of a declared volume that is a variable nobody sets", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(declared("    name: ${NOBODY_SETS_THIS}")),
			),
		).rejects.toThrow(/Compose volume check failed/);
	});
});

describe("the default command of Dokploy", () => {
	const base = {
		composeType: "docker-compose",
		appName: APP,
		sourceType: "raw",
		composePath: "./docker-compose.yml",
		createEnvFile: true,
		command: "",
		buildServerId: null,
		pullImagesOnDeploy: false,
	};
	const asCustom = (compose: typeof base, overrides = {}) => {
		const command = createCommand(compose as never);
		expect(command).toContain(`-p ${compose.appName}`);
		return run(
			// The command is `docker <command>`, so a custom command is written
			// without the `docker`.
			command,
			{ appName: compose.appName, ...overrides },
		);
	};

	it("passes -p <appName>, also for an isolated deployment", async () => {
		await expect(asCustom(base)).resolves.toBeUndefined();
		// An isolated deployment renames the services, volumes and networks
		// (`-<suffix>`) and keeps the project name.
		await expect(
			asCustom(base, {
				isolatedDeployment: true,
				isolatedDeploymentsVolume: true,
			}),
		).resolves.toBeUndefined();
	});

	it("passes the preview's own appName for a preview", async () => {
		const preview = { ...base, appName: `preview-${APP}-q1w2e3` };
		await expect(asCustom(preview)).resolves.toBeUndefined();
		// The base compose's command is not the preview's.
		await expect(
			run(createCommand(base as never), { appName: preview.appName }),
		).rejects.toThrow(projectRefusal(APP));
	});

	it("passes the stack name for a stack", async () => {
		const stack = { ...base, composeType: "stack" };
		const command = createCommand(stack as never);
		expect(command).toContain(`${APP} --prune`);
		await expect(
			run(command, { composeType: "stack" }),
		).resolves.toBeUndefined();
	});

	it("is not touched when the compose has no custom command", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(service())),
		).resolves.toBeUndefined();
		await expect(
			assertComposeVolumesBound(
				composeRow(service(), { appName: `preview-${APP}-q1w2e3` }),
			),
		).resolves.toBeUndefined();
	});
});
