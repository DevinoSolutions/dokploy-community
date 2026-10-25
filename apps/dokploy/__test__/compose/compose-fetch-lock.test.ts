import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// T-8239: a compose Fetch (loadServices or rollingEligibility with type
// "fetch", fetchSourceType, the isolated deployment preview) clones the source
// over the code dir a deploy reads. It needs the permission a deploy needs,
// and it runs under the compose's group lock in the deployment queue: refused
// while a deployment of the compose is queued or running, with nothing run.
// `type: "cache"` only reads and stays at service read.

type Role = "reader" | "deployer";

const mocks = vi.hoisted(() => ({
	role: "reader" as Role,
	checkServicePermissionAndAccess: vi.fn(),
	findComposeById: vi.fn(),
	loadServices: vi.fn(),
	getComposeRollingReport: vi.fn(),
	cloneCompose: vi.fn(),
	randomizeIsolatedDeploymentComposeFile: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	queue: null as null | import("@/server/queues/in-memory-queue").InMemoryQueue,
}));

const composeRow = {
	composeId: "cmp-1",
	name: "stack",
	appName: "stack-abc",
	sourceType: "github",
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
};

vi.mock("@dokploy/server", () => {
	const stubs: Record<string | symbol, unknown> = {};
	const named: Record<string, unknown> = {
		IS_CLOUD: false,
		findComposeById: mocks.findComposeById,
		loadServices: mocks.loadServices,
		cloneCompose: mocks.cloneCompose,
		randomizeIsolatedDeploymentComposeFile:
			mocks.randomizeIsolatedDeploymentComposeFile,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
	};
	return new Proxy(stubs, {
		get: (target, key) => {
			if (key === "then") return undefined;
			if (typeof key === "string" && key in named) return named[key];
			target[key] ??= vi.fn();
			return target[key];
		},
		has: () => true,
	});
});

vi.mock("@dokploy/server/services/compose-rolling", () => ({
	getComposeRollingReport: mocks.getComposeRollingReport,
	assertComposeRollingSettings: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	assertEnvironmentInOrganization: vi.fn(),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
	checkServiceAccess: vi.fn(),
	addNewService: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

// The real queue, so the lock is the one its jobs hold.
vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: vi.fn(),
		holdIdleGroup: (partitionKey: string, group: string) =>
			mocks.queue?.holdIdleGroup(partitionKey, group),
	},
	cleanQueuesByApplication: vi.fn(),
	cleanQueuesByCompose: vi.fn(),
	killDockerBuild: vi.fn(),
}));

const { InMemoryQueue } = await import("@/server/queues/in-memory-queue");
const { composeRouter } = await import("@/server/api/routers/compose");
const { COMPOSE_FETCH_BUSY_MESSAGE } = await import(
	"@/server/api/utils/compose-fetch-lock"
);

const caller = composeRouter.createCaller({
	session: { activeOrganizationId: "org-1", userId: "user-1" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
} as never);

const flush = () => new Promise((r) => setTimeout(r, 0));

let finishJobs: () => void = () => {};

/** A queue whose jobs run until `finishJobs` is called. */
const freshQueue = () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	finishJobs = release;
	const queue = new InMemoryQueue({ resolveConcurrency: () => 1 });
	const started: string[] = [];
	queue.process(async (job) => {
		started.push((job.data as { composeId: string }).composeId);
		await gate;
	});
	mocks.queue = queue;
	return { queue, started };
};

const deployOf = (composeId: string) => ({
	composeId,
	titleLog: "Manual deployment",
	descriptionLog: "",
	type: "deploy" as const,
	applicationType: "compose" as const,
});

/** Nothing of a Fetch ran: no clone, no command, no services read. */
const expectNothingRan = () => {
	expect(mocks.loadServices).not.toHaveBeenCalled();
	expect(mocks.getComposeRollingReport).not.toHaveBeenCalled();
	expect(mocks.cloneCompose).not.toHaveBeenCalled();
	expect(mocks.randomizeIsolatedDeploymentComposeFile).not.toHaveBeenCalled();
	expect(mocks.execAsync).not.toHaveBeenCalled();
	expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
};

beforeEach(() => {
	vi.clearAllMocks();
	finishJobs();
	freshQueue();
	mocks.role = "reader";
	// A reader may read the service; only a deployer may deploy or edit it.
	mocks.checkServicePermissionAndAccess.mockImplementation(
		async (
			_ctx: unknown,
			_id: string,
			permissions: Record<string, string[]>,
		) => {
			const needsMore =
				permissions.deployment !== undefined ||
				permissions.service?.some((action) => action !== "read");
			if (needsMore && mocks.role === "reader") {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "Permission denied",
				});
			}
		},
	);
	mocks.findComposeById.mockResolvedValue(composeRow);
	mocks.loadServices.mockResolvedValue(["web", "db"]);
	mocks.getComposeRollingReport.mockResolvedValue({ available: true });
	mocks.cloneCompose.mockResolvedValue("clone;");
	mocks.randomizeIsolatedDeploymentComposeFile.mockResolvedValue("services:");
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("compose.loadServices permission", { timeout: 60_000 }, () => {
	it("refuses a Fetch for a read-only member and runs nothing", async () => {
		await expect(
			caller.loadServices({ composeId: "cmp-1", type: "fetch" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"cmp-1",
			{ deployment: ["create"] },
		);
		expectNothingRan();
	});

	it("lets a read-only member read the cached services", async () => {
		await expect(
			caller.loadServices({ composeId: "cmp-1", type: "cache" }),
		).resolves.toEqual(["web", "db"]);

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"cmp-1",
			{ service: ["read"] },
		);
		expect(mocks.loadServices).toHaveBeenCalledWith("cmp-1", "cache");
	});

	it("reads the cache when no type is given", async () => {
		await caller.loadServices({ composeId: "cmp-1" });

		expect(mocks.loadServices).toHaveBeenCalledWith("cmp-1", "cache");
	});

	it("lets a member who may deploy Fetch when the compose is idle", async () => {
		mocks.role = "deployer";

		await expect(
			caller.loadServices({ composeId: "cmp-1", type: "fetch" }),
		).resolves.toEqual(["web", "db"]);

		expect(mocks.loadServices).toHaveBeenCalledWith("cmp-1", "fetch");
	});

	it("refuses rollingEligibility's Fetch for a read-only member, and serves its cache", async () => {
		await expect(
			caller.rollingEligibility({ composeId: "cmp-1", type: "fetch" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expectNothingRan();

		await caller.rollingEligibility({ composeId: "cmp-1", type: "cache" });
		expect(mocks.getComposeRollingReport).toHaveBeenCalledWith("cmp-1", {
			type: "cache",
		});
	});

	it("needs the deploy permission for fetchSourceType and the isolated deployment preview", async () => {
		await expect(
			caller.fetchSourceType({ composeId: "cmp-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			caller.isolatedDeployment({ composeId: "cmp-1", suffix: "x" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });

		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"cmp-1",
			{ service: ["create"], deployment: ["create"] },
		);
		expectNothingRan();
	});
});

describe("compose Fetch and the deploy queue", { timeout: 60_000 }, () => {
	beforeEach(() => {
		mocks.role = "deployer";
	});

	it("is refused while a deployment of the compose runs, and runs nothing", async () => {
		await mocks.queue?.add(deployOf("cmp-1"));
		await flush();

		await expect(
			caller.loadServices({ composeId: "cmp-1", type: "fetch" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: COMPOSE_FETCH_BUSY_MESSAGE,
		});
		expectNothingRan();
	});

	it("is refused while a deployment of the compose is queued, and runs nothing", async () => {
		// Another compose takes the only slot, so this compose's deploy waits.
		await mocks.queue?.add(deployOf("cmp-other"));
		await flush();
		await mocks.queue?.add(deployOf("cmp-1"));

		for (const attempt of [
			caller.loadServices({ composeId: "cmp-1", type: "fetch" }),
			caller.rollingEligibility({ composeId: "cmp-1", type: "fetch" }),
			caller.fetchSourceType({ composeId: "cmp-1" }),
			caller.isolatedDeployment({ composeId: "cmp-1", suffix: "x" }),
		]) {
			await expect(attempt).rejects.toMatchObject({
				code: "CONFLICT",
				message: COMPOSE_FETCH_BUSY_MESSAGE,
			});
		}
		expectNothingRan();
	});

	it("still serves the cache while a deployment runs", async () => {
		await mocks.queue?.add(deployOf("cmp-1"));
		await flush();

		await expect(
			caller.loadServices({ composeId: "cmp-1", type: "cache" }),
		).resolves.toEqual(["web", "db"]);
	});

	it("is allowed while only another compose deploys", async () => {
		await mocks.queue?.add(deployOf("cmp-other"));
		await flush();

		await expect(
			caller.loadServices({ composeId: "cmp-1", type: "fetch" }),
		).resolves.toEqual(["web", "db"]);
	});

	it("holds a deploy of the compose back until the Fetch is done", async () => {
		const { started } = freshQueue();
		let finishClone!: () => void;
		mocks.loadServices.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishClone = () => resolve(["web"]);
				}),
		);

		const fetching = caller.loadServices({ composeId: "cmp-1", type: "fetch" });
		await flush();
		await mocks.queue?.add(deployOf("cmp-1"));
		await flush();
		expect(started).toEqual([]);

		finishClone();
		await fetching;
		await flush();
		expect(started).toEqual(["cmp-1"]);
	});

	it("gives the lock back when the clone fails", async () => {
		mocks.cloneCompose.mockRejectedValueOnce(new Error("clone failed"));

		await expect(
			caller.fetchSourceType({ composeId: "cmp-1" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(caller.fetchSourceType({ composeId: "cmp-1" })).resolves.toBe(
			"github",
		);
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
	});
});
