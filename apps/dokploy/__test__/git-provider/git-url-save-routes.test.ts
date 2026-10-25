import { beforeEach, describe, expect, it, vi } from "vitest";

// A custom git URL is checked when it is set or changed (T-8420). A row that
// already holds a value which is no longer allowed stays visible and editable:
// saving the same value, or another field, does not fail for it, and the
// deploy refuses it instead.
const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	updateApplication: vi.fn(),
	updateCompose: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

const LEGACY_URL = "file:///srv/legacy";
const MESSAGE =
	"This git URL is not allowed; use an http(s), ssh, or user@host:path URL";

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
		customGitUrl: LEGACY_URL,
	});
	mocks.findComposeById.mockResolvedValue({
		composeId: "cmp-1",
		appName: "stack",
		name: "Stack",
		customGitUrl: LEGACY_URL,
		environment: { project: { organizationId: "org-1" } },
	});
	mocks.updateApplication.mockResolvedValue({ applicationId: "app-1" });
	mocks.updateCompose.mockResolvedValue({ composeId: "cmp-1" });
});

const BAD_URLS = [
	"file:///etc",
	"/srv/x",
	"../x",
	"ext::sh -c id",
	"-oProxyCommand=x:r",
	"git://h/r",
];

describe("application.update", { timeout: 60_000 }, () => {
	it.each(BAD_URLS)(
		"rejects a changed customGitUrl %s and saves nothing",
		async (url) => {
			const caller = await applicationCaller();

			await expect(
				caller.update({ applicationId: "app-1", customGitUrl: url }),
			).rejects.toMatchObject({ code: "BAD_REQUEST", message: MESSAGE });
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		},
	);

	it("saves a remote URL", async () => {
		const caller = await applicationCaller();

		await caller.update({
			applicationId: "app-1",
			customGitUrl: "git@github.com:o/r.git",
		});

		expect(mocks.updateApplication).toHaveBeenCalledWith(
			"app-1",
			expect.objectContaining({ customGitUrl: "git@github.com:o/r.git" }),
		);
	});

	it("still saves the unchanged legacy value, and a save without the field", async () => {
		const caller = await applicationCaller();

		await caller.update({ applicationId: "app-1", customGitUrl: LEGACY_URL });
		await caller.update({ applicationId: "app-1", name: "Renamed" });

		expect(mocks.updateApplication).toHaveBeenCalledTimes(2);
	});
});

describe("application.saveGitProvider", { timeout: 60_000 }, () => {
	const input = {
		applicationId: "app-1",
		customGitBranch: "main",
		customGitBuildPath: "/",
		watchPaths: [],
		enableSubmodules: false,
		customGitSSHKeyId: null,
	};

	// The input schema holds the same rule as the save and deploy checks (T-8498),
	// so a URL that is not allowed is refused whether or not it is the stored one.
	it.each([...BAD_URLS, "git@-oX:r", "HTTPS://h/r", "host:path"])(
		"refuses %s in the input, and saves nothing",
		async (url) => {
			const caller = await applicationCaller();

			await expect(
				caller.saveGitProvider({ ...input, customGitUrl: url } as never),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining(MESSAGE),
			});
			expect(mocks.updateApplication).not.toHaveBeenCalled();
		},
	);

	it("refuses a stored URL that is no longer allowed until it is changed", async () => {
		const caller = await applicationCaller();
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			appName: "web",
			name: "Web",
			customGitUrl: "git@-oX:r",
		});

		await expect(
			caller.saveGitProvider({ ...input, customGitUrl: "git@-oX:r" } as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await caller.saveGitProvider({
			...input,
			customGitUrl: "git@github.com:o/r.git",
		} as never);

		expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
	});

	it("keeps accepting a remote URL", async () => {
		const caller = await applicationCaller();

		await caller.saveGitProvider({
			...input,
			customGitUrl: "https://github.com/o/r.git",
		} as never);

		expect(mocks.updateApplication).toHaveBeenCalledTimes(1);
	});
});

describe("compose.update", { timeout: 60_000 }, () => {
	it.each(BAD_URLS)(
		"rejects a changed customGitUrl %s and saves nothing",
		async (url) => {
			const caller = await composeCaller();

			await expect(
				caller.update({ composeId: "cmp-1", customGitUrl: url }),
			).rejects.toMatchObject({ code: "BAD_REQUEST", message: MESSAGE });
			expect(mocks.updateCompose).not.toHaveBeenCalled();
		},
	);

	it("saves a remote URL, the unchanged legacy value, and a save without the field", async () => {
		const caller = await composeCaller();

		await caller.update({
			composeId: "cmp-1",
			customGitUrl: "ssh://git@host.example:2222/o/r.git",
		});
		await caller.update({ composeId: "cmp-1", customGitUrl: LEGACY_URL });
		await caller.update({ composeId: "cmp-1", name: "Renamed" });

		expect(mocks.updateCompose).toHaveBeenCalledTimes(3);
	});
});
