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
	assertTargetStillClear,
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
			undefined,
			{ signal: expect.any(AbortSignal) },
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
		expect(mocks.execAsync).toHaveBeenCalledWith(volumeStateCommand("pgdata"), {
			timeout: 300_000,
		});
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
		expect(plan.blockers.join(" ")).toContain(
			"Could not check who the volumes belong to",
		);
		// The error text stays in the server log, not in the answer.
		expect(plan.blockers.join(" ")).not.toContain("db down");
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

describe("a check that fails is a refusal, never a pass", () => {
	const fails = (server: string) => async (id: string | null) => {
		if (id === server) {
			throw new Error("ssh: connection reset");
		}
		return { stdout: "non-empty\n", stderr: "" };
	};

	it("a source that cannot be read refuses, and does not skip the target", async () => {
		mocks.execAsyncRemote.mockImplementation(fails("server-source"));
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/shared/uploads"] }),
		);
		expect(plan.blockers.join(" ")).toContain(
			"on the source server (ssh: connection reset), so the transfer is refused",
		);
		expect(plan.bindMounts).toEqual([]);
		expect(() => assertTransferPlanAllowed(plan)).toThrow(
			expect.objectContaining({ code: "BAD_REQUEST" }),
		);
	});

	it("a source that answers nonsense refuses", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/shared/uploads"] }),
		);
		expect(plan.blockers.join(" ")).toContain("unexpected answer");
	});

	it("a target that cannot be read refuses a bind mount", async () => {
		mocks.execAsyncRemote.mockImplementation(fails("server-target"));
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/shared/uploads"] }),
		);
		expect(plan.blockers.join(" ")).toContain("on the target server");
	});

	it("does not show a long or multi-line host error whole", async () => {
		mocks.execAsyncRemote.mockRejectedValue(
			new Error(`${"x".repeat(500)}\nsecond line`),
		);
		const plan = await inspectTransferPlan(input({ volumes: ["pgdata"] }));
		const text = plan.blockers.join(" ");
		expect(text).not.toContain("second line");
		expect(text.length).toBeLessThan(400);
	});

	it("every check is bounded in time, the volume one longer for an image pull", async () => {
		targetHolds({ pgdata: "empty" });
		await inspectTransferPlan(
			input({ volumes: ["pgdata"], targetServerId: null }),
		);
		expect(mocks.execAsync).toHaveBeenCalledWith(expect.any(String), {
			timeout: 300_000,
		});
		mocks.execAsync.mockClear();
		targetHolds({ "/srv/shared/uploads": "empty" });
		await inspectTransferPlan(
			input({
				bindMounts: ["/srv/shared/uploads"],
				sourceServerId: null,
				targetServerId: null,
			}),
		);
		expect(mocks.execAsync).toHaveBeenCalledWith(expect.any(String), {
			timeout: 60_000,
		});
	});
});

// The state commands are real shell: run them against stub `docker`, `stat`
// and `find` programs that fail the way a host fails, and see what they print.
describe.skipIf(process.platform === "win32")(
	"what the state commands say when the host fails",
	() => {
		const run = async (
			command: string,
			stubs: Record<string, string>,
		): Promise<{ code: number; stdout: string }> => {
			const { spawnSync } = await import("node:child_process");
			const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const dir = await mkdtemp(join(tmpdir(), "transfer-state-"));
			try {
				for (const [name, body] of Object.entries(stubs)) {
					await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`, {
						mode: 0o755,
					});
				}
				const result = spawnSync("/bin/sh", ["-c", command], {
					env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
					timeout: 10_000,
					encoding: "utf8",
				});
				return { code: result.status ?? 1, stdout: result.stdout.trim() };
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		};

		it("a volume the daemon says does not exist is missing", async () => {
			expect(
				await run(volumeStateCommand("v"), {
					docker: 'echo "Error: No such volume: v" >&2; exit 1',
				}),
			).toEqual({ code: 0, stdout: "missing" });
		});

		it.each([
			"Cannot connect to the Docker daemon",
			"permission denied while trying to connect to the Docker daemon socket",
		])("a failing docker (%s) is an error, not missing", async (message) => {
			const result = await run(volumeStateCommand("v"), {
				docker: `echo "${message}" >&2; exit 1`,
			});
			expect(result.code).not.toBe(0);
			expect(result.stdout).not.toBe("missing");
		});

		it("a volume whose listing fails is an error, not empty", async () => {
			const result = await run(volumeStateCommand("v"), {
				docker:
					'case "$1" in volume) exit 0;; run) echo "find: /data: Permission denied" >&2; exit 1;; esac',
			});
			expect(result.code).not.toBe(0);
			expect(result.stdout).not.toBe("empty");
		});

		it("a volume that lists files is non-empty", async () => {
			expect(
				await run(volumeStateCommand("v"), {
					docker: 'case "$1" in volume) exit 0;; run) echo non-empty;; esac',
				}),
			).toEqual({ code: 0, stdout: "non-empty" });
		});

		it("a directory that does not exist is missing", async () => {
			expect(
				await run(directoryStateCommand("/nowhere/at/all/x"), {
					stat: 'echo "stat: cannot statx: No such file or directory" >&2; exit 1',
				}),
			).toEqual({ code: 0, stdout: "missing" });
		});

		it("a directory that cannot be listed is an error, not empty", async () => {
			const result = await run(directoryStateCommand("/srv/x"), {
				stat: "echo directory",
				find: 'echo "find: /srv/x: Permission denied" >&2; exit 1',
			});
			expect(result.code).not.toBe(0);
			expect(result.stdout).not.toBe("empty");
		});

		it("a stat that fails for another reason is an error, not missing", async () => {
			const result = await run(directoryStateCommand("/srv/x"), {
				stat: 'echo "stat: cannot statx: Permission denied" >&2; exit 1',
			});
			expect(result.code).not.toBe(0);
			expect(result.stdout).not.toBe("missing");
		});

		it("a file or a socket is not-directory, not an error", async () => {
			for (const kind of ["regular file", "regular empty file", "socket"]) {
				expect(
					await run(directoryStateCommand("/srv/x"), {
						stat: `echo "${kind}"`,
					}),
				).toEqual({ code: 0, stdout: "not-directory" });
			}
		});

		it("follows symbolic links, as tar and the transfer do", () => {
			expect(directoryStateCommand("/srv/x")).toContain("stat -L -c %F");
		});

		it("an empty directory is empty, a full one is non-empty", async () => {
			expect(
				await run(directoryStateCommand("/srv/x"), {
					stat: "echo directory",
					find: "exit 0",
				}),
			).toEqual({ code: 0, stdout: "empty" });
			expect(
				await run(directoryStateCommand("/srv/x"), {
					stat: "echo directory",
					find: "echo /srv/x/a",
				}),
			).toEqual({ code: 0, stdout: "non-empty" });
		});
	},
);

describe("assertTargetStillClear", () => {
	const args = (overrides: Record<string, unknown> = {}) =>
		({
			targetServerId: "server-target",
			kind: "volume",
			name: "pgdata",
			overwriteTargets: [],
			...overrides,
		}) as Parameters<typeof assertTargetStillClear>[0];

	it("refuses a volume filled since the scan", async () => {
		targetHolds({ pgdata: "non-empty" });
		await expect(assertTargetStillClear(args())).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("refuses a directory filled since the scan", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "non-empty\n",
			stderr: "",
		});
		await expect(
			assertTargetStillClear(
				args({ kind: "directory", name: "/srv/shared/uploads" }),
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("refuses when it cannot look", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh: connection reset"));
		await expect(assertTargetStillClear(args())).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("passes an empty or missing target and a named one", async () => {
		targetHolds({ pgdata: "empty" });
		await expect(assertTargetStillClear(args())).resolves.toBeUndefined();
		targetHolds({ pgdata: "non-empty" });
		await expect(
			assertTargetStillClear(args({ overwriteTargets: ["pgdata"] })),
		).resolves.toBeUndefined();
	});
});

// The same command against a real filesystem and the real stat and find.
describe.skipIf(process.platform === "win32")(
	"the directory state command on real paths",
	() => {
		it("says what each shape of path is", async () => {
			const { spawnSync } = await import("node:child_process");
			const { mkdtemp, mkdir, writeFile, symlink, rm } = await import(
				"node:fs/promises"
			);
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const root = await mkdtemp(join(tmpdir(), "transfer-paths-"));
			try {
				await mkdir(join(root, "empty"));
				await mkdir(join(root, "full"));
				await writeFile(join(root, "full", ".hidden"), "x");
				await writeFile(join(root, "file"), "x");
				await symlink(join(root, "full"), join(root, "link-to-dir"));
				await symlink(join(root, "empty"), join(root, "link-to-empty"));
				await symlink(join(root, "file"), join(root, "link-to-file"));
				await symlink(join(root, "gone"), join(root, "dangling"));
				const state = (name: string) => {
					const result = spawnSync(
						"/bin/sh",
						["-c", directoryStateCommand(join(root, name))],
						{ encoding: "utf8" },
					);
					return { code: result.status, out: result.stdout.trim() };
				};
				expect(state("empty")).toEqual({ code: 0, out: "empty" });
				expect(state("full")).toEqual({ code: 0, out: "non-empty" });
				expect(state("nothing")).toEqual({ code: 0, out: "missing" });
				expect(state("file")).toEqual({ code: 0, out: "not-directory" });
				// A link to a directory is followed, as tar -C does.
				expect(state("link-to-dir")).toEqual({ code: 0, out: "non-empty" });
				expect(state("link-to-empty")).toEqual({ code: 0, out: "empty" });
				expect(state("link-to-file")).toEqual({
					code: 0,
					out: "not-directory",
				});
				// A dangling link has nothing to copy: missing, as [ -d ] says.
				expect(state("dangling")).toEqual({ code: 0, out: "missing" });
				// Below a file is an error, not missing.
				expect(state("file/sub").code).not.toBe(0);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	},
);

describe("a bind mount that is not a directory", () => {
	const answers = (source: string, target: string) =>
		mocks.execAsyncRemote.mockImplementation(
			async (serverId: string | null) => ({
				stdout: `${serverId === "server-source" ? source : target}\n`,
				stderr: "",
			}),
		);

	it("is skipped on the source, as before: nothing to copy, target not looked at", async () => {
		answers("not-directory", "non-empty");
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/app/config.yml"] }),
		);
		expect(plan.blockers).toEqual([]);
		expect(plan.needsOverwrite).toEqual([]);
		expect(plan.bindMounts).toEqual([
			{
				hostPath: "/srv/app/config.yml",
				existsOnSource: false,
				targetState: null,
				overwrite: false,
			},
		]);
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(() => assertTransferPlanAllowed(plan)).not.toThrow();
	});

	it("a directory on the source over a file on the target is refused", async () => {
		answers("non-empty", "not-directory");
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/shared/uploads"] }),
		);
		expect(plan.blockers.join(" ")).toContain("the target server has a file");
		expect(() => assertTransferPlanAllowed(plan)).toThrow();
	});

	it("is refused at the copy when the target holds a file there", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "not-directory\n",
			stderr: "",
		});
		await expect(
			assertTargetStillClear({
				targetServerId: "server-target",
				kind: "directory",
				name: "/srv/shared/uploads",
				overwriteTargets: [],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("a source that cannot be read is still refused", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh: connection reset"));
		const plan = await inspectTransferPlan(
			input({ bindMounts: ["/srv/app/config.yml"] }),
		);
		expect(plan.blockers.join(" ")).toContain("on the source server");
	});
});

// These run on every platform: `find` does not follow a symbolic link given on
// the command line unless it is told to (-H), so without it a link to a
// populated directory lists nothing and reads as "empty", and a transfer would
// merge into live data without overwriteTargets. The shell tests above only
// run on Linux; this keeps the flag from being dropped on a Windows dev box.
describe("every listing follows a link given as the path", () => {
	const finds = (command: string) => command.match(/\bfind\b[^;|]*/g) ?? [];

	it("the directory state command lists with find -H", () => {
		const command = directoryStateCommand("/srv/link-to-data");
		expect(finds(command)).toHaveLength(1);
		for (const find of finds(command)) {
			expect(find).toMatch(/^find -H /);
		}
		expect(command).toContain("stat -L -c %F");
	});

	it("the volume state command lists with find -H", () => {
		const command = volumeStateCommand("pgdata");
		expect(finds(command)).toHaveLength(1);
		for (const find of finds(command)) {
			expect(find).toMatch(/^find -H /);
		}
	});

	it("a hostile path is still one quoted word after find -H", () => {
		const hostile = "/srv/x; touch /tmp/pwn";
		const tokens = parse(directoryStateCommand(hostile));
		const at = tokens.indexOf("-H");
		expect(at).toBeGreaterThan(0);
		expect(tokens[at + 1]).toBe(hostile);
	});
});
