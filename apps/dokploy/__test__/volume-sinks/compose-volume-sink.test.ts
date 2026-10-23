import { beforeEach, describe, expect, it, vi } from "vitest";

// A compose file can name any Docker volume on the host (T-6822). The final
// YAML a deploy would write is checked against the same claims as a stored
// mount (#460). The database facts are scripted; the decision is the real one.
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

const { assertComposeVolumesBound } = await import(
	"@dokploy/server/services/compose-volume-binding"
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

const foreignMount = (organizationId: string, serviceKey = "mariadb") => ({
	mountId: "mount-other",
	[`${serviceKey}Id`]: "svc-other",
	[serviceKey]: {
		appName: "other-app",
		serverId: null,
		...orgOf(organizationId),
	},
});

const REFUSED = /^Compose volume ".+" is refused/;

const VICTIM_EXTERNAL = `
services:
  web:
    volumes:
      - victim:/data
volumes:
  victim:
    external: true
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

describe("compose file volumes at deploy", () => {
	it("refuses an external volume another organization mounts", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([foreignMount("org-b")]);

		await expect(
			assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL)),
		).rejects.toThrow(REFUSED);
		expect(mocks.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				volumeName: "victim",
				conflictingRows: [{ source: "mount", id: "mount-other" }],
			}),
			expect.stringContaining("compose file volume was refused"),
		);
	});

	it("refuses name: pointing at another organization's volume, without external", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			{
				volumeBackupId: "vb-b",
				postgresId: "pg-b",
				postgres: { appName: "pg-b", serverId: null, ...orgOf("org-b") },
			},
		]);

		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: pg-b-data
`),
			),
		).rejects.toThrow(/Compose volume "pg-b-data" is refused/);
	});

	it("refuses a short-syntax reference to a volume in another organization's appName namespace", async () => {
		mocks.query.postgres.findMany.mockResolvedValue([
			{ appName: "postgres-b-Zz9999", serverId: null, ...orgOf("org-b") },
		]);

		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - theirs:/data:ro
volumes:
  theirs:
    external:
      name: postgres-b-Zz9999-data
`),
			),
		).rejects.toThrow(/postgres-b-Zz9999-data/);
	});

	it("refuses a volume another service of the same organization mounts", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([foreignMount("org-a")]);

		await expect(
			assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL)),
		).rejects.toThrow(/Compose volume "victim" is refused/);
	});

	it("refuses a volume in the appName namespace of another service of the same organization", async () => {
		mocks.query.applications.findMany.mockResolvedValue([
			{ appName: "app-sibling-Qq1111", serverId: null, ...orgOf("org-a") },
		]);

		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: app-sibling-Qq1111-data
`),
			),
		).rejects.toThrow(/app-sibling-Qq1111-data/);
	});

	it("refuses Dokploy's own volumes", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - pg:/data
volumes:
  pg:
    external: true
    name: dokploy-postgres
`),
			),
		).rejects.toThrow(/dokploy-postgres/);
	});

	it("allows the compose's own prefixed volumes without asking who else uses them", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
      - type: volume
        source: cache
        target: /cache
volumes:
  data:
  cache:
`),
			),
		).resolves.toBeUndefined();
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("allows the compose's own volumes despite another organization's stale volume backup row", async () => {
		mocks.query.volumeBackups.findMany.mockResolvedValue([
			{
				volumeBackupId: "vb-stale",
				mariadbId: "m-b",
				mariadb: { appName: "x", serverId: null, ...orgOf("org-b") },
			},
		]);

		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
`),
			),
		).resolves.toBeUndefined();
	});

	it("allows a volume of its own namespace declared with name:", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: ${APP}-custom
`),
			),
		).resolves.toBeUndefined();
	});

	it("allows an anonymous volume, a bind mount and a tmpfs", async () => {
		await expect(
			assertComposeVolumesBound(
				composeRow(`
services:
  web:
    volumes:
      - /var/lib/anonymous
      - ./site:/usr/share/nginx/html:ro
      - /var/run/docker.sock:/var/run/docker.sock
      - type: bind
        source: /srv/data
        target: /data
      - type: tmpfs
        target: /tmp
`),
			),
		).resolves.toBeUndefined();
		expect(mocks.query.mounts.findMany).not.toHaveBeenCalled();
	});

	it("allows an unrecorded outside volume nothing claims", async () => {
		await expect(
			assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL)),
		).resolves.toBeUndefined();
	});

	it("allows an outside volume the compose itself records as a mount", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				mountId: "mount-own",
				composeId: "compose-1",
				compose: { appName: APP, serverId: null, ...orgOf("org-a") },
			},
			foreignMount("org-a"),
		]);

		await expect(
			assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL)),
		).resolves.toBeUndefined();
	});

	it("ignores another server's claims", async () => {
		mocks.query.mounts.findMany.mockResolvedValue([
			{
				...foreignMount("org-b"),
				mariadb: { appName: "m", serverId: "server-2", ...orgOf("org-b") },
			},
		]);

		await expect(
			assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL)),
		).resolves.toBeUndefined();
	});

	describe("stack mode", () => {
		it("refuses an external foreign volume", async () => {
			mocks.query.mounts.findMany.mockResolvedValue([foreignMount("org-b")]);

			await expect(
				assertComposeVolumesBound(
					composeRow(VICTIM_EXTERNAL, {
						composeType: "stack",
						createEnvFile: false,
					}),
				),
			).rejects.toThrow(REFUSED);
		});

		it("allows the stack's own <stackName>_<key> volumes", async () => {
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
`,
						{ composeType: "stack" },
					),
				),
			).resolves.toBeUndefined();
		});

		it("resolves stack variables from the service environment", async () => {
			mocks.query.mounts.findMany.mockResolvedValue([foreignMount("org-b")]);

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
    name: \${TARGET}
`,
						{ composeType: "stack", env: "TARGET=victim" },
					),
				),
			).rejects.toThrow(/Compose volume "victim" is refused/);
		});
	});

	describe("isolatedDeployment", () => {
		const isolated = {
			isolatedDeployment: true,
			isolatedDeploymentsVolume: true,
		};

		it("still refuses an explicit foreign name, which the suffix does not touch", async () => {
			mocks.query.mounts.findMany.mockResolvedValue([foreignMount("org-b")]);

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
    name: victim
`,
						isolated,
					),
				),
			).rejects.toThrow(/Compose volume "victim" is refused/);
		});

		it("checks the renamed external key, not the typed one", async () => {
			// Every name is claimed here: the refusal names the key as the isolated
			// file mounts it (`victim-<appName>`), not as it was typed.
			mocks.query.mounts.findMany.mockResolvedValue([foreignMount("org-b")]);

			await expect(
				assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL, isolated)),
			).rejects.toThrow(`Compose volume "victim-${APP}" is refused`);
		});

		it("allows the isolated compose's own volumes", async () => {
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
`,
						isolated,
					),
				),
			).resolves.toBeUndefined();
		});
	});

	describe("what cannot be checked", () => {
		it("refuses a volume name that depends on a variable Dokploy does not provide", async () => {
			await expect(
				assertComposeVolumesBound(
					composeRow(`
services:
  web:
    volumes:
      - data:/data
volumes:
  data:
    name: \${FROM_DOT_ENV}
`),
				),
			).rejects.toThrow(/Compose volume check failed/);
		});

		it("trusts no variable when the compose reads a .env Dokploy does not write", async () => {
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
    name: \${TARGET:-safe}
`,
						{ createEnvFile: false, env: "TARGET=safe" },
					),
				),
			).rejects.toThrow(/Compose volume check failed/);
		});

		it("refuses include and volumes_from a container", async () => {
			await expect(
				assertComposeVolumesBound(
					composeRow(`
include:
  - /srv/other/compose.yml
services:
  web:
    image: nginx
`),
				),
			).rejects.toThrow(/Compose volume check failed/);
			await expect(
				assertComposeVolumesBound(
					composeRow(`
services:
  web:
    image: nginx
    volumes_from:
      - container:victim-db-1
`),
				),
			).rejects.toThrow(/Compose volume check failed/);
		});

		it("fails closed when the compose cannot be resolved", async () => {
			mocks.query.compose.findFirst.mockResolvedValue(undefined);

			await expect(
				assertComposeVolumesBound(composeRow(VICTIM_EXTERNAL)),
			).rejects.toThrow(/Compose volume "victim" is refused/);
		});
	});

	describe("custom command", () => {
		const yaml = `
services:
  web:
    image: nginx
`;

		it("refuses a command that uses another compose file", async () => {
			await expect(
				assertComposeVolumesBound(
					composeRow(yaml, {
						command:
							"compose -p compose-x-AbC123 -f other.yml up -d --remove-orphans",
					}),
				),
			).rejects.toThrow(/Compose command refused/);
			await expect(
				assertComposeVolumesBound(
					composeRow(yaml, {
						command: "compose -p x --file=/srv/other.yml up -d",
					}),
				),
			).rejects.toThrow(/Compose command refused/);
		});

		it("allows a command that uses the deployed file", async () => {
			await expect(
				assertComposeVolumesBound(
					composeRow(yaml, {
						command:
							"compose -p compose-x-AbC123 -f ./docker-compose.yml up -d && docker compose -p compose-x-AbC123 -f docker-compose.yml logs",
					}),
				),
			).resolves.toBeUndefined();
		});
	});
});
