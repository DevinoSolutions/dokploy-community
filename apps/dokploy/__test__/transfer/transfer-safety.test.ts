import { parse } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The checks a transfer makes before it moves anything (T-16187): the Dokploy
 * server as a target, volumes and directories the target already holds, names
 * that are not Docker volume names, host paths that may not be copied, and
 * the host paths of a compose file that are left behind.
 */
const state = vi.hoisted(() => ({ isCloud: false }));

const mocks = vi.hoisted(() => ({
	getWebServerSettings: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findRefusedVolumeMounts: vi.fn(),
	findRefusedComposeVolumes: vi.fn(),
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		get IS_CLOUD() {
			return state.isCloud;
		},
	};
});

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));

vi.mock("@dokploy/server/services/volume-binding", () => ({
	findRefusedVolumeMounts: mocks.findRefusedVolumeMounts,
	findRefusedComposeVolumes: mocks.findRefusedComposeVolumes,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const {
	assertTransferPlanAllowed,
	assertTransferTargetAllowed,
	describeTransferRefusal,
	directoryStateCommand,
	inspectTransferPlan,
	isDockerVolumeName,
	scanComposeHostBinds,
	volumeStateCommand,
} = await import("@dokploy/server/services/transfer-safety");

const OWNER = { privilegedRole: true, localHostReach: true };

const input = (overrides: Record<string, unknown> = {}) =>
	({
		serviceType: "application",
		serviceId: "app-1",
		appName: "app-one-x",
		volumes: [] as string[],
		bindMounts: [] as string[],
		isCompose: false,
		sourceServerId: "server-source",
		targetServerId: "server-target",
		overwriteTargets: [] as string[],
		caller: OWNER,
		...overrides,
	}) as Parameters<typeof inspectTransferPlan>[0];

// The state each volume or directory is in on the target, by name.
const targetHolds = (answers: Record<string, string>) => {
	const answer = async (_server: unknown, command: string) => {
		for (const [name, stdout] of Object.entries(answers)) {
			if (command.includes(name)) {
				return { stdout: `${stdout}\n`, stderr: "" };
			}
		}
		return { stdout: "missing\n", stderr: "" };
	};
	mocks.execAsyncRemote.mockImplementation(answer);
	mocks.execAsync.mockImplementation((command: string) =>
		answer(null, command),
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	state.isCloud = false;
	mocks.getWebServerSettings.mockResolvedValue({ remoteServersOnly: false });
	mocks.findRefusedVolumeMounts.mockResolvedValue([]);
	mocks.findRefusedComposeVolumes.mockResolvedValue([]);
	mocks.execAsync.mockResolvedValue({ stdout: "missing\n", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "missing\n", stderr: "" });
});

describe("the Dokploy server as a target", () => {
	it("refuses it while the instance is set to remote servers only", async () => {
		mocks.getWebServerSettings.mockResolvedValue({ remoteServersOnly: true });
		await expect(assertTransferTargetAllowed(null)).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("remote servers only"),
		});
	});

	it("allows it when the instance takes services on its own host", async () => {
		await expect(assertTransferTargetAllowed(null)).resolves.toBeUndefined();
	});

	it("refuses it when the settings cannot be read or are missing", async () => {
		mocks.getWebServerSettings.mockResolvedValue(undefined);
		await expect(assertTransferTargetAllowed(null)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		mocks.getWebServerSettings.mockRejectedValue(new Error("db down"));
		await expect(assertTransferTargetAllowed(null)).rejects.toThrow("db down");
	});

	it("refuses it on Dokploy Cloud", async () => {
		state.isCloud = true;
		await expect(assertTransferTargetAllowed(null)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("does not ask the settings about a remote server", async () => {
		mocks.getWebServerSettings.mockResolvedValue({ remoteServersOnly: true });
		await expect(
			assertTransferTargetAllowed("server-target"),
		).resolves.toBeUndefined();
		expect(mocks.getWebServerSettings).not.toHaveBeenCalled();
	});
});

describe("volume names", () => {
	it.each(["data", "app_1-db.data", "A9", "a".repeat(255)])(
		"accepts %s",
		(name) => {
			expect(isDockerVolumeName(name)).toBe(true);
		},
	);

	it.each([
		"",
		"/",
		"/etc",
		"../x",
		"-v",
		".hidden",
		"a b",
		"a;touch /tmp/pwn",
		"$(id)",
		"`id`",
		"a\nb",
		"a'b",
		'a"b',
		"a".repeat(256),
	])("refuses %j and never puts it in a command", async (name) => {
		expect(isDockerVolumeName(name)).toBe(false);
		const plan = await inspectTransferPlan(input({ volumes: [name] }));
		expect(plan.blockers.join(" ")).toContain("not a valid Docker volume name");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(() => assertTransferPlanAllowed(plan)).toThrow(
			"Transfer refused before anything was moved",
		);
	});
});

describe("what the target already holds", () => {
	it("refuses a volume that holds data on the target", async () => {
		targetHolds({ pgdata: "non-empty" });
		const plan = await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		expect(plan.needsOverwrite).toEqual(["pgdata"]);
		expect(plan.volumes).toEqual([
			{ name: "pgdata", targetState: "non-empty", overwrite: false },
		]);
		expect(() => assertTransferPlanAllowed(plan)).toThrow(
			expect.objectContaining({
				code: "CONFLICT",
				message: expect.stringContaining('"pgdata"'),
			}),
		);
	});

	it("looks on the target server, not the source", async () => {
		targetHolds({ pgdata: "non-empty" });
		await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-target",
			volumeStateCommand("pgdata"),
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalledWith(
			"server-source",
			expect.anything(),
		);
	});

	it("looks on the Dokploy host when that is the target", async () => {
		targetHolds({ pgdata: "non-empty" });
		const plan = await inspectTransferPlan(
			input({ volumes: ["pgdata"], targetServerId: null }),
		);
		expect(mocks.execAsync).toHaveBeenCalledWith(volumeStateCommand("pgdata"));
		expect(plan.needsOverwrite).toEqual(["pgdata"]);
	});

	it("lets the transfer through when the caller names the volume", async () => {
		targetHolds({ pgdata: "non-empty" });
		const plan = await inspectTransferPlan(
			input({ volumes: ["pgdata"], overwriteTargets: ["pgdata"] }),
		);
		expect(plan.needsOverwrite).toEqual([]);
		expect(plan.volumes[0]?.overwrite).toBe(true);
		expect(describeTransferRefusal(plan)).toBeNull();
		expect(() => assertTransferPlanAllowed(plan)).not.toThrow();
	});

	it("a name for one volume does not cover another", async () => {
		targetHolds({ one: "non-empty", two: "non-empty" });
		const plan = await inspectTransferPlan(
			input({ volumes: ["one", "two"], overwriteTargets: ["one"] }),
		);
		expect(plan.needsOverwrite).toEqual(["two"]);
	});

	it.each(["missing", "empty"])("lets a %s volume through", async (answer) => {
		targetHolds({ pgdata: answer });
		const plan = await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		expect(plan.needsOverwrite).toEqual([]);
		expect(describeTransferRefusal(plan)).toBeNull();
	});

	it("refuses when the target cannot be asked", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh: connection lost"));
		const plan = await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		expect(plan.volumes[0]?.targetState).toBeNull();
		expect(plan.blockers.join(" ")).toContain("ssh: connection lost");
		expect(() => assertTransferPlanAllowed(plan)).toThrow(
			expect.objectContaining({ code: "BAD_REQUEST" }),
		);
	});

	it("refuses when the answer is not one it knows", async () => {
		targetHolds({ pgdata: "whatever" });
		const plan = await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		expect(plan.blockers.join(" ")).toContain("unexpected answer");
		expect(() => assertTransferPlanAllowed(plan)).toThrow();
	});

	it("refuses a bind mount directory that holds data on the target", async () => {
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string | null) => ({
				stdout: serverId === "server-target" ? "non-empty\n" : "empty\n",
				stderr: "",
			}),
		);
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/shared/uploads"] }),
		);
		expect(plan.bindMounts).toEqual([
			{
				hostPath: "/srv/shared/uploads",
				existsOnSource: true,
				targetState: "non-empty",
				overwrite: false,
			},
		]);
		expect(plan.needsOverwrite).toEqual(["/srv/shared/uploads"]);
		const again = await inspectTransferPlan(
			input({
				bindMounts: ["/srv/shared/uploads"],
				overwriteTargets: ["/srv/shared/uploads"],
			}),
		);
		expect(again.needsOverwrite).toEqual([]);
	});

	it("does not look at the target for a directory the source does not have", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "missing\n",
			stderr: "",
		});
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/shared/uploads"] }),
		);
		expect(plan.bindMounts[0]).toMatchObject({
			existsOnSource: false,
			targetState: null,
		});
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
	});
});

describe("whose volumes they are", () => {
	it("refuses a volume the binding check refuses, on both hosts", async () => {
		mocks.findRefusedVolumeMounts.mockResolvedValue([
			{
				volumeName: "other-org-data",
				message: 'Volume "other-org-data" is refused.',
			},
		]);
		const plan = await inspectTransferPlan(
			input({ volumes: ["other-org-data", "mine"] }),
		);
		expect(mocks.findRefusedVolumeMounts).toHaveBeenCalledWith(
			[
				{ type: "volume", volumeName: "other-org-data" },
				{ type: "volume", volumeName: "mine" },
			],
			{ serviceType: "application", serviceId: "app-1" },
			{ serverIds: ["server-source", "server-target"] },
		);
		expect(plan.blockers.join(" ")).toContain("other-org-data");
		// The refused volume is not even read on the target.
		for (const call of mocks.execAsyncRemote.mock.calls) {
			expect(call[1]).not.toContain("other-org-data");
		}
		expect(() => assertTransferPlanAllowed(plan)).toThrow();
	});

	it("checks a compose's own volumes too", async () => {
		mocks.findRefusedComposeVolumes.mockResolvedValue([
			{ volumeName: "shared", message: 'Compose volume "shared" is refused.' },
		]);
		const plan = await inspectTransferPlan(
			input({
				serviceType: "compose",
				serviceId: "comp-1",
				appName: "stack-x",
				isCompose: true,
				volumes: ["shared"],
			}),
		);
		expect(mocks.findRefusedComposeVolumes).toHaveBeenCalledWith(
			{ composeId: "comp-1", appName: "stack-x" },
			[{ volumeName: "shared" }],
			{ serverIds: ["server-source", "server-target"] },
		);
		expect(plan.blockers.join(" ")).toContain("shared");
	});

	it("refuses when the check cannot be made", async () => {
		mocks.findRefusedVolumeMounts.mockRejectedValue(new Error("db down"));
		const plan = await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		expect(plan.blockers.join(" ")).toContain("db down");
		expect(plan.volumes).toEqual([]);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("host paths", () => {
	const blockersFor = async (overrides: Record<string, unknown>) =>
		(await inspectTransferPlan(input(overrides))).blockers.join(" ");

	it("refuses a bind mount to a member, as creating one is", async () => {
		const text = await blockersFor({
			bindMounts: ["/srv/shared/uploads"],
			caller: { privilegedRole: false, localHostReach: false },
		});
		expect(text).toContain("Only an owner or admin can create bind mounts");
	});

	it("refuses a bind mount on the Dokploy host without reach of it", async () => {
		const caller = { privilegedRole: true, localHostReach: false };
		for (const sides of [
			{ sourceServerId: null, targetServerId: "server-target" },
			{ sourceServerId: "server-source", targetServerId: null },
		]) {
			const text = await blockersFor({
				bindMounts: ["/srv/shared/uploads"],
				caller,
				...sides,
			});
			expect(text).toContain("organization that owns this Dokploy instance");
		}
	});

	it("does not ask for reach of the Dokploy host between two remote servers", async () => {
		const plan = await inspectTransferPlan(
			input({
				bindMounts: ["/srv/shared/uploads"],
				caller: { privilegedRole: true, localHostReach: false },
			}),
		);
		expect(plan.blockers).toEqual([]);
	});

	it.each([
		["/etc", "system directory"],
		["/etc/ssh", "system directory"],
		["/var/lib/docker/volumes", "system directory"],
		["/root/.ssh", "SSH keys"],
		["/var/run/docker.sock", "socket"],
		["/srv/x/../../etc", "canonical form"],
		["/srv/data/", "canonical form"],
		["relative/path", "absolute path"],
	])("refuses to copy %s", async (hostPath, reason) => {
		const text = await blockersFor({ bindMounts: [hostPath] });
		expect(text).toContain(reason);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reads a path's state with the path quoted", () => {
		const hostile = "/srv/x; touch /tmp/pwn";
		const tokens = parse(directoryStateCommand(hostile));
		expect(tokens).toContain(hostile);
	});
});

describe("the commands that read the target", () => {
	const hostile = "x;touch${IFS}/tmp/pwn";

	it("quote a volume name, so it is one word", () => {
		const tokens = parse(volumeStateCommand(hostile));
		expect(tokens).toContain(`${hostile}:/data:ro`);
		// Nothing but the fixed script is an operator.
		for (const token of tokens) {
			if (typeof token === "object") {
				expect(JSON.stringify(token)).not.toContain("touch");
			}
		}
	});

	it("only read the volume, and never create it", () => {
		const command = volumeStateCommand("pgdata");
		expect(command).toContain("docker volume inspect pgdata");
		expect(command).toContain("-v pgdata:/data:ro");
		expect(command).not.toContain("docker volume create");
	});
});

describe("host paths a compose file binds", () => {
	const spec = {
		services: {
			web: {
				volumes: [
					"/srv/uploads:/app/uploads",
					"/srv/ro:/ro:ro",
					"./config:/etc/app",
					"../files/nginx.conf:/etc/nginx/nginx.conf",
					"~/cache:/cache",
					"${DATA_DIR}:/data",
					"named:/named",
					"/anonymous-only",
					{ type: "bind", source: "/srv/long", target: "/long" },
					{ type: "volume", source: "vol", target: "/vol" },
				],
			},
			db: { volumes: ["/srv/db:/var/lib/db"] },
			bare: {},
		},
	};

	it("lists the host paths it binds, with their service", () => {
		expect(scanComposeHostBinds(spec)).toEqual([
			{
				service: "web",
				source: "/srv/uploads",
				target: "/app/uploads",
				kind: "absolute",
			},
			{ service: "web", source: "/srv/ro", target: "/ro", kind: "absolute" },
			{
				service: "web",
				source: "./config",
				target: "/etc/app",
				kind: "relative",
			},
			{ service: "web", source: "~/cache", target: "/cache", kind: "home" },
			{
				service: "web",
				source: "${DATA_DIR}",
				target: "/data",
				kind: "variable",
			},
			{
				service: "web",
				source: "/srv/long",
				target: "/long",
				kind: "absolute",
			},
			{
				service: "db",
				source: "/srv/db",
				target: "/var/lib/db",
				kind: "absolute",
			},
		]);
	});

	it("leaves out the bind mounts the service stores, which are copied", () => {
		const found = scanComposeHostBinds(spec, ["/srv/uploads", "/srv/db"]);
		expect(found.map((bind) => bind.source)).not.toContain("/srv/uploads");
		expect(found.map((bind) => bind.source)).not.toContain("/srv/db");
		expect(found.map((bind) => bind.source)).toContain("/srv/ro");
	});

	it("reads nothing out of a file that is not a compose file", () => {
		expect(scanComposeHostBinds(null)).toEqual([]);
		expect(scanComposeHostBinds("text")).toEqual([]);
		expect(scanComposeHostBinds({ services: "x" })).toEqual([]);
		expect(scanComposeHostBinds({ services: { a: { volumes: "x" } } })).toEqual(
			[],
		);
	});
});
