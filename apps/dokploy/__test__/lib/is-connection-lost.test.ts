import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";
import { isConnectionLost } from "@/utils/is-connection-lost";

describe("isConnectionLost", () => {
	it("is true when the request never reached Dokploy", () => {
		expect(
			isConnectionLost(TRPCClientError.from(new TypeError("Failed to fetch"))),
		).toBe(true);
	});

	it("is true when a proxy answered with a page instead of tRPC JSON", () => {
		expect(
			isConnectionLost(
				TRPCClientError.from(new SyntaxError("Unexpected token '<'")),
			),
		).toBe(true);
	});

	it("is false for an error Dokploy answered", () => {
		const answered = TRPCClientError.from({
			error: {
				message: "Traefik is not older than the recommended version",
				code: -32600,
				data: { code: "BAD_REQUEST", httpStatus: 400 },
			},
		} as never);

		expect(isConnectionLost(answered)).toBe(false);
	});

	it("is false for something that isn't an error", () => {
		expect(isConnectionLost(undefined)).toBe(false);
		expect(isConnectionLost("Failed to fetch")).toBe(false);
	});
});
