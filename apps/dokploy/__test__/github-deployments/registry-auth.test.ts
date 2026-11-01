import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadGhcrCredentials: vi.fn(),
	runDockerLogin: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findServers: vi.fn(),
}));

vi.mock("@dokploy/server/services/github-deployments/store", () => ({
	loadGhcrCredentials: mocks.loadGhcrCredentials,
}));
vi.mock("@dokploy/server/utils/process/dockerLogin", () => ({
	runDockerLogin: mocks.runDockerLogin,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/db", () => ({
	db: { query: { server: { findMany: mocks.findServers } } },
}));

import {
	composeHasImageOfOwner,
	getGhcrWatchConfigDir,
	getGhcrWatchConfigDirRemovalCommand,
	ghcrAuthConfigForApplication,
	isImageOfOwner,
	loginGhcrForApplication,
	loginGhcrForCompose,
	removeGhcrWatchConfigDirs,
} from "@dokploy/server/services/github-deployments/registry-auth";
import { getRegistryConfigDir } from "@dokploy/server/utils/process/dockerConfig";

const TOKEN = "gho_super_secret_token";
const credentials = {
	watchId: "w_1-Abc",
	owner: "DevinoSolutions",
	registryUrl: "ghcr.io",
	username: "amin",
	password: TOKEN,
};
const IMAGE = "ghcr.io/devinosolutions/sendly-web@sha256:abc";
const COMPOSE = `services:\n  web:\n    image: ${IMAGE}\n`;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadGhcrCredentials.mockResolvedValue(credentials);
	mocks.runDockerLogin.mockResolvedValue(undefined);
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.findServers.mockResolvedValue([]);
});

describe("which images the login may serve", () => {
	it("is limited to ghcr.io/<watched owner>/, case-insensitively", () => {
		expect(isImageOfOwner(IMAGE, "DevinoSolutions")).toBe(true);
		expect(
			isImageOfOwner("GHCR.IO/DevinoSolutions/app", "devinosolutions"),
		).toBe(true);
		// Another owner's private image, another registry, a look-alike prefix.
		expect(isImageOfOwner("ghcr.io/someone-else/app", "DevinoSolutions")).toBe(
			false,
		);
		expect(
			isImageOfOwner("ghcr.io/devinosolutions-evil/app", "devinosolutions"),
		).toBe(false);
		expect(isImageOfOwner("docker.io/library/nginx", "devinosolutions")).toBe(
			false,
		);
		expect(isImageOfOwner(null, "devinosolutions")).toBe(false);
	});

	it("a compose file qualifies only when it runs an image of the owner", () => {
		expect(composeHasImageOfOwner(COMPOSE, "DevinoSolutions")).toBe(true);
		expect(
			composeHasImageOfOwner(
				"services:\n  web:\n    image: 'ghcr.io/devinosolutions/x:1'\n",
				"devinosolutions",
			),
		).toBe(true);
		expect(
			composeHasImageOfOwner(
				"services:\n  web:\n    image: ghcr.io/other/x@sha256:abc\n",
				"devinosolutions",
			),
		).toBe(false);
		expect(composeHasImageOfOwner("", "devinosolutions")).toBe(false);
		expect(composeHasImageOfOwner(null, "devinosolutions")).toBe(false);
	});
});

describe("ghcrAuthConfigForApplication", () => {
	it("uses the GitHub login as the username and the token as the password", async () => {
		expect(await ghcrAuthConfigForApplication("app1", IMAGE)).toEqual({
			username: "amin",
			password: TOKEN,
			serveraddress: "ghcr.io",
		});
		expect(mocks.loadGhcrCredentials).toHaveBeenCalledWith(
			"application",
			"app1",
		);
	});

	it("does not offer the token to another registry or to another owner's ghcr.io image", async () => {
		expect(
			await ghcrAuthConfigForApplication("app1", "docker.io/x/y"),
		).toBeUndefined();
		expect(
			await ghcrAuthConfigForApplication("app1", "ghcr.io/other/private-app"),
		).toBeUndefined();
	});

	it("does nothing for a service without a watch", async () => {
		mocks.loadGhcrCredentials.mockResolvedValue(null);
		expect(await ghcrAuthConfigForApplication("app1", IMAGE)).toBeUndefined();
	});
});

describe("the login goes to the watch's own docker config dir, never the default one", () => {
	it("names a dir per watch under docker-config, on the host kind that runs it", () => {
		expect(getGhcrWatchConfigDir("w_1-Abc", false)).toMatch(
			/\/docker-config\/ghcr-w_1-Abc$/,
		);
		expect(getGhcrWatchConfigDir("w_1-Abc", true)).toMatch(
			/\/docker-config\/ghcr-w_1-Abc$/,
		);
		// Not the dir of any registry row.
		expect(getGhcrWatchConfigDir("w_1-Abc", false)).not.toBe(
			getRegistryConfigDir("w_1-Abc", false),
		);
		expect(() => getGhcrWatchConfigDir("../etc", false)).toThrow();
	});

	it("compose: logs in with a configDir on the stack's server and returns it for the deploy", async () => {
		const dir = await loginGhcrForCompose("c1", "server-9", COMPOSE);
		expect(dir).toBe(getGhcrWatchConfigDir("w_1-Abc", true));
		expect(mocks.runDockerLogin).toHaveBeenCalledWith(
			{
				configDir: dir,
				registryType: "cloud",
				registryUrl: "ghcr.io",
				username: "amin",
				password: TOKEN,
			},
			"server-9",
		);
	});

	it("application: the local host uses the local base path", async () => {
		const dir = await loginGhcrForApplication("app1", IMAGE, null);
		expect(dir).toBe(getGhcrWatchConfigDir("w_1-Abc", false));
		expect(mocks.runDockerLogin.mock.calls[0]?.[0]).toMatchObject({
			configDir: dir,
		});
	});

	it("every login names a configDir: the default docker config is never written", async () => {
		await loginGhcrForCompose("c1", null, COMPOSE);
		await loginGhcrForCompose("c1", "s1", COMPOSE);
		await loginGhcrForApplication("app1", IMAGE, null);
		await loginGhcrForApplication("app1", IMAGE, "s2");
		expect(mocks.runDockerLogin).toHaveBeenCalledTimes(4);
		for (const [data] of mocks.runDockerLogin.mock.calls) {
			expect(typeof data.configDir).toBe("string");
			expect(data.configDir).toContain("/docker-config/ghcr-");
		}
	});

	it("compose: no watch, or no image of the watched owner, triggers no login", async () => {
		mocks.loadGhcrCredentials.mockResolvedValue(null);
		expect(await loginGhcrForCompose("c1", null, COMPOSE)).toBeUndefined();
		mocks.loadGhcrCredentials.mockResolvedValue(credentials);
		expect(
			await loginGhcrForCompose(
				"c1",
				null,
				"services:\n  web:\n    image: ghcr.io/other/x@sha256:abc\n",
			),
		).toBeUndefined();
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("application: only for an image of the watched owner", async () => {
		expect(
			await loginGhcrForApplication("app1", "docker.io/x/y", null),
		).toBeUndefined();
		expect(
			await loginGhcrForApplication("app1", "ghcr.io/other/app", null),
		).toBeUndefined();
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("a failed login never fails the deploy, returns no dir and never prints the token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.runDockerLogin.mockRejectedValue(
			new Error("Registry login failed for ghcr.io: denied"),
		);
		await expect(
			loginGhcrForCompose("c1", null, COMPOSE),
		).resolves.toBeUndefined();
		await expect(
			loginGhcrForApplication("app1", IMAGE, null),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
		warn.mockRestore();
	});
});

describe("the config dir is removed with the watch or the connection", () => {
	it("builds an rm of exactly the watch's dir and refuses an odd id", () => {
		expect(getGhcrWatchConfigDirRemovalCommand("w_1-Abc", false)).toMatch(
			/^rm -rf -- '.*\/docker-config\/ghcr-w_1-Abc'$/,
		);
		expect(getGhcrWatchConfigDirRemovalCommand("", false)).toBeNull();
		expect(getGhcrWatchConfigDirRemovalCommand("a/../..", false)).toBeNull();
		expect(getGhcrWatchConfigDirRemovalCommand("a b", true)).toBeNull();
	});

	it("removes the dirs on this host and on every server of the organization", async () => {
		mocks.findServers.mockResolvedValue([
			{ serverId: "s1" },
			{ serverId: "s2" },
		]);
		await removeGhcrWatchConfigDirs(["w1", "w2"], "org-1");
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		const local = mocks.execAsync.mock.calls[0]?.[0] as string;
		expect(local).toContain("ghcr-w1");
		expect(local).toContain("ghcr-w2");
		expect(local).toContain("rm -rf --");
		expect(mocks.execAsyncRemote.mock.calls.map((c) => c[0])).toEqual([
			"s1",
			"s2",
		]);
		for (const call of mocks.execAsyncRemote.mock.calls) {
			expect(call[1]).toContain("ghcr-w1");
		}
	});

	it("does nothing for no watches, and a host that cannot be reached does not stop the rest", async () => {
		await removeGhcrWatchConfigDirs([], "org-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();

		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.findServers.mockResolvedValue([
			{ serverId: "s1" },
			{ serverId: "s2" },
		]);
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("ssh down"));
		await expect(
			removeGhcrWatchConfigDirs(["w1"], "org-1"),
		).resolves.toBeUndefined();
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});
});
