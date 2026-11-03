import {
	canRemoveGithubConnection,
	canUseGithubConnection,
	ownsGithubConnection,
	visibleGithubConnections,
} from "@dokploy/server/services/github-deployments/connection-access";
import { describe, expect, it } from "vitest";

const conn = (
	createdByUserId: string | null,
	sharedWithOrganization = false,
) => ({ createdByUserId, sharedWithOrganization });
const member = (userId: string) => ({ userId, role: "member" });
const admin = { userId: "a", role: "admin" };
const owner = { userId: "o", role: "owner" };

describe("who may use a GitHub connection", () => {
	it("its owner may use and remove it", () => {
		expect(canUseGithubConnection(conn("u1"), member("u1"))).toBe(true);
		expect(canRemoveGithubConnection(conn("u1"), member("u1"))).toBe(true);
		expect(ownsGithubConnection(conn("u1"), member("u1"))).toBe(true);
	});

	it("another member may do neither, unless it is shared (then only use)", () => {
		expect(canUseGithubConnection(conn("u1"), member("u2"))).toBe(false);
		expect(canRemoveGithubConnection(conn("u1"), member("u2"))).toBe(false);
		expect(canUseGithubConnection(conn("u1", true), member("u2"))).toBe(true);
		expect(canRemoveGithubConnection(conn("u1", true), member("u2"))).toBe(
			false,
		);
	});

	it("an organization owner or admin may use and remove any, but does not own it", () => {
		for (const viewer of [admin, owner]) {
			expect(canUseGithubConnection(conn("u1"), viewer)).toBe(true);
			expect(canRemoveGithubConnection(conn("u1"), viewer)).toBe(true);
			expect(ownsGithubConnection(conn("u1"), viewer)).toBe(false);
		}
	});

	it("a connection with no recorded owner belongs to nobody, so a member with no user id match gets nothing", () => {
		expect(ownsGithubConnection(conn(null), member(""))).toBe(false);
		expect(canUseGithubConnection(conn(null), member("u1"))).toBe(false);
		expect(canRemoveGithubConnection(conn(null), member("u1"))).toBe(false);
		expect(canUseGithubConnection(conn(null), admin)).toBe(true);
	});

	it("an unknown role is treated as a plain member", () => {
		expect(
			canUseGithubConnection(conn("u1"), { userId: "u2", role: "viewer" }),
		).toBe(false);
	});
});

describe("visibleGithubConnections", () => {
	const all = [
		{ connectionId: "mine", ...conn("u1") },
		{ connectionId: "theirs", ...conn("u2") },
		{ connectionId: "shared", ...conn("u2", true) },
	];

	it("a member sees their own and the shared ones, and is told which are theirs", () => {
		const seen = visibleGithubConnections(all, member("u1"));
		expect(seen.map((c) => [c.connectionId, c.isOwner])).toEqual([
			["mine", true],
			["shared", false],
		]);
	});

	it("an admin sees all of them", () => {
		expect(visibleGithubConnections(all, admin)).toHaveLength(3);
	});

	it("drops the owner's user id", () => {
		for (const seen of visibleGithubConnections(all, admin)) {
			expect(seen).not.toHaveProperty("createdByUserId");
		}
	});
});
