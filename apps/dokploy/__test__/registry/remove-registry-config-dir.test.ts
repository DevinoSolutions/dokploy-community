import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	deleted: [] as unknown[],
	servers: [] as { serverId: string }[],
	serversError: undefined as Error | undefined,
	isCloud: false,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/constants", () => ({
	get IS_CLOUD() {
		return mocks.isCloud;
	},
	paths: (isRemote: boolean) => ({
		BASE_PATH: isRemote ? "/etc/dokploy" : "/local/dokploy",
	}),
}));
vi.mock("@dokploy/server/db", () => ({
	db: {
		delete: () => ({
			where: () => ({ returning: async () => mocks.deleted }),
		}),
		query: {
			server: {
				findMany: async () => {
					if (mocks.serversError) throw mocks.serversError;
					return mocks.servers;
				},
			},
		},
	},
}));
vi.mock("@dokploy/server/utils/aws/ecr", () => ({
	getECRAuthToken: vi.fn(),
}));

import {
	getRegistryConfigDirRemovalCommand,
	removeRegistry,
} from "@dokploy/server/services/registry";

const row = (registryId: string) => ({
	registryId,
	registryUrl: "registry.example.com",
	organizationId: "org-1",
});

describe("removeRegistry config dir cleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.deleted = [row("reg-1")];
		mocks.servers = [];
		mocks.serversError = undefined;
		mocks.isCloud = false;
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	});

	it("builds an escaped rm for exactly the registry's own dir", () => {
		expect(getRegistryConfigDirRemovalCommand("reg-1", false)).toBe(
			"rm -rf -- '/local/dokploy/docker-config/reg-1'",
		);
		expect(getRegistryConfigDirRemovalCommand("reg-1", true)).toBe(
			"rm -rf -- '/etc/dokploy/docker-config/reg-1'",
		);
	});

	it("refuses an empty or odd registry id", () => {
		for (const id of ["", "..", "../x", "a/b", "a b", "x; rm -rf /", "$(id)"]) {
			expect(getRegistryConfigDirRemovalCommand(id, false)).toBeNull();
			expect(getRegistryConfigDirRemovalCommand(id, true)).toBeNull();
		}
	});

	it("removes the local dir and keeps the default-config logout", async () => {
		await removeRegistry("reg-1");

		expect(mocks.execAsync).toHaveBeenCalledWith(
			"docker logout 'registry.example.com'",
		);
		expect(mocks.execAsync).toHaveBeenCalledWith(
			"rm -rf -- '/local/dokploy/docker-config/reg-1'",
		);
	});

	it("does not touch the local host in cloud mode", async () => {
		mocks.isCloud = true;
		mocks.servers = [{ serverId: "srv-1" }];

		await removeRegistry("reg-1");

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
	});

	it("fans the removal out to every server of the organization", async () => {
		mocks.servers = [
			{ serverId: "srv-deploy" },
			{ serverId: "srv-build" },
			{ serverId: "srv-compose" },
		];

		await removeRegistry("reg-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(3);
		for (const serverId of ["srv-deploy", "srv-build", "srv-compose"]) {
			expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
				serverId,
				"rm -rf -- '/etc/dokploy/docker-config/reg-1'",
			);
		}
	});

	it("runs no rm at all for an odd registry id", async () => {
		mocks.deleted = [row("../etc")];
		mocks.servers = [{ serverId: "srv-1" }];

		await removeRegistry("../etc");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		const commands = mocks.execAsync.mock.calls.map((c) => String(c[0]));
		expect(commands.some((c) => c.startsWith("rm "))).toBe(false);
	});

	it("still succeeds when a host is unreachable", async () => {
		mocks.servers = [{ serverId: "srv-down" }, { serverId: "srv-up" }];
		mocks.execAsyncRemote.mockImplementation(async (serverId: string) => {
			if (serverId === "srv-down") throw new Error("ssh: connect timed out");
			return { stdout: "", stderr: "" };
		});

		const result = await removeRegistry("reg-1");

		expect(result.registryId).toBe("reg-1");
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
	});

	it("still succeeds when local cleanup, logout or the server lookup fail", async () => {
		mocks.execAsync.mockRejectedValue(new Error("docker missing"));
		mocks.serversError = new Error("db down");

		const result = await removeRegistry("reg-1");

		expect(result.registryId).toBe("reg-1");
	});

	it("still reports a missing row as a failed removal", async () => {
		mocks.deleted = [];

		await expect(removeRegistry("nope")).rejects.toMatchObject({
			message: "Error removing this registry",
		});
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
