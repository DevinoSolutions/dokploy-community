import { beforeEach, describe, expect, it, vi } from "vitest";

// compose.loadTemplateFromGit clones a repository that is not trusted and
// reads template.toml out of it. The read goes through the guarded script (not
// `cat`), the clone is limited to remote protocols, and the temp dir is
// removed on every path (T-8413). Modelled on fk-org-checks/source-clone-routes.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	cloneGithubRepository: vi.fn(),
	cloneGitRepository: vi.fn(),
	processTemplate: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	state: { row: {} as Record<string, unknown> },
}));

const baseRow = {
	composeId: "cmp-1",
	appName: "stack",
	sourceType: "github",
	customGitUrl: null as string | null,
	githubId: "gh-1",
	serverId: null as string | null,
	composePath: "./docker-compose.yml",
	mounts: [],
	domains: [],
	environment: { project: { organizationId: "org-b" } },
};

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		assertDeployReferencesInOrganization: vi.fn(),
		cloneGithubRepository: mocks.cloneGithubRepository,
		cloneGitRepository: mocks.cloneGitRepository,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
		findComposeById: vi.fn(async () => mocks.state.row),
		getWebServerSettings: vi.fn(async () => ({ serverIp: "203.0.113.7" })),
		paths: () => ({ COMPOSE_PATH: "/etc/dokploy/compose" }),
		processTemplate: mocks.processTemplate,
	};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") {
				return undefined;
			}
			if (typeof key === "string" && key in named) {
				return named[key];
			}
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/services/permission", () => ({
	assertEnvironmentInOrganization: vi.fn(),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	checkServiceAccess: vi.fn(),
	addNewService: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: vi.fn(), holdIdleGroup: () => ({ release: () => {} }) },
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const ctx = {
	session: { activeOrganizationId: "org-b", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

const callerOf = async () => {
	const module = await import("@/server/api/routers/compose");
	return module.composeRouter.createCaller(ctx as never);
};

// node's join uses backslashes on a Windows development machine
const posixCommand = (command: string) => command.split("\\").join("/");

const commands = () =>
	mocks.execAsync.mock.calls.map(([command]) => posixCommand(command));

const REMOVES_TEMP_DIR =
	/rm -rf '?\/etc\/dokploy\/compose\/stack-temp-template-/;

const exitError = (exitCode: number) =>
	Object.assign(new Error("Command execution failed"), { exitCode });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.state.row = { ...baseRow };
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.cloneGithubRepository.mockResolvedValue("clone-github;");
	mocks.cloneGitRepository.mockResolvedValue("clone-git;");
	mocks.processTemplate.mockReturnValue({ envs: [], mounts: [], domains: [] });
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("compose.loadTemplateFromGit", { timeout: 60_000 }, () => {
	it("limits the clone to remote protocols, then reads through the guarded script, not cat", async () => {
		mocks.execAsync
			.mockResolvedValueOnce({ stdout: "", stderr: "" })
			.mockResolvedValueOnce({
				stdout: '[variables]\nmain_domain = "x"\n',
				stderr: "",
			})
			.mockResolvedValue({ stdout: "", stderr: "" });
		const caller = await callerOf();

		await caller.loadTemplateFromGit({ composeId: "cmp-1" });

		const [clone, read, clean] = commands();
		expect(clone).toBe(
			"set -e;umask 077; export GIT_ALLOW_PROTOCOL=https:http:ssh;clone-github;",
		);
		expect(read).toMatch(/^sh -c /);
		expect(read).not.toMatch(/^cat\b/);
		expect(read).toContain("[ -L ");
		expect(read).toContain("/etc/dokploy/compose/stack-temp-template-");
		expect(read).toContain("template.toml");
		expect(clean).toMatch(REMOVES_TEMP_DIR);
		expect(commands().filter((c) => /^cat\b/.test(c))).toEqual([]);
	});

	it("maps a refused read (exit 40) to BAD_REQUEST and removes the temp dir", async () => {
		mocks.execAsync
			.mockResolvedValueOnce({ stdout: "", stderr: "" })
			.mockRejectedValueOnce(exitError(40))
			.mockResolvedValue({ stdout: "", stderr: "" });
		const caller = await callerOf();

		await expect(
			caller.loadTemplateFromGit({ composeId: "cmp-1" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"The template repository contains a symbolic link where a file was expected; only regular files inside the repository are read.",
		});

		const list = commands();
		expect(list).toHaveLength(3);
		expect(list[2]).toMatch(REMOVES_TEMP_DIR);
		expect(mocks.processTemplate).not.toHaveBeenCalled();
	});

	it("maps an oversized file (exit 41) to BAD_REQUEST and removes the temp dir", async () => {
		mocks.execAsync
			.mockResolvedValueOnce({ stdout: "", stderr: "" })
			.mockRejectedValueOnce(exitError(41))
			.mockResolvedValue({ stdout: "", stderr: "" });
		const caller = await callerOf();

		await expect(
			caller.loadTemplateFromGit({ composeId: "cmp-1" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("1 MB"),
		});
		expect(commands()[2]).toContain("rm -rf ");
	});

	it("still answers null, after removing the temp dir, when there is no template", async () => {
		mocks.execAsync
			.mockResolvedValueOnce({ stdout: "", stderr: "" })
			.mockRejectedValueOnce(exitError(42))
			.mockResolvedValue({ stdout: "", stderr: "" });
		const caller = await callerOf();

		await expect(
			caller.loadTemplateFromGit({ composeId: "cmp-1" }),
		).resolves.toBeNull();
		expect(commands()[2]).toContain("rm -rf ");
	});

	it("runs the same guarded read on a remote server", async () => {
		mocks.state.row = { ...baseRow, serverId: "srv-1" };
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: "", stderr: "" })
			.mockRejectedValueOnce(exitError(40))
			.mockResolvedValue({ stdout: "", stderr: "" });
		const caller = await callerOf();

		await expect(
			caller.loadTemplateFromGit({ composeId: "cmp-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		const remote = mocks.execAsyncRemote.mock.calls.map(([, command]) =>
			posixCommand(command),
		);
		expect(remote[0]).toContain("GIT_ALLOW_PROTOCOL=https:http:ssh");
		expect(remote[1]).toMatch(/^sh -c /);
		expect(remote[2]).toMatch(REMOVES_TEMP_DIR);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	describe("the repository URL", () => {
		it("is checked for a Git source: a local URL is refused before anything runs", async () => {
			mocks.state.row = {
				...baseRow,
				sourceType: "git",
				customGitUrl: "file:///etc/dokploy",
			};
			const caller = await callerOf();

			await expect(
				caller.loadTemplateFromGit({ composeId: "cmp-1" }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("must be an http(s) URL"),
			});
			expect(mocks.cloneGitRepository).not.toHaveBeenCalled();
			expect(mocks.execAsync).not.toHaveBeenCalled();
		});

		it("lets a remote URL of a Git source through to the clone", async () => {
			mocks.state.row = {
				...baseRow,
				sourceType: "git",
				customGitUrl: "git@github.com:owner/repo.git",
			};
			mocks.execAsync
				.mockResolvedValueOnce({ stdout: "", stderr: "" })
				.mockRejectedValueOnce(exitError(42))
				.mockResolvedValue({ stdout: "", stderr: "" });
			const caller = await callerOf();

			await caller.loadTemplateFromGit({ composeId: "cmp-1" });
			expect(mocks.cloneGitRepository).toHaveBeenCalledTimes(1);
			expect(commands()[0]).toContain("clone-git;");
		});

		it("is not checked for a provider source, whose URL the provider builds", async () => {
			mocks.state.row = { ...baseRow, customGitUrl: "file:///etc/dokploy" };
			mocks.execAsync
				.mockResolvedValueOnce({ stdout: "", stderr: "" })
				.mockRejectedValueOnce(exitError(42))
				.mockResolvedValue({ stdout: "", stderr: "" });
			const caller = await callerOf();

			await expect(
				caller.loadTemplateFromGit({ composeId: "cmp-1" }),
			).resolves.toBeNull();
			expect(mocks.cloneGithubRepository).toHaveBeenCalledTimes(1);
		});
	});
});
