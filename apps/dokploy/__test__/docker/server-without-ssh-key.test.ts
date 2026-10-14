import {
	execAsyncRemote,
	openRemoteInputSession,
	writeFileRemote,
} from "@dokploy/server/utils/process/execAsync";
import { MissingSshKeyError } from "@dokploy/server/utils/process/MissingSshKeyError";
import { getTRPCErrorFromUnknown, TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

// Sentry DOKPLOY-COMMUNITY-50: getDockerDiskUsage on a remote server with no
// SSH key threw a plain Error, which tRPC turned into a 500 and reported.
describe("remote exec on a server with no SSH key", () => {
	beforeEach(() => {
		mocks.findServerById.mockReset();
		mocks.findServerById.mockResolvedValue({ serverId: "s1", sshKeyId: null });
	});

	const calls = [
		["execAsyncRemote", () => execAsyncRemote("s1", "docker system df")],
		["openRemoteInputSession", () => openRemoteInputSession("s1", "cat")],
		["writeFileRemote", () => writeFileRemote("s1", "/tmp/x", "content")],
	] as const;

	it.each(calls)(
		"%s rejects with a PRECONDITION_FAILED tRPC error",
		async (_name, run) => {
			const error = await run().catch((e: unknown) => e);

			expect(error).toBeInstanceOf(MissingSshKeyError);
			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
			expect((error as TRPCError).message).toContain(
				"No SSH key available for this server",
			);
			expect((error as TRPCError).message).toContain("server settings");
		},
	);

	it("is not an INTERNAL_SERVER_ERROR once tRPC normalizes it, so it is not reported", () => {
		const normalized = getTRPCErrorFromUnknown(new MissingSshKeyError());

		expect(normalized.code).toBe("PRECONDITION_FAILED");
		expect(normalized.code).not.toBe("INTERNAL_SERVER_ERROR");
	});
});
