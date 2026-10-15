import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// apiReadTraefikConfig validates against the real local paths(), which outside
// production live under the working directory.
const localTraefikPath = vi.hoisted(() => `${process.cwd()}/.docker/traefik`);
const remoteTraefikPath = "/etc/dokploy/traefik";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	readDirectory: vi.fn(),
	readConfigInPath: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(async () => undefined),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	paths: (isServer?: boolean) => ({
		MAIN_TRAEFIK_PATH: isServer ? "/etc/dokploy/traefik" : localTraefikPath,
	}),
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

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "user@example.com", role: "member" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

const write = (filePath: string, serverId?: string) =>
	caller.updateTraefikFile({
		path: filePath,
		traefikConfig: "http: {}",
		serverId,
	});

const read = (filePath: string, serverId?: string) =>
	caller.readTraefikFile({ path: filePath, serverId });

describe("traefik file endpoints are confined to the Traefik config directory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServerById.mockImplementation(async (serverId: string) => ({
			serverId,
			organizationId: "org-a",
		}));
		mocks.readConfigInPath.mockResolvedValue("http: {}");
	});

	describe("local server", () => {
		const inside = path.join(localTraefikPath, "dynamic/app.yml");

		it.each([
			"/etc/dokploy/.env",
			"/root/.ssh/authorized_keys",
			`${localTraefikPath}-evil/app.yml`,
			`${localTraefikPath}/../outside.yml`,
			"../../outside.yml",
			"..",
		])("rejects writing %s and never writes", async (target) => {
			await expect(write(target)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
		});

		it.each([
			"/etc/dokploy/.env",
			`${localTraefikPath}/../outside.yml`,
			"../../outside.yml",
			"..",
		])("rejects reading %s and never reads", async (target) => {
			await expect(read(target)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(mocks.readConfigInPath).not.toHaveBeenCalled();
		});

		it("passes the resolved path for a file inside the directory", async () => {
			await write(inside);
			await read(inside);
			await write("dynamic/app.yml");
			await read("dynamic/app.yml");

			expect(mocks.writeTraefikConfigInPath).toHaveBeenNthCalledWith(
				1,
				path.resolve(inside),
				"http: {}",
				undefined,
			);
			expect(mocks.readConfigInPath).toHaveBeenNthCalledWith(
				1,
				path.resolve(inside),
				undefined,
			);
			expect(mocks.writeTraefikConfigInPath).toHaveBeenNthCalledWith(
				2,
				path.resolve(inside),
				"http: {}",
				undefined,
			);
			expect(mocks.readConfigInPath).toHaveBeenNthCalledWith(
				2,
				path.resolve(inside),
				undefined,
			);
		});
	});

	describe("remote server", () => {
		it.each([
			"/etc/dokploy/.env",
			"/root/.ssh/authorized_keys",
			`${remoteTraefikPath}-evil/app.yml`,
			`${remoteTraefikPath}/../.env`,
			"../.env",
			"..",
		])("rejects writing %s and never writes", async (target) => {
			await expect(write(target, "server-a")).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(mocks.writeTraefikConfigInPath).not.toHaveBeenCalled();
		});

		it.each(["../.env", ".."])(
			"rejects reading %s and never reads",
			async (target) => {
				await expect(read(target, "server-a")).rejects.toMatchObject({
					code: "BAD_REQUEST",
				});
				expect(mocks.readConfigInPath).not.toHaveBeenCalled();
			},
		);

		it("passes the resolved posix path for a file inside the directory", async () => {
			await write("dynamic/app.yml", "server-a");
			await read("dynamic/app.yml", "server-a");

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				`${remoteTraefikPath}/dynamic/app.yml`,
				"http: {}",
				"server-a",
			);
			expect(mocks.readConfigInPath).toHaveBeenCalledWith(
				`${remoteTraefikPath}/dynamic/app.yml`,
				"server-a",
			);
		});

		it("accepts an absolute path under the remote directory for writes", async () => {
			await write(`${remoteTraefikPath}/dynamic/app.yml`, "server-a");

			expect(mocks.writeTraefikConfigInPath).toHaveBeenCalledWith(
				`${remoteTraefikPath}/dynamic/app.yml`,
				"http: {}",
				"server-a",
			);
		});
	});
});
