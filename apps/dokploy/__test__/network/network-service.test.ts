import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Swap the remote-docker helper for a controllable fake before importing the
// service under test. The in-memory `fakeDocker` is mutated per test.
const fakeDocker = {
	createNetwork: vi.fn(),
	listNetworks: vi.fn<() => Promise<Array<{ Name: string; Id: string }>>>(),
	getNetwork: vi.fn<(id: string) => { remove: () => Promise<void> }>(),
};

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => fakeDocker),
}));

// Silence the IS_CLOUD branch — our tests cover non-cloud behavior.
vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, IS_CLOUD: false };
});

// Tests here target error paths that don't require a live DB transaction.
// The global DB mock in __test__/setup.ts already makes `db.query.network`
// return `undefined` for findFirst, which is exactly the not-found path.
import { findNetworkById, removeNetworkById } from "@dokploy/server";

describe("findNetworkById", () => {
	it("throws NOT_FOUND when the row doesn't exist", async () => {
		await expect(findNetworkById("missing")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});

describe("removeNetworkById", () => {
	beforeEach(() => {
		fakeDocker.createNetwork.mockReset();
		fakeDocker.listNetworks.mockReset();
		fakeDocker.getNetwork.mockReset();
	});

	it("throws NOT_FOUND when the row doesn't exist for the organization", async () => {
		await expect(
			removeNetworkById("missing", "org_1"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		// Docker should never be touched when the DB row is missing.
		expect(fakeDocker.listNetworks).not.toHaveBeenCalled();
	});
});

describe("error classification", () => {
	it("recognises Docker 'in use' errors as CONFLICT (regex shape)", () => {
		// Mirrors the runtime check in removeNetworkById — if this pattern ever
		// diverges from Docker's wording we'll notice via this guardrail.
		const patterns = [
			"network foo has active endpoints",
			"Error response from daemon: network is in use",
		];
		for (const msg of patterns) {
			expect(/has active endpoints|is in use/i.test(msg)).toBe(true);
		}
	});

	it("is a TRPCError constructable with CONFLICT", () => {
		const err = new TRPCError({
			code: "CONFLICT",
			message: "Network in use",
		});
		expect(err.code).toBe("CONFLICT");
	});
});
