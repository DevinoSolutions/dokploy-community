import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7161: a service with a `provider` makes Docker Compose run a program of the
// host (a Docker CLI plugin, or any path or PATH name its `type` gives), so it
// is refused for every type. `credential_spec.file` is a path field that no
// check covered, and `pre_start` hooks and `jobs` take the full container spec
// like a service does, so they go through the same checks.
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

const { assertComposeVolumesBound, assertComposeFileVolumesBound } =
	await import("@dokploy/server/services/compose-volume-binding");
const { resolveComposeMountedVolumes, resolveComposeFilesMountedVolumes } =
	await import("@dokploy/server/utils/volume-backups/compose-volumes");
const { paths } = await import("@dokploy/server/constants");
const { parse } = await import("yaml");

const APP = "compose-x-AbC123";
const BASE = "/etc/dokploy/compose/app/code";
const STORAGE = "/var/lib/docker/volumes";
const VICTIM = `${STORAGE}/victim_data/_data`;
const CODE = `${paths(false)
	.COMPOSE_PATH.replace(/\\/g, "/")
	.replace(/^[A-Za-z]:/, "")}/${APP}/code`;

const options = (env: Record<string, string> | null = {}, strict = false) => ({
	appName: APP,
	env,
	strict,
	baseDirs: [BASE],
});

const check = (
	yaml: string,
	env: Record<string, string> | null = {},
	strict = false,
) => {
	const { forbidden, forbiddenParents, unresolved, providers } =
		resolveComposeMountedVolumes(
			parse(yaml, { merge: true }),
			options(env, strict),
		);
	return { forbidden, forbiddenParents, unresolved, providers };
};

const clean = {
	forbidden: [],
	forbiddenParents: [],
	unresolved: [],
	providers: [],
};

const service = (body: string) => `
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

beforeEach(() => {
	vi.clearAllMocks();
	mocks.readDotenv.mockRejectedValue(fsError("ENOENT"));
	for (const table of Object.values(mocks.query)) {
		table.findMany.mockResolvedValue([]);
	}
});

describe("provider services", () => {
	it("refuses a provider with an absolute type", () => {
		expect(
			check(`
services:
  x:
    provider:
      type: /bin/sh
      options:
        c: id
`).providers,
		).toEqual(['service "x" (provider type "/bin/sh")']);
	});

	it("refuses a provider with a bare or relative type", () => {
		expect(
			check(
				`
services:
  x:
    provider:
      type: awesomecloud
`,
			).providers,
		).toEqual(['service "x" (provider type "awesomecloud")']);
		expect(
			check(
				`
services:
  x:
    provider:
      type: ./run
`,
			).providers,
		).toEqual(['service "x" (provider type "./run")']);
	});

	it("refuses a provider whose type comes from a variable, resolved or not", () => {
		const yaml = `
services:
  x:
    provider:
      type: \${TYPE}
`;
		expect(check(yaml, { TYPE: "/bin/sh" }).providers).toEqual([
			'service "x" (provider type "${TYPE}")',
		]);
		expect(check(yaml, { TYPE: "safe" }).providers).toHaveLength(1);
		expect(check(yaml, null, true).providers).toHaveLength(1);
	});

	it("refuses a provider that arrives through an anchor and a merge key", () => {
		expect(
			check(`
x-base: &base
  provider:
    type: /bin/sh
services:
  x:
    <<: *base
  y:
    image: nginx
`).providers,
		).toEqual(['service "x" (provider type "/bin/sh")']);
		expect(
			check(`
x-provider: &p
  type: /bin/sh
services:
  x:
    provider: *p
`).providers,
		).toEqual(['service "x" (provider type "/bin/sh")']);
		expect(
			check(`
x-all: &all
  svc: &svc
    provider:
      type: /bin/sh
services:
  <<: *all
`).providers,
		).toEqual(['service "svc" (provider type "/bin/sh")']);
	});

	it("refuses quoted keys and a provider without a readable type", () => {
		expect(
			check(`
services:
  x:
    "provider":
      "type": '/bin/sh'
`).providers,
		).toEqual(['service "x" (provider type "/bin/sh")']);
		expect(
			check(`
services:
  x:
    provider: {}
  y:
    provider: nonsense
`).providers,
		).toEqual(['service "x" (provider)', 'service "y" (provider)']);
	});

	it("refuses one in an override file of a custom command", () => {
		const { providers } = resolveComposeFilesMountedVolumes(
			[
				parse(service("")),
				parse(`
services:
  web:
    provider:
      type: /bin/sh
`),
			],
			options(),
		);
		expect(providers).toEqual(['service "web" (provider type "/bin/sh")']);
	});

	it("leaves services without a provider alone", () => {
		expect(
			check(`
x-provider: &p
  type: /bin/sh
services:
  web:
    image: nginx
    provider: null
    labels:
      provider: /bin/sh
    environment:
      PROVIDER: /bin/sh
    command: provider
`),
		).toEqual(clean);
	});
});

describe("credential_spec", () => {
	const spec = (body: string) => service(`    credential_spec:\n${body}`);

	it("lets a relative file, a config and a registry value through", () => {
		expect(check(spec("      file: ./cred.json"))).toEqual(clean);
		expect(check(spec("      file: cred.json"))).toEqual(clean);
		expect(check(spec("      file: file://my-spec.json"))).toEqual(clean);
		expect(check(spec("      config: my_credential_spec"))).toEqual(clean);
		expect(check(spec("      registry: my-credential-spec"))).toEqual(clean);
	});

	it("refuses a file inside Docker's volume storage", () => {
		expect(check(spec(`      file: ${VICTIM}`)).forbidden).toEqual([
			`credential_spec file "${VICTIM}"`,
		]);
		expect(
			check(spec("      file: /var/lib/docker/volumes/x")).forbidden,
		).toEqual(['credential_spec file "/var/lib/docker/volumes/x"']);
		expect(check(spec(`      file: file://${VICTIM}`)).forbidden).toEqual([
			`credential_spec file "${VICTIM}"`,
		]);
	});

	it("refuses a file in a directory that contains the storage", () => {
		for (const parent of ["/", "/var", "/var/lib", "/var/lib/docker"]) {
			expect(
				check(spec(`      file: ${parent}`)).forbiddenParents,
			).toHaveLength(1);
		}
	});

	it("resolves a relative file from the compose directory", () => {
		const up = "../../../../../../../../../..";
		expect(check(spec(`      file: ${up}${VICTIM}`)).forbidden).toHaveLength(1);
		expect(check(spec("      file: ./cred/spec.json"))).toEqual(clean);
	});

	it("judges a file that comes from a variable by its value", () => {
		const yaml = spec('      file: "${CRED}"');
		expect(check(yaml, { CRED: VICTIM }).forbidden).toHaveLength(1);
		expect(check(yaml, { CRED: "./cred.json" })).toEqual(clean);
		expect(
			check(spec('      file: "${DIR}/spec.json"'), { DIR: STORAGE }).forbidden,
		).toHaveLength(1);
	});

	it("refuses a variable it cannot resolve when the env file cannot be read", () => {
		expect(
			check(spec('      file: "${CRED}"'), null, true).unresolved,
		).toHaveLength(1);
	});
});

describe("pre_start hooks and jobs", () => {
	it("checks the volumes of a pre_start hook like a service's", () => {
		const yaml = service(`    pre_start:
      - image: alpine
        command: ls
        volumes:
          - "${VICTIM}:/x"
      - image: alpine
        volumes:
          - type: bind
            source: /var/lib/docker
            target: /y
`);
		const result = check(yaml);
		expect(result.forbidden).toEqual([`bind mount "${VICTIM}"`]);
		expect(result.forbiddenParents).toEqual(['bind mount "/var/lib/docker"']);
	});

	it("checks the host paths of a pre_start hook and of a job", () => {
		const yaml = `
services:
  web:
    image: nginx
    pre_start:
      - image: alpine
        env_file: ${VICTIM}/.env
        credential_spec:
          file: ${VICTIM}
jobs:
  nightly:
    image: alpine
    build: ${VICTIM}
    label_file: ${STORAGE}
    volumes:
      - "/var:/data"
    triggers:
      manual: true
`;
		const result = check(yaml);
		expect(result.forbidden).toEqual(
			expect.arrayContaining([
				`env_file "${VICTIM}/.env"`,
				`credential_spec file "${VICTIM}"`,
				`build context "${VICTIM}"`,
				`label_file "${STORAGE}"`,
			]),
		);
		expect(result.forbiddenParents).toEqual(['bind mount "/var"']);
	});

	it("names a pre_start hook that reaches for a container's volumes", () => {
		expect(
			check(
				service(`    pre_start:
      - image: alpine
        volumes_from:
          - container:other
`),
			).unresolved,
		).toEqual(['service "web" pre_start[0] (volumes_from a container)']);
	});

	it("lets ordinary hooks and jobs through", () => {
		expect(
			check(`
services:
  web:
    image: nginx
    pre_start:
      - image: alpine
        command: ["migrate"]
        volumes:
          - ./data:/data
        env_file: .env
jobs:
  nightly:
    image: alpine
    volumes:
      - ./data:/data
    triggers:
      schedule:
        - "0 3 * * *"
`),
		).toEqual(clean);
	});
});

describe("assertComposeVolumesBound", () => {
	const deploy = (file: string, row = {}) =>
		assertComposeVolumesBound(composeRow(file, row));

	it("refuses a provider service at deploy, with a message that names it", async () => {
		await expect(
			deploy(`
services:
  x:
    provider:
      type: /bin/sh
      options:
        c: id
`),
		).rejects.toThrow(
			/Compose refused: service "x" \(provider type "\/bin\/sh"\) declares a provider/,
		);
		expect(mocks.warn).toHaveBeenCalled();
	});

	it("refuses a provider through an anchor, a variable and a stack", async () => {
		await expect(
			deploy(`
x-base: &base
  provider:
    type: awesomecloud
services:
  x:
    <<: *base
`),
		).rejects.toThrow(/declares a provider/);
		await expect(
			deploy(
				`
services:
  x:
    provider:
      type: \${TYPE}
`,
				{ env: "TYPE=safe" },
			),
		).rejects.toThrow(/declares a provider/);
		await expect(
			deploy(
				`
services:
  x:
    provider:
      type: /bin/sh
`,
				{ composeType: "stack" },
			),
		).rejects.toThrow(/declares a provider/);
	});

	it("refuses a provider before it reads anything else about the compose", async () => {
		mocks.readDotenv.mockRejectedValue(fsError("EACCES"));
		await expect(
			deploy(
				`
services:
  x:
    provider:
      type: \${TYPE}
`,
				{ createEnvFile: false },
			),
		).rejects.toThrow(/declares a provider/);
	});

	it("is checked on save for a raw compose too", async () => {
		await expect(
			assertComposeFileVolumesBound(
				composeRow("") as never,
				`
services:
  x:
    provider:
      type: /bin/sh
`,
			),
		).rejects.toThrow(/declares a provider/);
		await expect(
			assertComposeFileVolumesBound(
				composeRow("") as never,
				service("    environment:\n      A: b"),
			),
		).resolves.toBeUndefined();
	});

	it("refuses credential_spec.file in the storage, and lets a safe one deploy", async () => {
		await expect(
			deploy(
				service("    credential_spec:\n      file: /var/lib/docker/volumes/x"),
			),
		).rejects.toThrow(
			/Compose volume refused: credential_spec file "\/var\/lib\/docker\/volumes\/x" is Docker's own volume storage/,
		);
		await expect(
			deploy(service("    credential_spec:\n      file: ./cred.json")),
		).resolves.toBeUndefined();
		await expect(
			deploy(service("    credential_spec:\n      config: my_credential_spec")),
		).resolves.toBeUndefined();
	});

	it("resolves a credential_spec variable from the Environment tab", async () => {
		await expect(
			deploy(service('    credential_spec:\n      file: "${CRED}"'), {
				env: `CRED=${VICTIM}`,
			}),
		).rejects.toThrow(/credential_spec file/);
		await expect(
			deploy(service('    credential_spec:\n      file: "${CRED}"'), {
				env: "CRED=./cred.json",
			}),
		).resolves.toBeUndefined();
	});

	it("resolves a credential_spec variable from the .env of the project directory", async () => {
		const yaml = service('    credential_spec:\n      file: "${CRED}"');
		mocks.readDotenv.mockImplementation(async (path: string) => {
			if (path === `${CODE}/.env`) {
				return `CRED=${VICTIM}\n`;
			}
			throw fsError("ENOENT");
		});
		await expect(deploy(yaml, { createEnvFile: false })).rejects.toThrow(
			/credential_spec file/,
		);
		mocks.readDotenv.mockImplementation(async (path: string) => {
			if (path === `${CODE}/.env`) {
				return "CRED=./cred.json\n";
			}
			throw fsError("ENOENT");
		});
		await expect(
			deploy(yaml, { createEnvFile: false }),
		).resolves.toBeUndefined();
		mocks.readDotenv.mockRejectedValue(fsError("EACCES"));
		await expect(deploy(yaml, { createEnvFile: false })).rejects.toThrow(
			/Compose volume check failed/,
		);
	});

	it("refuses a pre_start volume of the storage at deploy", async () => {
		await expect(
			deploy(
				service(`    pre_start:
      - image: alpine
        volumes:
          - "${VICTIM}:/x"`),
			),
		).rejects.toThrow(/Docker's own volume storage/);
	});
});
