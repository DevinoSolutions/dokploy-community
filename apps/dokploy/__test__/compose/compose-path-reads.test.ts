import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { parse } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every read of the compose file goes through the compose path rules and
// passes the path as a single argument (T-8238). The remote read runs on the
// serving host, and on the build server for the checks it repeats there.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	getComposePath,
	loadDockerCompose,
	loadDockerComposeRemote,
	readComposeFile,
} from "@dokploy/server/utils/docker/domain";

const compose = (composePath: string, serverId: string | null = "server-1") =>
	({
		appName: "my-app",
		serverId,
		sourceType: "github",
		composePath,
	}) as never;

const remotePath = (composePath: string) =>
	join(paths(true).COMPOSE_PATH, "my-app", "code", composePath);

// The arguments of the command, with variables left as written.
const words = (command: string) => parse(command, (name) => `$${name}`);

describe("reading the compose file on a remote host", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "services:\n  web:\n    image: nginx\n",
			stderr: "",
		});
	});

	it.each([
		["the serving host", "server-1"],
		["the build server", "build-1"],
	])("passes the path to cat as one word on %s", async (_host, serverId) => {
		const composePath = "deploy/my stack [prod] #1.yml";

		const spec = await loadDockerComposeRemote(compose(composePath, serverId));

		expect(spec?.services).toHaveProperty("web");
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		const [host, command] = mocks.execAsyncRemote.mock.calls[0] as [
			string,
			string,
		];
		expect(host).toBe(serverId);
		// The read is guarded against a link out of the checkout (T-7857); the
		// path is still one word of the `cat` it runs.
		const read = /then (cat [^;]*); else printf/.exec(command)?.[1] ?? "";
		expect(words(read)).toEqual(["cat", remotePath(composePath)]);
	});

	it.each([
		"x.yml;y.yml",
		"a$b.yml",
		"a`b.yml",
		"x.yml|y.yml",
		"x.yml\ny.yml",
		"../other-app/code/docker-compose.yml",
		"/srv/other/docker-compose.yml",
	])("refuses the stored path %j without running anything", async (path) => {
		await expect(loadDockerComposeRemote(compose(path))).rejects.toThrow(
			/^Compose refused: /,
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("reading the compose file on this host", () => {
	it.each([
		"../other-app/code/docker-compose.yml",
		"/srv/other/docker-compose.yml",
	])("refuses the stored path %j", async (path) => {
		await expect(loadDockerCompose(compose(path, null))).rejects.toThrow(
			/^Compose refused: /,
		);
		await expect(readComposeFile(compose(path, null))).rejects.toThrow(
			/^Compose refused: /,
		);
		expect(() => getComposePath(compose(path, null))).toThrow(
			/^Compose refused: /,
		);
	});

	it("still resolves a raw compose to its own file", () => {
		expect(
			getComposePath({
				appName: "my-app",
				serverId: null,
				sourceType: "raw",
				composePath: "./docker-compose.yml",
			} as never),
		).toBe(
			join(paths(false).COMPOSE_PATH, "my-app", "code", "docker-compose.yml"),
		);
	});
});
