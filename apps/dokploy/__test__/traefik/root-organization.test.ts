import { isRootOrganization } from "@dokploy/server/services/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { organization: { findFirst: mocks.findFirst } } },
}));

describe("isRootOrganization", () => {
	beforeEach(() => {
		mocks.findFirst.mockReset();
	});

	it("asks for the organization created first, ties broken by id", async () => {
		mocks.findFirst.mockResolvedValue({ id: "org-1" });

		await isRootOrganization("org-1");

		const [{ orderBy }] = mocks.findFirst.mock.calls[0]!;
		const asc = (column: string) => `asc:${column}`;
		expect(orderBy({ createdAt: "createdAt", id: "id" }, { asc })).toEqual([
			"asc:createdAt",
			"asc:id",
		]);
	});

	it("is true only for that organization", async () => {
		mocks.findFirst.mockResolvedValue({ id: "org-1" });

		await expect(isRootOrganization("org-1")).resolves.toBe(true);
		await expect(isRootOrganization("org-2")).resolves.toBe(false);
	});

	it("is false for everyone when there is no organization", async () => {
		mocks.findFirst.mockResolvedValue(undefined);

		await expect(isRootOrganization("org-1")).resolves.toBe(false);
	});
});
