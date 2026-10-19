import { describe, expect, it } from "vitest";
import {
	CANCELLED_BY_WAIT_MS,
	describeCancelledBy,
	isAwaitingCancelledBy,
} from "@/components/dashboard/application/deployments/cancelled-by";

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

	it("names an MCP client and the user it acts for", () => {
		expect(
			describeCancelledBy({
				...base,
				actorType: "oauth_client",
				actorEmail: "alice@example.com",
				oauthClientName: "Claude Code",
				oauthClientShortId: "abcdef",
			}),
		).toBe("Cancelled by alice@example.com via MCP client Claude Code");
	});

	it("names an unnamed MCP client by the start of its client id", () => {
		expect(
			describeCancelledBy({
				...base,
				actorType: "oauth_client",
				actorEmail: "alice@example.com",
				oauthClientName: null,
				oauthClientShortId: "abcdef",
			}),
		).toBe("Cancelled by alice@example.com via MCP client abcdef");
	});

	it("names an MCP client when the user is hidden", () => {
		expect(
			describeCancelledBy({
				...base,
				actorType: "oauth_client",
				oauthClientName: "Claude Code",
			}),
		).toBe("Cancelled by MCP client Claude Code");
	});

	it("falls back to the plain user when the client is hidden or unknown", () => {
		expect(
			describeCancelledBy({
				...base,
				actorType: "oauth_client",
				actorEmail: "alice@example.com",
			}),
		).toBe("Cancelled by alice@example.com");
		expect(describeCancelledBy({ ...base, actorType: "oauth_client" })).toBe(
			"Cancelled by a user",
		);
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

describe("isAwaitingCancelledBy", () => {
	const now = Date.parse("2026-10-18T12:00:00Z");
	const ago = (ms: number) => new Date(now - ms).toISOString();
	const cancelled = (deploymentId: string, finishedAt: string | null) => ({
		deploymentId,
		status: "cancelled",
		createdAt: ago(60 * 60 * 1000),
		finishedAt,
	});
	const none = new Set<string>();

	it("waits for a recent cancellation without an entry", () => {
		expect(
			isAwaitingCancelledBy([cancelled("d1", ago(10_000))], none, now),
		).toBe(true);
	});

	it("stops once the entry is there", () => {
		expect(
			isAwaitingCancelledBy(
				[cancelled("d1", ago(10_000))],
				new Set(["d1"]),
				now,
			),
		).toBe(false);
	});

	it("gives up on an old cancellation that never got an entry", () => {
		expect(
			isAwaitingCancelledBy(
				[cancelled("d1", ago(CANCELLED_BY_WAIT_MS + 1000))],
				none,
				now,
			),
		).toBe(false);
	});

	it("falls back to createdAt when there is no finish time", () => {
		const recent = { ...cancelled("d1", null), createdAt: ago(5000) };
		expect(isAwaitingCancelledBy([recent], none, now)).toBe(true);
		expect(isAwaitingCancelledBy([cancelled("d2", null)], none, now)).toBe(
			false,
		);
	});

	it("ignores deployments that are not cancelled", () => {
		expect(
			isAwaitingCancelledBy(
				[{ ...cancelled("d1", ago(1000)), status: "running" }],
				none,
				now,
			),
		).toBe(false);
		expect(isAwaitingCancelledBy(undefined, none, now)).toBe(false);
	});

	it("keeps waiting while any recent cancellation lacks an entry", () => {
		expect(
			isAwaitingCancelledBy(
				[
					cancelled("old", ago(CANCELLED_BY_WAIT_MS * 5)),
					cancelled("d2", ago(1000)),
				],
				new Set(["old"]),
				now,
			),
		).toBe(true);
	});

	it("does not wait on an unparseable time", () => {
		expect(isAwaitingCancelledBy([cancelled("d1", "garbage")], none, now)).toBe(
			false,
		);
	});
});
