import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
	getGhcrConfigDirRemovalCommandForPath,
	getGhcrConfigSeedCommand,
	getGhcrWatchConfigDir,
	getGhcrWatchConfigDirRemovalCommand,
	ghcrAuthConfigForApplication,
	isImageOfOwner,
	loginGhcrForApplication,
	loginGhcrForCompose,
	removeGhcrConfigDir,
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

describe("the config dir is removed as soon as the pull / up that used it has ended", () => {
	const DIR = "/etc/dokploy/docker-config/ghcr-w_1-Abc";

	it("builds an rm of exactly a watch's dir and nothing else", () => {
		expect(getGhcrConfigDirRemovalCommandForPath(DIR)).toBe(
			`rm -rf -- '${DIR}'`,
		);
		for (const odd of [
			undefined,
			null,
			"",
			"/etc/dokploy/docker-config",
			"/etc/dokploy/docker-config/",
			"/etc/dokploy/docker-config/registry-1",
			"/etc/dokploy/docker-config/ghcr-",
			"/etc/dokploy/docker-config/ghcr-a/..",
			"/etc/dokploy/docker-config/ghcr-a b",
			"/etc/dokploy/docker-config/ghcr-a;rm -rf /",
			"docker-config/ghcr-w1",
			"/",
		]) {
			expect(
				getGhcrConfigDirRemovalCommandForPath(odd),
				String(odd),
			).toBeNull();
		}
	});

	it("removes the dir on this host, or on the stack's server", async () => {
		await removeGhcrConfigDir(DIR, null);
		expect(mocks.execAsync).toHaveBeenCalledWith(`rm -rf -- '${DIR}'`);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		await removeGhcrConfigDir(DIR, "server-1");
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			`rm -rf -- '${DIR}'`,
		);
	});

	it("does nothing without a dir, and never throws when the host cannot be reached", async () => {
		await removeGhcrConfigDir(undefined, "server-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.execAsyncRemote.mockRejectedValueOnce(new Error("ssh down"));
		await expect(removeGhcrConfigDir(DIR, "server-1")).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
		warn.mockRestore();
	});
});

describe("the watch's config dir keeps the host's other logins", () => {
	it("seeds the dir before the ghcr login, on the same host", async () => {
		await loginGhcrForCompose("c1", null, COMPOSE);
		await loginGhcrForCompose("c1", "server-9", COMPOSE);
		const dir = (host: boolean) => getGhcrWatchConfigDir("w_1-Abc", host);
		expect(mocks.execAsync.mock.calls[0]?.[0]).toBe(
			getGhcrConfigSeedCommand(dir(false)),
		);
		expect(mocks.execAsyncRemote.mock.calls[0]).toEqual([
			"server-9",
			getGhcrConfigSeedCommand(dir(true)),
		]);
		expect(mocks.execAsync.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runDockerLogin.mock.invocationCallOrder[0] as number,
		);
	});

	it("a seed that fails does not fail the deploy: the login still runs", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.execAsync.mockRejectedValueOnce(new Error("no shell"));
		const dir = await loginGhcrForApplication("app1", IMAGE, null);
		expect(dir).toBeDefined();
		expect(mocks.runDockerLogin).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	describe.skipIf(process.platform === "win32")("in a real shell", () => {
		const root = mkdtempSync(join(tmpdir(), "ghcr-seed-"));
		afterAll(() => rmSync(root, { recursive: true, force: true }));

		const run = (home: string, dir: string) =>
			execFileSync(
				"timeout",
				["-k", "5", "20", "sh", "-c", getGhcrConfigSeedCommand(dir)],
				{
					env: { ...process.env, HOME: home },
					timeout: 30_000,
				},
			);

		it("copies the default config (a pre-existing login stays available), links cli-plugins and leaves the default config untouched", () => {
			const home = join(root, "home1");
			const docker = join(home, ".docker");
			mkdirSync(join(docker, "cli-plugins"), { recursive: true });
			const original = JSON.stringify({
				auths: {
					"registry.example.com": { auth: "dXNlcjpwdw==" },
					"https://index.docker.io/v1/": { auth: "aHViOnB3" },
				},
				credsStore: "desktop",
				credHelpers: { "ghcr.io": "pass" },
			});
			writeFileSync(join(docker, "config.json"), original);
			const dir = join(root, "docker-config", "ghcr-w1");

			run(home, dir);

			const seeded = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
			// The deploy still sees the build-server / Docker Hub / private registry logins.
			expect(Object.keys(seeded.auths)).toEqual([
				"registry.example.com",
				"https://index.docker.io/v1/",
			]);
			// A credential helper would take the ghcr token into the host's shared
			// store: both keys are inert in the copy.
			expect(seeded.credsStore).toBeUndefined();
			expect(seeded.credHelpers).toBeUndefined();
			expect(seeded["x-dokploy-ignored-credsStore"]).toBe("desktop");
			// Plugins (docker compose) are still found.
			expect(lstatSync(join(dir, "cli-plugins")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(dir, "cli-plugins"))).toBe(
				join(docker, "cli-plugins"),
			);
			// The default config was only read.
			expect(readFileSync(join(docker, "config.json"), "utf8")).toBe(original);
			expect(existsSync(join(docker, "config.json.seed"))).toBe(false);
			// Private: the copy holds other registries' credentials.
			expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
			expect(statSync(dir).mode & 0o777).toBe(0o700);
		});

		it("re-seeding replaces a stale copy, and a host without a default config gets an empty dir", () => {
			const home = join(root, "home2");
			mkdirSync(join(home, ".docker"), { recursive: true });
			const dir = join(root, "docker-config", "ghcr-w2");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ auths: { "old.example.com": {} } }),
			);
			writeFileSync(
				join(home, ".docker", "config.json"),
				JSON.stringify({ auths: { "new.example.com": {} } }),
			);
			run(home, dir);
			expect(
				Object.keys(
					JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).auths,
				),
			).toEqual(["new.example.com"]);

			const bare = join(root, "home3");
			mkdirSync(bare, { recursive: true });
			const bareDir = join(root, "docker-config", "ghcr-w3");
			run(bare, bareDir);
			expect(existsSync(bareDir)).toBe(true);
			expect(existsSync(join(bareDir, "config.json"))).toBe(false);
			expect(existsSync(join(bareDir, "cli-plugins"))).toBe(false);
		});
	});
});
