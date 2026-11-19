import { parse } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A transfer is checked before it stops or copies anything (T-16187): the
 * checks of transfer-safety.ts are run by transferService and previewTransfer
 * with a stored service, and a refusal leaves the service running where it is.
 */
const mocks = vi.hoisted(() => {
	const fn = () => vi.fn();
	return {
		findPostgresById: fn(),
		updatePostgresById: fn(),
		deployPostgres: fn(),
		findComposeById: fn(),
		updateCompose: fn(),
		stopCompose: fn(),
		startCompose: fn(),
		removeCompose: fn(),
		deployCompose: fn(),
		findServerById: fn(),
		getWebServerSettings: fn(),
		findRefusedVolumeMounts: fn(),
		findRefusedComposeVolumes: fn(),
		execAsync: fn(),
		execAsyncRemote: fn(),
		pipeBetweenServers: fn(),
		removeService: fn(),
		loadDockerCompose: fn(),
		loadDockerComposeRemote: fn(),
	};
});

const none = () => vi.fn();

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { network: { findMany: vi.fn(async () => []) } },
		update: vi.fn(() => ({
			set: () => ({ where: async () => undefined }),
		})),
	},
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	removeService: mocks.removeService,
}));
vi.mock("@dokploy/server/utils/filesystem/directory", () => ({
	removeDirectoryCode: none(),
	removeMonitoringDirectory: none(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/utils/process/remoteStream", () => ({
	pipeBetweenServers: mocks.pipeBetweenServers,
}));
vi.mock("@dokploy/server/utils/traefik/application", () => ({
	readConfig: none(),
	readRemoteConfig: none(),
	removeTraefikConfig: none(),
	writeConfig: none(),
	writeConfigRemote: none(),
}));
vi.mock("@dokploy/server/utils/traefik/domain", () => ({
	manageDomain: none(),
}));
vi.mock("@dokploy/server/utils/traefik/forward-auth", () => ({
	removeForwardAuthMiddleware: none(),
}));
vi.mock("@dokploy/server/utils/traefik/middleware", () => ({
	deleteAllMiddlewares: none(),
	removePathMiddlewares: none(),
}));
vi.mock("@dokploy/server/utils/traefik/redirect", () => ({
	createRedirectMiddleware: none(),
}));
vi.mock("@dokploy/server/utils/traefik/security", () => ({
	createSecurityMiddleware: none(),
}));
vi.mock("@dokploy/server/utils/docker/domain", () => ({
	loadDockerCompose: mocks.loadDockerCompose,
	loadDockerComposeRemote: mocks.loadDockerComposeRemote,
}));
vi.mock("@dokploy/server/services/application", () => ({
	deployApplication: none(),
	findApplicationById: none(),
	updateApplication: none(),
}));
vi.mock("@dokploy/server/services/compose", () => ({
	deployCompose: mocks.deployCompose,
	findComposeById: mocks.findComposeById,
	removeCompose: mocks.removeCompose,
	startCompose: mocks.startCompose,
	stopCompose: mocks.stopCompose,
	updateCompose: mocks.updateCompose,
}));
vi.mock("@dokploy/server/services/libsql", () => ({
	deployLibsql: none(),
	findLibsqlById: none(),
	updateLibsqlById: none(),
}));
vi.mock("@dokploy/server/services/mariadb", () => ({
	deployMariadb: none(),
	findMariadbById: none(),
	updateMariadbById: none(),
}));
vi.mock("@dokploy/server/services/mongo", () => ({
	deployMongo: none(),
	findMongoById: none(),
	updateMongoById: none(),
}));
vi.mock("@dokploy/server/services/mount", () => ({
	createFileMount: none(),
}));
vi.mock("@dokploy/server/services/mysql", () => ({
	deployMySql: none(),
	findMySqlById: none(),
	updateMySqlById: none(),
}));
vi.mock("@dokploy/server/services/postgres", () => ({
	deployPostgres: mocks.deployPostgres,
	findPostgresById: mocks.findPostgresById,
	updatePostgresById: mocks.updatePostgresById,
}));
vi.mock("@dokploy/server/services/redis", () => ({
	deployRedis: none(),
	findRedisById: none(),
	updateRedisById: none(),
}));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));
vi.mock("@dokploy/server/services/volume-binding", () => ({
	findRefusedVolumeMounts: mocks.findRefusedVolumeMounts,
	findRefusedComposeVolumes: mocks.findRefusedComposeVolumes,
}));

const {
	directoryExportCommand,
	directoryImportCommand,
	previewTransfer,
	transferService,
	volumeExportCommand,
	volumeImportCommand,
} = await import("@dokploy/server/services/transfer");

const OWNER = { privilegedRole: true, localHostReach: true };
const MEMBER = { privilegedRole: false, localHostReach: false };

const postgres = (overrides: Record<string, unknown> = {}) => ({
	postgresId: "pg-1",
	appName: "pg-x",
	serverId: null,
	server: null,
	mounts: [{ type: "volume", volumeName: "pgdata", mountId: "m-1" }],
	environment: { project: { organizationId: "org-1" } },
	...overrides,
});

const request = (overrides: Record<string, unknown> = {}) =>
	({
		serviceType: "postgres",
		serviceId: "pg-1",
		targetServerId: "server-target",
		removeSourceData: false,
		overwriteTargets: [],
		organizationId: "org-1",
		caller: OWNER,
		...overrides,
	}) as Parameters<typeof transferService>[0];

// What the hosts say. The target answers the volume and directory questions of
// the pre-flight; everything else is a command the transfer itself runs.
const hosts = (target: { volume?: string; directory?: string } = {}) => {
	const ask = (command: string) => {
		if (command.includes("docker volume ls")) {
			return { stdout: "", stderr: "" };
		}
		if (command.includes("docker volume inspect")) {
			return { stdout: `${target.volume ?? "missing"}\n`, stderr: "" };
		}
		if (command.startsWith("if [ ! -d")) {
			return { stdout: `${target.directory ?? "missing"}\n`, stderr: "" };
		}
		if (command.startsWith("[ -d")) {
			return { stdout: "yes\n", stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};
	mocks.execAsync.mockImplementation(async (command: string) => ask(command));
	mocks.execAsyncRemote.mockImplementation(
		async (_serverId: string, command: string) => ask(command),
	);
};

const commandsRun = () => [
	...mocks.execAsync.mock.calls.map((call) => String(call[0])),
	...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1])),
];

const nothingMoved = () => {
	expect(mocks.pipeBetweenServers).not.toHaveBeenCalled();
	expect(mocks.updatePostgresById).not.toHaveBeenCalled();
	expect(mocks.deployPostgres).not.toHaveBeenCalled();
	expect(mocks.stopCompose).not.toHaveBeenCalled();
	expect(mocks.removeService).not.toHaveBeenCalled();
	expect(
		commandsRun().filter((c) => c.includes("docker service scale")),
	).toEqual([]);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findPostgresById.mockResolvedValue(postgres());
	mocks.findServerById.mockResolvedValue({
		serverId: "server-target",
		name: "Target",
		organizationId: "org-1",
		serverStatus: "active",
		serverType: "deploy",
	});
	mocks.getWebServerSettings.mockResolvedValue({ remoteServersOnly: false });
	mocks.findRefusedVolumeMounts.mockResolvedValue([]);
	mocks.findRefusedComposeVolumes.mockResolvedValue([]);
	mocks.pipeBetweenServers.mockResolvedValue(1024);
	mocks.updatePostgresById.mockResolvedValue({});
	mocks.deployPostgres.mockResolvedValue(undefined);
	hosts();
});

describe("transferService refuses before it moves anything", () => {
	it("a volume that holds data on the target", async () => {
		hosts({ volume: "non-empty" });
		const log = vi.fn();
		await expect(transferService(request(), log)).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining('"pgdata"'),
		});
		nothingMoved();
		expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Stopping"));
	});

	it("goes ahead when the caller names the volume to write over", async () => {
		hosts({ volume: "non-empty" });
		await transferService(request({ overwriteTargets: ["pgdata"] }), vi.fn());
		expect(mocks.pipeBetweenServers).toHaveBeenCalledTimes(1);
		expect(mocks.pipeBetweenServers.mock.calls[0]?.[0]).toMatchObject({
			source: { serverId: null, command: volumeExportCommand("pgdata") },
			target: {
				serverId: "server-target",
				command: volumeImportCommand("pgdata"),
			},
		});
		expect(mocks.deployPostgres).toHaveBeenCalled();
	});

	it("looks at the target before it stops the service", async () => {
		hosts({ volume: "empty" });
		await transferService(request(), vi.fn());
		const order = (needle: string) => {
			const calls = [
				...mocks.execAsync.mock.calls.map((call, index) => ({
					text: String(call[0]),
					at: mocks.execAsync.mock.invocationCallOrder[index] ?? 0,
				})),
				...mocks.execAsyncRemote.mock.calls.map((call, index) => ({
					text: String(call[1]),
					at: mocks.execAsyncRemote.mock.invocationCallOrder[index] ?? 0,
				})),
			];
			return calls.find((call) => call.text.includes(needle))?.at ?? 0;
		};
		const checked = order("docker volume inspect");
		const stopped = order("docker service scale");
		expect(checked).toBeGreaterThan(0);
		expect(stopped).toBeGreaterThan(checked);
	});

	it("an empty or missing volume needs no say-so", async () => {
		for (const volume of ["missing", "empty"]) {
			vi.clearAllMocks();
			mocks.findPostgresById.mockResolvedValue(postgres());
			mocks.findServerById.mockResolvedValue({
				name: "Target",
				organizationId: "org-1",
				serverStatus: "active",
				serverType: "deploy",
			});
			mocks.getWebServerSettings.mockResolvedValue({
				remoteServersOnly: false,
			});
			mocks.findRefusedVolumeMounts.mockResolvedValue([]);
			mocks.pipeBetweenServers.mockResolvedValue(1);
			mocks.updatePostgresById.mockResolvedValue({});
			hosts({ volume });
			await transferService(request(), vi.fn());
			expect(mocks.pipeBetweenServers).toHaveBeenCalledTimes(1);
		}
	});

	it("the Dokploy server as the target while remote servers only is on", async () => {
		mocks.getWebServerSettings.mockResolvedValue({ remoteServersOnly: true });
		mocks.findPostgresById.mockResolvedValue(
			postgres({ serverId: "server-source", server: { name: "Source" } }),
		);
		await expect(
			transferService(request({ targetServerId: null }), vi.fn()),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("remote servers only"),
		});
		nothingMoved();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("the Dokploy server as the target when the instance takes services on it", async () => {
		mocks.findPostgresById.mockResolvedValue(
			postgres({ serverId: "server-source", server: { name: "Source" } }),
		);
		await transferService(request({ targetServerId: null }), vi.fn());
		expect(mocks.pipeBetweenServers).toHaveBeenCalledTimes(1);
	});

	it("a volume name that is not a Docker volume name", async () => {
		const hostile = "x;touch /tmp/pwn";
		mocks.findPostgresById.mockResolvedValue(
			postgres({
				mounts: [{ type: "volume", volumeName: hostile, mountId: "m-1" }],
			}),
		);
		await expect(transferService(request(), vi.fn())).rejects.toMatchObject({
			message: expect.stringContaining("not a valid Docker volume name"),
		});
		nothingMoved();
		for (const command of commandsRun()) {
			expect(command).not.toContain("touch");
		}
	});

	it("a volume the binding check refuses", async () => {
		mocks.findRefusedVolumeMounts.mockResolvedValue([
			{ volumeName: "pgdata", message: 'Volume "pgdata" is refused.' },
		]);
		await expect(transferService(request(), vi.fn())).rejects.toThrow(
			'Volume "pgdata" is refused.',
		);
		nothingMoved();
	});

	it("a bind mount of a system directory", async () => {
		mocks.findPostgresById.mockResolvedValue(
			postgres({
				mounts: [{ type: "bind", hostPath: "/etc", mountId: "m-1" }],
			}),
		);
		await expect(transferService(request(), vi.fn())).rejects.toThrow(
			"system directory",
		);
		nothingMoved();
	});

	it("a bind mount asked for by a member", async () => {
		mocks.findPostgresById.mockResolvedValue(
			postgres({
				mounts: [{ type: "bind", hostPath: "/srv/data", mountId: "m-1" }],
			}),
		);
		await expect(
			transferService(request({ caller: MEMBER }), vi.fn()),
		).rejects.toThrow("Only an owner or admin can create bind mounts");
		nothingMoved();
	});

	it("keeps refusing a service of another organization", async () => {
		mocks.findPostgresById.mockResolvedValue(
			postgres({
				environment: { project: { organizationId: "org-other" } },
			}),
		);
		await expect(transferService(request(), vi.fn())).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("previewTransfer", () => {
	it("lists the volumes, the conflicts and the refusal, and changes nothing", async () => {
		hosts({ volume: "non-empty" });
		const preview = await previewTransfer(request());
		expect(preview).toMatchObject({
			sourceName: "Dokploy Server",
			targetName: "Target",
			volumes: [{ name: "pgdata", targetState: "non-empty", overwrite: false }],
			needsOverwrite: ["pgdata"],
			blockers: [],
			refused: expect.stringContaining("overwriteTargets"),
		});
		nothingMoved();
		for (const command of commandsRun()) {
			expect(command).not.toMatch(/docker volume (create|rm)|rm -rf|tar -x/);
		}
	});

	it("has no refusal once the volume is named", async () => {
		hosts({ volume: "non-empty" });
		const preview = await previewTransfer(
			request({ overwriteTargets: ["pgdata"] }),
		);
		expect(preview.refused).toBeNull();
		expect(preview.needsOverwrite).toEqual([]);
	});

	it("says the Dokploy server is refused as a target", async () => {
		mocks.getWebServerSettings.mockResolvedValue({ remoteServersOnly: true });
		mocks.findPostgresById.mockResolvedValue(
			postgres({ serverId: "server-source", server: { name: "Source" } }),
		);
		await expect(
			previewTransfer(request({ targetServerId: null })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("still checks that the service belongs to the organization", async () => {
		mocks.findPostgresById.mockResolvedValue(
			postgres({
				environment: { project: { organizationId: "org-other" } },
			}),
		);
		await expect(previewTransfer(request())).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});

	describe("of a compose", () => {
		const compose = {
			composeId: "comp-1",
			appName: "stack-x",
			serverId: null,
			server: null,
			composeType: "docker-compose",
			mounts: [{ type: "bind", hostPath: "/srv/stored", mountId: "m-1" }],
			environment: { project: { organizationId: "org-1" } },
		};

		beforeEach(() => {
			mocks.findComposeById.mockResolvedValue(compose);
			mocks.loadDockerCompose.mockResolvedValue({
				services: {
					web: {
						volumes: ["/srv/stored:/a", "/srv/left-behind:/b", "data:/c"],
					},
				},
			});
		});

		const composeRequest = (overrides: Record<string, unknown> = {}) =>
			request({ serviceType: "compose", serviceId: "comp-1", ...overrides });

		it("reports the host paths its file binds that will not be copied", async () => {
			const preview = await previewTransfer(composeRequest());
			expect(preview.composeBindScan).toEqual({ scanned: true, note: null });
			expect(preview.composeHostBinds).toEqual([
				{
					service: "web",
					source: "/srv/left-behind",
					target: "/b",
					kind: "absolute",
				},
			]);
			expect(preview.bindMounts.map((bind) => bind.hostPath)).toEqual([
				"/srv/stored",
			]);
			expect(mocks.stopCompose).not.toHaveBeenCalled();
		});

		it("reads the file of a compose on a remote server there", async () => {
			mocks.findComposeById.mockResolvedValue({
				...compose,
				serverId: "server-source",
				server: { name: "Source" },
			});
			mocks.loadDockerComposeRemote.mockResolvedValue({
				services: { web: { volumes: ["/srv/remote:/a"] } },
			});
			const preview = await previewTransfer(
				composeRequest({ targetServerId: null }),
			);
			expect(mocks.loadDockerComposeRemote).toHaveBeenCalled();
			expect(mocks.loadDockerCompose).not.toHaveBeenCalled();
			expect(preview.composeHostBinds.map((bind) => bind.source)).toEqual([
				"/srv/remote",
			]);
		});

		it("says so when the file cannot be read, and is not refused for it", async () => {
			mocks.loadDockerCompose.mockRejectedValue(new Error("link out\nof tree"));
			const preview = await previewTransfer(composeRequest());
			expect(preview.composeBindScan).toEqual({
				scanned: false,
				note: "The compose file could not be read: link out",
			});
			expect(preview.refused).toBeNull();
		});

		it("says so when the compose has not been deployed", async () => {
			mocks.loadDockerCompose.mockResolvedValue(null);
			const preview = await previewTransfer(composeRequest());
			expect(preview.composeBindScan.scanned).toBe(false);
			expect(preview.composeBindScan.note).toContain("not been deployed");
		});

		it("warns in the transfer log about the paths it leaves behind", async () => {
			mocks.updateCompose.mockResolvedValue({});
			mocks.deployCompose.mockResolvedValue(undefined);
			mocks.removeCompose.mockResolvedValue(undefined);
			mocks.stopCompose.mockResolvedValue(undefined);
			const log = vi.fn();
			await transferService(composeRequest(), log);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining('will NOT be copied: web: "/srv/left-behind"'),
			);
		});
	});
});

describe("the commands a transfer sends to a host quote what they are given", () => {
	const hostile = "x;touch${IFS}/tmp/pwn";

	it.each([
		["volume export", volumeExportCommand],
		["volume import", volumeImportCommand],
		["directory export", directoryExportCommand],
		["directory import", directoryImportCommand],
	])("%s", (_name, build) => {
		const tokens = parse(build(hostile));
		const words = tokens.filter((token) => typeof token === "string");
		// The name is one word of the command, whole or as the front of a
		// `name:/data` pair, and no operator carries any of it.
		expect(
			words.some((word) => word === hostile || word.startsWith(`${hostile}:`)),
		).toBe(true);
		for (const token of tokens) {
			if (typeof token === "object") {
				expect(JSON.stringify(token)).not.toContain("touch");
			}
		}
	});
});
