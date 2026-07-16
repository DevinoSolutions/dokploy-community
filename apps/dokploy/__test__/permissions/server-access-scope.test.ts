import { getAccessibleServerIds } from "@dokploy/server/services/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
	const mockServerData = (serverId: string) => ({ serverId });
	const mockMemberData = (role: string, accessedServers: string[] = []) => ({
		role,
		accessedServers,
	});
	return {
		mockServerData,
		mockMemberData,
		serversToReturn: [
			mockServerData("server-1"),
			mockServerData("server-2"),
		] as { serverId: string }[],
		memberToReturn: mockMemberData("member") as
			| ReturnType<typeof mockMemberData>
			| undefined,
		licensed: true,
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			server: {
				findMany: vi.fn(() => Promise.resolve(state.serversToReturn)),
			},
			member: {
				findFirst: vi.fn(() => Promise.resolve(state.memberToReturn)),
			},
		},
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(() => Promise.resolve(state.licensed)),
}));

const session = {
	userId: "user-1",
	activeOrganizationId: "org-1",
};

beforeEach(() => {
	state.serversToReturn = [
		state.mockServerData("server-1"),
		state.mockServerData("server-2"),
	];
	state.memberToReturn = state.mockMemberData("member");
	state.licensed = true;
	vi.clearAllMocks();
});

describe("getAccessibleServerIds", () => {
	it("returns all active organization servers for owners", async () => {
		state.memberToReturn = state.mockMemberData("owner", []);

		const result = await getAccessibleServerIds(session);

		expect([...result].sort()).toEqual(["server-1", "server-2"]);
	});

	it("returns all active organization servers when no license is active", async () => {
		state.licensed = false;
		state.memberToReturn = state.mockMemberData("member", []);

		const result = await getAccessibleServerIds(session);

		expect([...result].sort()).toEqual(["server-1", "server-2"]);
	});

	it("filters assigned servers to the active organization", async () => {
		state.memberToReturn = state.mockMemberData("member", [
			"server-1",
			"foreign-server",
			"server-2",
		]);

		const result = await getAccessibleServerIds(session);

		expect([...result].sort()).toEqual(["server-1", "server-2"]);
	});

	it("does not grant stale or cross-organization server assignments", async () => {
		state.memberToReturn = state.mockMemberData("member", ["foreign-server"]);

		const result = await getAccessibleServerIds(session);

		expect([...result]).toEqual([]);
	});
});
