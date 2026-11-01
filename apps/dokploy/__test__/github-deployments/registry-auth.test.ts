import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadGhcrCredentials: vi.fn(),
	runDockerLogin: vi.fn(),
}));

vi.mock("@dokploy/server/services/github-deployments/store", () => ({
	loadGhcrCredentials: mocks.loadGhcrCredentials,
}));
vi.mock("@dokploy/server/utils/process/dockerLogin", () => ({
	runDockerLogin: mocks.runDockerLogin,
}));

import {
	ghcrAuthConfigForApplication,
	isGhcrImage,
	loginGhcrForApplication,
	loginGhcrForCompose,
} from "@dokploy/server/services/github-deployments/registry-auth";

const TOKEN = "gho_super_secret_token";
const credentials = {
	registryUrl: "ghcr.io",
	username: "amin",
	password: TOKEN,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadGhcrCredentials.mockResolvedValue(credentials);
	mocks.runDockerLogin.mockResolvedValue(undefined);
});

describe("isGhcrImage", () => {
	it("is true only for ghcr.io references", () => {
		expect(isGhcrImage("ghcr.io/o/app@sha256:abc")).toBe(true);
		expect(isGhcrImage("GHCR.IO/o/app")).toBe(true);
		expect(isGhcrImage("docker.io/library/nginx")).toBe(false);
		expect(isGhcrImage("not-ghcr.io/o/app")).toBe(false);
		expect(isGhcrImage(null)).toBe(false);
	});
});

describe("ghcrAuthConfigForApplication", () => {
	it("uses the GitHub login as the username and the token as the password", async () => {
		expect(
			await ghcrAuthConfigForApplication("app1", "ghcr.io/o/app@sha256:abc"),
		).toEqual({ username: "amin", password: TOKEN, serveraddress: "ghcr.io" });
		expect(mocks.loadGhcrCredentials).toHaveBeenCalledWith(
			"application",
			"app1",
		);
	});

	it("does nothing for another registry, and reads no credential", async () => {
		expect(
			await ghcrAuthConfigForApplication("app1", "docker.io/x/y"),
		).toBeUndefined();
		expect(mocks.loadGhcrCredentials).not.toHaveBeenCalled();
	});

	it("does nothing for a service without a watch", async () => {
		mocks.loadGhcrCredentials.mockResolvedValue(null);
		expect(
			await ghcrAuthConfigForApplication("app1", "ghcr.io/o/app"),
		).toBeUndefined();
	});
});

describe("docker login on the deploy host", () => {
	it("compose: logs in to ghcr.io on the stack's server, password handed to the login helper", async () => {
		await loginGhcrForCompose("c1", "server-9");
		expect(mocks.runDockerLogin).toHaveBeenCalledWith(
			{
				registryType: "cloud",
				registryUrl: "ghcr.io",
				username: "amin",
				password: TOKEN,
			},
			"server-9",
		);
	});

	it("compose: a service without a watch triggers no login", async () => {
		mocks.loadGhcrCredentials.mockResolvedValue(null);
		await loginGhcrForCompose("c1", null);
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("application: only for ghcr.io images", async () => {
		await loginGhcrForApplication("app1", "docker.io/x/y", null);
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
		await loginGhcrForApplication("app1", "ghcr.io/o/app@sha256:abc", null);
		expect(mocks.runDockerLogin).toHaveBeenCalledTimes(1);
	});

	it("a failed login never fails the deploy and never prints the token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.runDockerLogin.mockRejectedValue(
			new Error("Registry login failed for ghcr.io: denied"),
		);
		await expect(loginGhcrForCompose("c1", null)).resolves.toBeUndefined();
		await expect(
			loginGhcrForApplication("app1", "ghcr.io/o/app", null),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
		warn.mockRestore();
	});
});
