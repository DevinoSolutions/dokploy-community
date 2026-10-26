import {
	assertTraefikInstalled,
	hasTraefikBackup,
} from "@dokploy/server/services/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Between a recreate's rename and its create only dokploy-traefik-previous
// exists. A second save then waits in the queue instead of being refused as
// "not found".

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	present: new Set<string>(),
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

// getDockerResourceType asks `docker inspect` about the name in its script.
const answer = async (command: string) => {
	const name = /RESOURCE_NAME="([^"]+)"/.exec(command)?.[1] ?? "";
	return { stdout: mocks.present.has(name) ? "standalone\n" : "unknown\n" };
};

describe("assertTraefikInstalled", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.present = new Set();
		mocks.execAsync.mockImplementation(answer);
		mocks.execAsyncRemote.mockImplementation((_serverId: string, command) =>
			answer(command),
		);
	});

	it("passes when dokploy-traefik exists", async () => {
		mocks.present = new Set(["dokploy-traefik"]);

		await expect(assertTraefikInstalled()).resolves.toBeUndefined();
	});

	it("passes while only dokploy-traefik-previous exists", async () => {
		mocks.present = new Set(["dokploy-traefik-previous"]);

		await expect(assertTraefikInstalled()).resolves.toBeUndefined();
	});

	it("passes while only dokploy-traefik-previous exists on a remote server", async () => {
		mocks.present = new Set(["dokploy-traefik-previous"]);

		await expect(assertTraefikInstalled("server-a")).resolves.toBeUndefined();
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-a",
			expect.stringContaining("dokploy-traefik-previous"),
		);
	});

	it("is refused when the host has neither", async () => {
		await expect(assertTraefikInstalled()).rejects.toMatchObject({
			name: "DockerResourceNotFoundError",
		});
	});
});

describe("hasTraefikBackup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.present = new Set();
		mocks.execAsync.mockImplementation(answer);
	});

	it("is true while dokploy-traefik-previous exists", async () => {
		mocks.present = new Set(["dokploy-traefik-previous"]);

		await expect(hasTraefikBackup()).resolves.toBe(true);
	});

	it("is false when only the live Traefik exists", async () => {
		mocks.present = new Set(["dokploy-traefik"]);

		await expect(hasTraefikBackup()).resolves.toBe(false);
	});

	it("is false when docker cannot be asked", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.execAsync.mockRejectedValue(new Error("docker: command not found"));

		await expect(hasTraefikBackup()).resolves.toBe(false);
	});
});
