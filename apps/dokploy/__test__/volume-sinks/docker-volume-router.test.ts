import { beforeEach, describe, expect, it, vi } from "vitest";

// The docker-volume router reads, writes, deletes and removes any volume of the
// host by name, so it is owner/admin only (T-6822).
const mocks = vi.hoisted(() => ({
	getVolumes: vi.fn(),
	getVolumesSize: vi.fn(),
	listVolumeFiles: vi.fn(),
	readVolumeFile: vi.fn(),
	writeVolumeFile: vi.fn(),
	deleteVolumeFile: vi.fn(),
	getVolumeConfig: vi.fn(),
	removeVolume: vi.fn(),
	findServerById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	getVolumes: mocks.getVolumes,
	getVolumesSize: mocks.getVolumesSize,
	listVolumeFiles: mocks.listVolumeFiles,
	readVolumeFile: mocks.readVolumeFile,
	writeVolumeFile: mocks.writeVolumeFile,
	deleteVolumeFile: mocks.deleteVolumeFile,
	getVolumeConfig: mocks.getVolumeConfig,
	removeVolume: mocks.removeVolume,
	findServerById: mocks.findServerById,
}));

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

const { dockerVolumeRouter } = await import(
	"@/server/api/routers/docker-volume"
);

const callerAs = (role: string) =>
	dockerVolumeRouter.createCaller({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "user@example.com", role },
	} as never);

const calls = (caller: ReturnType<typeof callerAs>) => ({
	getVolumes: () => caller.getVolumes({}),
	getVolumesSize: () => caller.getVolumesSize({}),
	listVolumeFiles: () =>
		caller.listVolumeFiles({ volumeName: "dokploy-postgres", path: "/" }),
	readVolumeFile: () =>
		caller.readVolumeFile({
			volumeName: "dokploy-postgres",
			path: "/PG_VERSION",
		}),
	writeVolumeFile: () =>
		caller.writeVolumeFile({
			volumeName: "someone-elses-data",
			path: "/x",
			content: "y",
		}),
	deleteVolumeFile: () =>
		caller.deleteVolumeFile({ volumeName: "someone-elses-data", path: "/x" }),
	getVolumeConfig: () =>
		caller.getVolumeConfig({ volumeName: "dokploy-postgres" }),
	removeVolume: () => caller.removeVolume({ volumeName: "someone-elses-data" }),
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getVolumes.mockResolvedValue([]);
	mocks.getVolumesSize.mockResolvedValue([]);
	mocks.listVolumeFiles.mockResolvedValue([]);
	mocks.readVolumeFile.mockResolvedValue({ content: "", truncated: false });
	mocks.getVolumeConfig.mockResolvedValue({});
});

describe("dockerVolume router", () => {
	it("refuses every procedure to a plain member, even with docker:read", async () => {
		const member = calls(callerAs("member"));

		for (const [name, call] of Object.entries(member)) {
			await expect(call(), name).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		}
		for (const mock of [
			mocks.getVolumes,
			mocks.getVolumesSize,
			mocks.listVolumeFiles,
			mocks.readVolumeFile,
			mocks.writeVolumeFile,
			mocks.deleteVolumeFile,
			mocks.getVolumeConfig,
			mocks.removeVolume,
		]) {
			expect(mock).not.toHaveBeenCalled();
		}
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("refuses a custom role the same way", async () => {
		const custom = calls(callerAs("reviewers"));

		await expect(custom.removeVolume()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(mocks.removeVolume).not.toHaveBeenCalled();
	});

	it.each(["owner", "admin"])(
		"keeps every procedure working for an %s",
		async (role) => {
			const privileged = calls(callerAs(role));

			for (const [name, call] of Object.entries(privileged)) {
				await expect(call(), name).resolves.not.toThrow();
			}
			expect(mocks.writeVolumeFile).toHaveBeenCalledTimes(1);
			expect(mocks.deleteVolumeFile).toHaveBeenCalledTimes(1);
			expect(mocks.removeVolume).toHaveBeenCalledTimes(1);
			expect(mocks.audit).toHaveBeenCalledTimes(3);
		},
	);

	it("keeps the server-organization check for an owner", async () => {
		mocks.findServerById.mockResolvedValue({ organizationId: "org-b" });

		await expect(
			callerAs("owner").getVolumes({ serverId: "server-b" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.getVolumes).not.toHaveBeenCalled();
	});
});
