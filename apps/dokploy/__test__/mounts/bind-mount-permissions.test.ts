import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		expect(command).toContain("chown -h -R -P -- 1000 '/srv/data'");
		expect(command).toContain("[ -d '/srv/data' ] || [ -f '/srv/data' ]");
		expect(command).toContain("[ ! -L '/srv/data' ]");
		expect(command).toContain(`[ "$(realpath -- '/srv/data')" = '/srv/data' ]`);
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
		"/home/deploy/.ssh",
		"/var/log",
		"/srv/data/",
		"/srv//data",
		"/srv/link/..",
		"/srv/a/../b",
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

	const updateRuns = () =>
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

	it("keeps a stored bind on a dangerous host path editable for its other fields, without touching the host", async () => {
		updateRuns();
		for (const hostPath of ["/", "/root/data", "/etc/myapp"]) {
			mocks.findFirst.mockResolvedValue(stored({ hostPath, uid: 1000 }));
			await updateMount("mount-1", { mountPath: "/other" });
			// the same values sent again are not a change either
			await updateMount("mount-1", { hostPath, uid: 1000, mountPath: "/x" });
		}
		expect(mocks.transaction).toHaveBeenCalledTimes(6);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("refuses new permissions on a stored dangerous host path", async () => {
		mocks.findFirst.mockResolvedValue(stored({ hostPath: "/", uid: 0 }));
		for (const patch of [{ uid: 1 }, { gid: 1 }, { mode: "777" }]) {
			await expect(updateMount("mount-1", patch)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("applies the permissions of a stored bind only when they changed", async () => {
		updateRuns();
		mocks.findFirst.mockResolvedValue(stored());
		await updateMount("mount-1", { mountPath: "/other" });
		expect(mocks.execAsync).not.toHaveBeenCalled();
		await updateMount("mount-1", { uid: 2000 });
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
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

// The generated command is run for real, against a temp tree with links in it.
describe.skipIf(process.platform !== "linux")(
	"the permission command, executed",
	() => {
		let dir = "";
		const modeOf = (path: string) => statSync(path).mode & 0o777;

		const applyTo = async (hostPath: string) => {
			mocks.findFirst.mockResolvedValue(
				stored({ hostPath, uid: process.getuid?.(), mode: "750" }),
			);
			mocks.execAsync.mockImplementation(async (command: string) => {
				execFileSync("sh", ["-c", command], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				return { stdout: "", stderr: "" };
			});
			await applyMountPermissions("mount-1");
		};

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "bind-mount-policy-"));
			mkdirSync(join(dir, "real", "sub"), { recursive: true });
			writeFileSync(join(dir, "real", "sub", "f"), "x");
			mkdirSync(join(dir, "outside"));
			symlinkSync(join(dir, "real"), join(dir, "link"));
			symlinkSync(join(dir, "outside"), join(dir, "real", "inner"));
			for (const name of ["real", "real/sub", "real/sub/f", "outside"]) {
				execFileSync("chmod", ["700", join(dir, name)]);
			}
		});

		afterEach(() => {
			if (dir) rmSync(dir, { recursive: true, force: true });
		});

		it("changes the real directory and what is in it, and nothing a link inside it points to", async () => {
			await applyTo(join(dir, "real"));
			expect(modeOf(join(dir, "real"))).toBe(0o750);
			expect(modeOf(join(dir, "real", "sub"))).toBe(0o750);
			expect(modeOf(join(dir, "real", "sub", "f"))).toBe(0o750);
			expect(modeOf(join(dir, "outside"))).toBe(0o700);
		});

		const notApplied = {
			code: "BAD_REQUEST",
			message: expect.stringMatching(/not applied.*symlink/i),
		};

		it("reports that nothing was applied for a path that is a symlink", async () => {
			await expect(applyTo(join(dir, "link"))).rejects.toMatchObject(
				notApplied,
			);
			expect(modeOf(join(dir, "real"))).toBe(0o700);
		});

		it("reports that nothing was applied for a path that goes through a symlink", async () => {
			await expect(applyTo(join(dir, "link", "sub"))).rejects.toMatchObject(
				notApplied,
			);
			expect(modeOf(join(dir, "real", "sub"))).toBe(0o700);
			await expect(applyTo(join(dir, "real", "inner"))).rejects.toMatchObject(
				notApplied,
			);
			expect(modeOf(join(dir, "outside"))).toBe(0o700);
		});

		it("still skips quietly a path that does not exist yet", async () => {
			await applyTo(join(dir, "not-created-yet"));
			expect(modeOf(join(dir, "real"))).toBe(0o700);
		});

		it("does not hide another failure behind the symlink message", async () => {
			mocks.findFirst.mockResolvedValue(
				stored({ hostPath: join(dir, "real"), uid: 1, mode: "750" }),
			);
			mocks.execAsync.mockRejectedValue(new Error("chown: permission denied"));
			await expect(applyMountPermissions("mount-1")).rejects.toThrow(
				"permission denied",
			);
		});

		it("never reaches a link through a trailing slash or a dot-dot segment", async () => {
			for (const hostPath of [
				`${join(dir, "link")}/`,
				join(dir, "link", "sub", ".."),
				join(dir, "real", "inner", ".."),
			]) {
				await expect(applyTo(hostPath)).rejects.toMatchObject({
					code: "BAD_REQUEST",
				});
			}
			expect(modeOf(join(dir, "real"))).toBe(0o700);
			expect(modeOf(join(dir, "outside"))).toBe(0o700);
		});
	},
);
