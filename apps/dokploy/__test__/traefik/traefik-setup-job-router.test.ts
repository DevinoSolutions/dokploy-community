import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	isRootOrganization: vi.fn(),
	assertRunningTraefikImageKept: vi.fn(),
	assertTraefikInstalled: vi.fn(),
	checkPortInUse: vi.fn(),
	prepareEnvironmentVariables: vi.fn((env: string) =>
		env ? env.split("\n") : [],
	),
	writeTraefikSetup: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	...mocks,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");
const { clearTraefikSetupJobs } = await import(
	"@/server/api/utils/traefik-setup-jobs"
);

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "admin@example.com", role: "admin" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const saves = [
	[
		"save Traefik env",
		(jobId?: string) =>
			caller.writeTraefikEnv({ env: "A=1", serverId: "server-a", jobId }),
	],
	[
		"save port mappings",
		(jobId?: string) =>
			caller.updateTraefikPorts({
				serverId: "server-a",
				jobId,
				additionalPorts: [
					{ targetPort: 9000, publishedPort: 9000, protocol: "tcp" },
				],
			}),
	],
	[
		"dashboard toggle",
		(jobId?: string) =>
			caller.toggleDashboard({
				enableDashboard: true,
				serverId: "server-a",
				jobId,
			}),
	],
] as const;

describe("routine Traefik actions report how their queued recreate ended", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearTraefikSetupJobs();
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: serverId === "server-b" ? "org-b" : "org-a",
		}));
		mocks.isRootOrganization.mockResolvedValue(true);
		mocks.assertRunningTraefikImageKept.mockResolvedValue(undefined);
		mocks.assertTraefikInstalled.mockResolvedValue(undefined);
		mocks.checkPortInUse.mockResolvedValue({ isInUse: false });
		mocks.writeTraefikSetup.mockResolvedValue(undefined);
	});

	it.each(saves)(
		"%s is pending while the recreate runs, and done after it",
		async (_name, save) => {
			let finish: () => void = () => {};
			mocks.writeTraefikSetup.mockReturnValue(
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			);

			await expect(save("run-1")).resolves.toBe(true);
			await expect(
				caller.getTraefikSetupJob({ serverId: "server-a", jobId: "run-1" }),
			).resolves.toEqual({ state: "pending", error: null });

			finish();
			await flush();
			await expect(
				caller.getTraefikSetupJob({ serverId: "server-a", jobId: "run-1" }),
			).resolves.toEqual({ state: "done", error: null });
		},
	);

	it.each(saves)(
		"%s reports the failure of its own run only",
		async (_name, save) => {
			mocks.writeTraefikSetup.mockRejectedValueOnce(
				new Error("Cannot rename container\nsecond line"),
			);
			await expect(save("bad-run")).resolves.toBe(true);
			await flush();
			await expect(save("good-run")).resolves.toBe(true);
			await flush();

			await expect(
				caller.getTraefikSetupJob({ serverId: "server-a", jobId: "bad-run" }),
			).resolves.toEqual({
				state: "failed",
				error: "Cannot rename container\nsecond line",
			});
			await expect(
				caller.getTraefikSetupJob({ serverId: "server-a", jobId: "good-run" }),
			).resolves.toEqual({ state: "done", error: null });
		},
	);

	it.each(saves)(
		"%s without a job id still returns true and queues the recreate",
		async (_name, save) => {
			await expect(save()).resolves.toBe(true);
			expect(mocks.writeTraefikSetup).toHaveBeenCalledOnce();
		},
	);

	it("keeps the local host's runs apart from a server's", async () => {
		await caller.writeTraefikEnv({
			env: "A=1",
			serverId: "server-a",
			jobId: "same-id",
		});

		await expect(
			caller.getTraefikSetupJob({ jobId: "same-id" }),
		).resolves.toEqual({ state: "unknown", error: null });
	});

	it("says unknown for a run it never saw", async () => {
		await expect(
			caller.getTraefikSetupJob({ serverId: "server-a", jobId: "nope" }),
		).resolves.toEqual({ state: "unknown", error: null });
	});

	it("refuses to report runs of another organization's server", async () => {
		await expect(
			caller.getTraefikSetupJob({ serverId: "server-b", jobId: "run-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("refuses an empty or oversized job id", async () => {
		await expect(save("")).rejects.toBeDefined();
		await expect(save("x".repeat(65))).rejects.toBeDefined();
		expect(mocks.writeTraefikSetup).not.toHaveBeenCalled();

		function save(jobId: string) {
			return caller.writeTraefikEnv({
				env: "A=1",
				serverId: "server-a",
				jobId,
			});
		}
	});
});
