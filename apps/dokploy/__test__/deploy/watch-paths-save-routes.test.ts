import { beforeEach, describe, expect, it, vi } from "vitest";

// picomatch GHSA-fc5q-39xc-vjpf. A watch path the validator refuses is
// saveable only when it is already stored on the unit (same shape as T-8420 for
// git URLs): the forms send the whole object back, so a list saved before the
// rule existed must not block saving unrelated settings, but no save may add a
// new bad pattern.
const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	updateApplication: vi.fn(),
	updateCompose: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

const STORED = ["src/**/*.{ts,tsx}", "!docs/**"];

vi.mock("@dokploy/server", async () => {
	const { createDokployServerMock } = await import(
		"../helpers/mock-dokploy-server"
	);
	return createDokployServerMock({
		findApplicationById: mocks.findApplicationById,
		findComposeById: mocks.findComposeById,
		updateApplication: mocks.updateApplication,
		updateCompose: mocks.updateCompose,
		assertServiceReferencesInOrganization: vi.fn(),
		assertCanUseServiceGitProviders: vi.fn(),
		assertComposeBuildSettings: vi.fn(),
		assertComposeRollingSettings: vi.fn(),
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

const applicationCaller = async () => {
	const module = await import("@/server/api/routers/application");
	return module.applicationRouter.createCaller(ctx as never);
};

const composeCaller = async () => {
	const module = await import("@/server/api/routers/compose");
	return module.composeRouter.createCaller(ctx as never);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "app-1",
		appName: "web",
		name: "Web",
		watchPaths: STORED,
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "cmp-1",
		appName: "stack",
		name: "Stack",
		watchPaths: STORED,
		environment: { project: { organizationId: "org-1" } },
	});
	mocks.updateApplication.mockResolvedValue({ applicationId: "app-1" });
	mocks.updateCompose.mockResolvedValue({ composeId: "cmp-1" });
});

const NEW_BAD = [
	[...STORED, "+(*)"],
	["src/**/*.{js,jsx}"],
	["(a+)+b"],
	["*a*a*a*b"],
];
const REFUSED = {
	code: "BAD_REQUEST",
	message: expect.stringMatching(/^Invalid watch path /),
};

const githubInput = {
	applicationId: "app-1",
	repository: "repo",
	owner: "owner",
	buildPath: "/",
	githubId: "gh-1",
	branch: "main",
	triggerType: "push" as const,
	enableSubmodules: false,
};

const gitInput = {
	applicationId: "app-1",
	customGitBranch: "main",
	customGitBuildPath: "/",
	customGitUrl: "https://github.com/o/r.git",
	enableSubmodules: false,
	customGitSSHKeyId: null,
};

describe("application.update", { timeout: 60_000 }, () => {
	it("saves the unchanged stored list and an unrelated field", async () => {
		const caller = await applicationCaller();
		await caller.update({ applicationId: "app-1", watchPaths: [...STORED] });
		await caller.update({
			applicationId: "app-1",
			name: "Renamed",
			watchPaths: [...STORED],
		});
		await caller.update({ applicationId: "app-1", name: "Renamed" });
		expect(mocks.updateApplication).toHaveBeenCalledTimes(3);
	});

	it.each(NEW_BAD)(
		"refuses a new or changed bad list %j",
		async (...watchPaths) => {
			const caller = await applicationCaller();
			await expect(
				caller.update({ applicationId: "app-1", watchPaths }),
			).rejects.toMatchObject(REFUSED);
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		},
	);

	it("saves a valid list", async () => {
		const caller = await applicationCaller();
		await caller.update({
			applicationId: "app-1",
			watchPaths: ["apps/web/**", "!docs/**"],
		});
		expect(mocks.updateApplication).toHaveBeenCalledWith(
			"app-1",
			expect.objectContaining({ watchPaths: ["apps/web/**", "!docs/**"] }),
		);
	});
});

describe.each([
	["saveGithubProvider", githubInput],
	["saveGitProvider", gitInput],
] as const)("application.%s", { timeout: 60_000 }, (procedure, input) => {
	const save = async (watchPaths: string[]) => {
		const caller = await applicationCaller();
		return (caller[procedure] as (value: unknown) => Promise<unknown>)({
			...input,
			watchPaths,
		});
	};

	it("saves the unchanged stored list", async () => {
		await save([...STORED]);
		expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
	});

	it("saves the stored bad pattern with a valid one added", async () => {
		await save([...STORED, "apps/api/**"]);
		expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
	});

	it.each(NEW_BAD)(
		"refuses a new or changed bad list %j",
		async (...watchPaths) => {
			await expect(save(watchPaths)).rejects.toMatchObject(REFUSED);
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		},
	);

	it("saves a valid list", async () => {
		await save(["src/**"]);
		expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
	});
});

describe("compose.update", { timeout: 60_000 }, () => {
	it("saves the unchanged stored list and an unrelated field", async () => {
		const caller = await composeCaller();
		await caller.update({ composeId: "cmp-1", watchPaths: [...STORED] });
		await caller.update({ composeId: "cmp-1", name: "Renamed" });
		expect(mocks.updateCompose).toHaveBeenCalledTimes(2);
	});

	it.each(NEW_BAD)(
		"refuses a new or changed bad list %j",
		async (...watchPaths) => {
			const caller = await composeCaller();
			await expect(
				caller.update({ composeId: "cmp-1", watchPaths }),
			).rejects.toMatchObject(REFUSED);
			expect(mocks.updateCompose).not.toHaveBeenCalled();
		},
	);

	it("saves a valid list", async () => {
		const caller = await composeCaller();
		await caller.update({ composeId: "cmp-1", watchPaths: ["stack/**"] });
		expect(mocks.updateCompose).toHaveBeenCalledTimes(1);
	});
});
