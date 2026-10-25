import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// compose.fetchSourceType (through cloneCompose) and compose.loadTemplateFromGit
// clone the repository with the provider or SSH key stored on the service. A
// stored id of another organization is refused with FORBIDDEN, not folded into
// the generic "Error fetching source type", and nothing is cloned (T-6902).
const mocks = vi.hoisted(() => ({
	assertDeployReferencesInOrganization: vi.fn(),
	cloneCompose: vi.fn(),
	cloneGithubRepository: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
}));

const REFUSAL =
	"Deployment refused: the GitHub provider set on this service does not belong to its organization.";

const composeRow = {
	composeId: "cmp-1",
	appName: "stack",
	sourceType: "github",
	githubId: "gh-foreign",
	serverId: null,
	composePath: "./docker-compose.yml",
	environment: { project: { organizationId: "org-b" } },
};

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		assertDeployReferencesInOrganization:
			mocks.assertDeployReferencesInOrganization,
		cloneCompose: mocks.cloneCompose,
		cloneGithubRepository: mocks.cloneGithubRepository,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
		findComposeById: vi.fn(async () => composeRow),
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

beforeEach(() => {
	vi.clearAllMocks();
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.assertDeployReferencesInOrganization.mockResolvedValue(undefined);
	mocks.cloneCompose.mockResolvedValue("clone;");
	mocks.cloneGithubRepository.mockResolvedValue("clone-github;");
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("compose.fetchSourceType", { timeout: 60_000 }, () => {
	it("passes the FORBIDDEN refusal through instead of a generic error, and runs nothing", async () => {
		mocks.cloneCompose.mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: REFUSAL }),
		);
		const caller = await callerOf();

		await expect(
			caller.fetchSourceType({ composeId: "cmp-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN", message: REFUSAL });
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("still reports other failures as the generic error", async () => {
		mocks.cloneCompose.mockRejectedValue(new Error("boom"));
		const caller = await callerOf();

		await expect(
			caller.fetchSourceType({ composeId: "cmp-1" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Error fetching source type",
		});
	});
});

describe("compose.loadTemplateFromGit", { timeout: 60_000 }, () => {
	it("refuses a stored provider of another organization before cloning", async () => {
		mocks.assertDeployReferencesInOrganization.mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN", message: REFUSAL }),
		);
		const caller = await callerOf();

		await expect(
			caller.loadTemplateFromGit({ composeId: "cmp-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN", message: REFUSAL });
		expect(mocks.cloneGithubRepository).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("checks the source credential only, then clones", async () => {
		const caller = await callerOf();

		await caller.loadTemplateFromGit({ composeId: "cmp-1" }).catch(() => {
			// reading the template out of the mocked shell fails; only the order
			// of the check and the clone matters here
		});

		expect(mocks.assertDeployReferencesInOrganization).toHaveBeenCalledWith(
			composeRow,
			"source",
		);
		expect(mocks.cloneGithubRepository).toHaveBeenCalledTimes(1);
	});
});
