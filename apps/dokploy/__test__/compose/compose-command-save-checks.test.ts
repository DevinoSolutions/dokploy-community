import { beforeEach, describe, expect, it, vi } from "vitest";

// A custom command that a deploy would refuse is refused when it is set or
// changed (T-7607), with the deploy message; the deploy checks again. A stored
// command that would be refused now stays visible, editable and clearable.
const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	updateApplication: vi.fn(),
	updateCompose: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		findApplicationById: mocks.findApplicationById,
		findComposeById: mocks.findComposeById,
		updateApplication: mocks.updateApplication,
		updateCompose: mocks.updateCompose,
		assertServiceReferencesInOrganization: vi.fn(),
		assertCanUseServiceGitProviders: vi.fn(),
		assertComposeBuildSettings: vi.fn(),
		assertComposeRollingSettings: vi.fn(),
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
	session: { activeOrganizationId: "org-1", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
};

const composeCaller = async () => {
	const module = await import("@/server/api/routers/compose");
	return module.composeRouter.createCaller(ctx as never);
};

const APP = "stack-abc123";
const GOOD = `compose -p ${APP} -f docker-compose.yml up -d`;
// Each of these is refused by a deploy: another project's name, a stack that is
// not its own, a path outside its own directory, a daemon option, and a
// command that is not compose or stack.
const BAD: Array<[string, string, RegExp]> = [
	[
		"a project name that is not its own",
		"compose -p other-app -f docker-compose.yml up -d",
		/project/i,
	],
	["no project name and no file", "compose up -d", /Compose command refused/],
	[
		"a stack that is not its own",
		"stack deploy -c docker-compose.yml other-app",
		/Compose command refused/,
	],
	[
		"an env file outside its own directory",
		`compose -p ${APP} --env-file /etc/other/.env -f docker-compose.yml up -d`,
		/outside this compose's own directory/,
	],
	[
		"a project directory outside its own directory",
		`compose -p ${APP} --project-directory ../../other/code -f docker-compose.yml up -d`,
		/outside this compose's own directory/,
	],
	[
		"a compose file outside its own directory",
		`compose -p ${APP} -f /srv/x/docker-compose.yml up -d`,
		/outside this compose's own directory/,
	],
	[
		"a docker option that changes the daemon",
		`-H tcp://host:2375 compose -p ${APP} -f docker-compose.yml up -d`,
		/not allowed/,
	],
	["another docker command", "run alpine sh", /Compose command refused/],
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findComposeById.mockResolvedValue({
		composeId: "cmp-1",
		appName: APP,
		name: "Stack",
		sourceType: "raw",
		composeType: "docker-compose",
		composePath: "docker-compose.yml",
		command: "",
		serverId: null,
		environment: { project: { organizationId: "org-1" } },
	});
	mocks.updateCompose.mockResolvedValue({ composeId: "cmp-1" });
});

describe("compose.update with a custom command", { timeout: 60_000 }, () => {
	it.each(BAD)(
		"refuses %s, and saves nothing",
		async (_name, command, message) => {
			const caller = await composeCaller();

			await expect(
				caller.update({ composeId: "cmp-1", command }),
			).rejects.toMatchObject({ code: "BAD_REQUEST", message });
			expect(mocks.updateCompose).not.toHaveBeenCalled();
		},
	);

	it("saves a command a deploy accepts", async () => {
		const caller = await composeCaller();

		await caller.update({ composeId: "cmp-1", command: GOOD });

		expect(mocks.updateCompose).toHaveBeenCalledWith(
			"cmp-1",
			expect.objectContaining({ command: GOOD }),
		);
	});

	it("gives the form the same message a deploy gives", async () => {
		const { assertCommandRunsComposeOnly } = await import(
			"@dokploy/server/services/compose-volume-binding"
		);
		const [, command] = BAD[3] as [string, string, RegExp];
		let deployMessage = "";
		try {
			assertCommandRunsComposeOnly({
				...(await mocks.findComposeById()),
				command,
			});
		} catch (error) {
			deployMessage = (error as Error).message;
		}
		const caller = await composeCaller();

		await expect(
			caller.update({ composeId: "cmp-1", command }),
		).rejects.toMatchObject({ message: deployMessage });
		expect(deployMessage).not.toBe("");
	});

	it("does not look at the command on an update that leaves it out", async () => {
		const caller = await composeCaller();
		mocks.findComposeById.mockResolvedValue({
			...(await mocks.findComposeById()),
			command: BAD[0]?.[1],
		});

		await caller.update({ composeId: "cmp-1", name: "Renamed" });

		expect(mocks.updateCompose).toHaveBeenCalledTimes(1);
	});

	it("saves the stored command as it is, and clears it", async () => {
		const caller = await composeCaller();
		const stored = BAD[0]?.[1] as string;
		mocks.findComposeById.mockResolvedValue({
			...(await mocks.findComposeById()),
			command: stored,
		});

		await caller.update({ composeId: "cmp-1", command: stored, name: "x" });
		await caller.update({ composeId: "cmp-1", command: "" });

		expect(mocks.updateCompose).toHaveBeenCalledTimes(2);
	});

	it("refuses an edit of a stored command that is still not accepted, and takes a fixed one", async () => {
		const caller = await composeCaller();
		mocks.findComposeById.mockResolvedValue({
			...(await mocks.findComposeById()),
			command: BAD[0]?.[1],
		});

		await expect(
			caller.update({ composeId: "cmp-1", command: BAD[1]?.[1] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await caller.update({ composeId: "cmp-1", command: GOOD });

		expect(mocks.updateCompose).toHaveBeenCalledTimes(1);
	});
});
