import { beforeEach, describe, expect, it, vi } from "vitest";

// The chown/chmod -R of a bind mount never runs on a dangerous host path, for
// any caller, and a refused path leaves no saved row behind (T-8806).
const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	insert: vi.fn(),
	transaction: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { mounts: { findFirst: mocks.findFirst } },
		insert: mocks.insert,
		transaction: mocks.transaction,
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const { applyMountPermissions, createMount, updateMount } = await import(
	"@dokploy/server/services/mount"
);

const stored = (extra: Record<string, unknown> = {}) => ({
	mountId: "mount-1",
	type: "bind",
	serviceType: "application",
	hostPath: "/srv/data",
	mountPath: "/data",
	uid: 1000,
	gid: null,
	mode: null,
	application: {
		appName: "app-one-x",
		serverId: null,
		environment: { project: { organizationId: "org-a" } },
	},
	...extra,
});

const insertChain = (row: Record<string, unknown>) => ({
	values: () => ({ returning: () => Promise.resolve([row]) }),
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("applyMountPermissions on a bind mount", () => {
	it("runs the recursive chown on an ordinary host path, guarded against links and special files", async () => {
		mocks.findFirst.mockResolvedValue(stored());
		await applyMountPermissions("mount-1");

		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		const command = mocks.execAsync.mock.calls[0]?.[0] as string;
		expect(command).toContain("chown -R 1000 '/srv/data'");
		expect(command).toContain("[ -d '/srv/data' ] || [ -f '/srv/data' ]");
		expect(command).toContain("[ ! -L '/srv/data' ]");
	});

	it("runs it on the remote server of the service", async () => {
		mocks.findFirst.mockResolvedValue(
			stored({
				application: {
					appName: "app-one-x",
					serverId: "server-1",
					environment: { project: { organizationId: "org-a" } },
				},
			}),
		);
		await applyMountPermissions("mount-1");
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it.each([
		"/",
		"//",
		"/etc",
		"/etc/",
		"/usr/local",
		"/var/run/docker.sock",
		"/var/run/../run/docker.sock",
		"/home",
		"/root/.ssh",
		"/etc/dokploy",
		"/etc/dokploy/ssh",
		"/data/app.sock",
		"data/relative",
	])("never runs it on %s", async (hostPath) => {
		mocks.findFirst.mockResolvedValue(stored({ hostPath, mode: "777" }));
		await expect(applyMountPermissions("mount-1")).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("does nothing for a dangerous host path that has no permission settings", async () => {
		mocks.findFirst.mockResolvedValue(
			stored({ hostPath: "/", uid: null, gid: null, mode: null }),
		);
		await applyMountPermissions("mount-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("createMount", () => {
	const input = {
		serviceId: "svc-1",
		serviceType: "application" as const,
		type: "bind" as const,
		mountPath: "/data",
	};

	it("refuses a dangerous host path with permissions before saving anything", async () => {
		for (const hostPath of ["/", "/etc", "/var/run/docker.sock", "/home/"]) {
			await expect(
				createMount({ ...input, hostPath, uid: 0 }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.insert).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("still saves a bind of any host path that asks for no permission change", async () => {
		mocks.insert.mockReturnValue(
			insertChain(stored({ hostPath: "/var/run/docker.sock", uid: null })),
		);
		mocks.findFirst.mockResolvedValue(
			stored({ hostPath: "/var/run/docker.sock", uid: null }),
		);
		await createMount({ ...input, hostPath: "/var/run/docker.sock" });
		expect(mocks.insert).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("updateMount", () => {
	it("refuses a dangerous host path with permissions before writing", async () => {
		mocks.findFirst.mockResolvedValue(stored({ uid: null }));
		await expect(
			updateMount("mount-1", { hostPath: "/etc", mode: "777" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("refuses to re-apply the permissions saved on a dangerous host path", async () => {
		mocks.findFirst.mockResolvedValue(stored({ hostPath: "/", uid: 0 }));
		await expect(
			updateMount("mount-1", { mountPath: "/other" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("lets a host path that asks for no permission change be updated", async () => {
		mocks.findFirst.mockResolvedValue(
			stored({ hostPath: "/", uid: null, gid: null, mode: null }),
		);
		mocks.transaction.mockImplementation(
			async (run: (tx: unknown) => unknown) =>
				run({
					update: () => ({
						set: () => ({
							where: () => ({
								returning: () => Promise.resolve([{ mountId: "mount-1" }]),
							}),
						}),
					}),
				}),
		);
		await updateMount("mount-1", { mountPath: "/other" });
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
