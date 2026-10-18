import { describe, expect, it } from "vitest";
import { describeCancelledBy } from "@/components/dashboard/application/deployments/cancelled-by";

const base = { actorEmail: null, apiKeyName: null, apiKeyShortId: null };

describe("describeCancelledBy", () => {
	it("names the user", () => {
		expect(
			describeCancelledBy({
				...base,
				actorType: "user",
				actorEmail: "alice@example.com",
			}),
		).toBe("Cancelled by alice@example.com");
	});

	it("falls back to a generic user", () => {
		expect(describeCancelledBy({ ...base, actorType: "user" })).toBe(
			"Cancelled by a user",
		);
	});

	it("names an API key and the user it belongs to", () => {
		expect(
			describeCancelledBy({
				actorType: "api_key",
				actorEmail: "alice@example.com",
				apiKeyName: "ci-bot",
				apiKeyShortId: "abcdef",
			}),
		).toBe("Cancelled by API key ci-bot (alice@example.com)");
	});

	it("names an unnamed API key by the start of its id", () => {
		expect(
			describeCancelledBy({
				actorType: "api_key",
				actorEmail: "alice@example.com",
				apiKeyName: null,
				apiKeyShortId: "abcdef",
			}),
		).toBe("Cancelled by API key abcdef (alice@example.com)");
	});

	it("still reads well with no key and no user", () => {
		expect(describeCancelledBy({ ...base, actorType: "api_key" })).toBe(
			"Cancelled by an API key",
		);
	});

	it("names the system", () => {
		expect(describeCancelledBy({ ...base, actorType: "system" })).toBe(
			"Cancelled by system",
		);
	});
});
