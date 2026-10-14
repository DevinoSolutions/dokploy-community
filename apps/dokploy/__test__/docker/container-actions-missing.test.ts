import {
	containerKill,
	containerRemove,
	containerRestart,
	containerStart,
	containerStop,
} from "@dokploy/server/services/docker";
import { ExecError } from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const noSuchContainer = (command: string) => {
	const stderr =
		"Error response from daemon: No such container: 71605a1cb15a\n";
	return new ExecError(
		`Command execution failed: Command failed: ${command}\n${stderr}`,
		{ command, stderr, exitCode: 1 },
	);
};

// Sentry DOKPLOY-COMMUNITY-4S / -4T / -4V: acting on a container that a
// redeploy had already replaced surfaced the raw ExecError as a 500.
describe("container actions on a container that no longer exists", () => {
	beforeEach(() => {
		mocks.execAsync.mockReset();
		mocks.execAsyncRemote.mockReset();
	});

	const actions = [
		["restart", containerRestart, "docker container restart"],
		["start", containerStart, "docker container start"],
		["stop", containerStop, "docker container stop"],
		["kill", containerKill, "docker container kill"],
		["remove", containerRemove, "docker rm -f"],
	] as const;

	it.each(actions)(
		"%s is reported as NOT_FOUND",
		async (_name, action, cmd) => {
			mocks.execAsync.mockRejectedValue(noSuchContainer(`${cmd} 71605a1cb15a`));

			const error = await action("71605a1cb15a").catch((e) => e);

			expect(error).toBeInstanceOf(TRPCError);
			expect(error.code).toBe("NOT_FOUND");
			expect(error.message).toContain("71605a1cb15a");
		},
	);

	it("uses the remote exec path and still maps the error when a serverId is given", async () => {
		mocks.execAsyncRemote.mockRejectedValue(
			noSuchContainer("docker container restart 71605a1cb15a"),
		);

		const error = await containerRestart("71605a1cb15a", "server-1").catch(
			(e) => e,
		);

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-1",
			"docker container restart 71605a1cb15a",
		);
		expect(error).toBeInstanceOf(TRPCError);
		expect(error.code).toBe("NOT_FOUND");
	});

	it("leaves other docker failures untouched", async () => {
		const failure = new ExecError("Command execution failed", {
			command: "docker container stop abc",
			stderr: "Cannot connect to the Docker daemon",
			exitCode: 1,
		});
		mocks.execAsync.mockRejectedValue(failure);

		await expect(containerStop("abc")).rejects.toBe(failure);
	});

	it("resolves when the daemon reports no stderr", async () => {
		mocks.execAsync.mockResolvedValue({ stdout: "abc\n", stderr: "" });

		await expect(containerStart("abc")).resolves.toBeUndefined();
	});
});
