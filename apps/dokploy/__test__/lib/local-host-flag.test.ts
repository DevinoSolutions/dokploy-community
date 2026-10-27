import { describe, expect, it } from "vitest";
import {
	canShowLocalHost,
	explainsEmptyLocalHost,
	waitsForLocalHostFlag,
} from "@/lib/local-host-flag";

describe("canShowLocalHost", () => {
	it("shows the host to the organization that owns it", () => {
		expect(
			canShowLocalHost({
				enabled: true,
				isError: false,
				localHostAccess: true,
			}),
		).toBe(true);
	});

	it("hides the host from another organization", () => {
		expect(
			canShowLocalHost({
				enabled: true,
				isError: false,
				localHostAccess: false,
			}),
		).toBe(false);
	});

	it("hides the host when the flag failed to load", () => {
		expect(
			canShowLocalHost({
				enabled: true,
				isError: true,
				localHostAccess: undefined,
			}),
		).toBe(false);
	});

	it("keeps a failure hidden even if an older answer was allowed", () => {
		expect(
			canShowLocalHost({
				enabled: true,
				isError: true,
				localHostAccess: true,
			}),
		).toBe(false);
	});

	it("reads as allowed while the flag loads, for the caller's pending state to cover", () => {
		expect(
			canShowLocalHost({
				enabled: true,
				isError: false,
				localHostAccess: undefined,
			}),
		).toBe(true);
	});

	it("keeps the previous behaviour when the query is not enabled", () => {
		expect(
			canShowLocalHost({
				enabled: false,
				isError: false,
				localHostAccess: undefined,
			}),
		).toBe(true);
	});
});

describe("explainsEmptyLocalHost", () => {
	it("explains an empty host to an organization that does not own it", () => {
		expect(
			explainsEmptyLocalHost({
				serverId: undefined,
				isFlagPending: false,
				canSeeLocalHost: false,
			}),
		).toBe(true);
	});

	it("keeps the usual empty state for the organization that owns the host", () => {
		expect(
			explainsEmptyLocalHost({
				serverId: undefined,
				isFlagPending: false,
				canSeeLocalHost: true,
			}),
		).toBe(false);
	});

	it("keeps the usual empty state for a remote server", () => {
		expect(
			explainsEmptyLocalHost({
				serverId: "server-1",
				isFlagPending: false,
				canSeeLocalHost: false,
			}),
		).toBe(false);
	});

	it("waits for the flag before explaining anything", () => {
		expect(
			explainsEmptyLocalHost({
				serverId: undefined,
				isFlagPending: true,
				canSeeLocalHost: false,
			}),
		).toBe(false);
	});
});

describe("waitsForLocalHostFlag", () => {
	it("waits on the host while the flag loads", () => {
		expect(
			waitsForLocalHostFlag({ serverId: undefined, isFlagPending: true }),
		).toBe(true);
	});

	it("does not wait once the flag is known, or for a remote server", () => {
		expect(
			waitsForLocalHostFlag({ serverId: undefined, isFlagPending: false }),
		).toBe(false);
		expect(
			waitsForLocalHostFlag({ serverId: "server-1", isFlagPending: true }),
		).toBe(false);
	});
});
