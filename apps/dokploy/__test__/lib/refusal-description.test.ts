import { describe, expect, it } from "vitest";
import { refusalDescription } from "@/lib/refusal-description";

describe("refusalDescription", () => {
	it("returns the message of an error the server raised on purpose", () => {
		for (const code of ["BAD_REQUEST", "FORBIDDEN", "CONFLICT", "NOT_FOUND"]) {
			expect(
				refusalDescription({ message: "Refused for a reason", data: { code } }),
			).toBe("Refused for a reason");
		}
	});

	it("returns nothing for an internal error, whose message can carry a query", () => {
		expect(
			refusalDescription({
				message: "Failed query: update compose set ... params: version: 3",
				data: { code: "INTERNAL_SERVER_ERROR" },
			}),
		).toBeUndefined();
	});

	it("returns nothing for an error that did not come from the server", () => {
		expect(refusalDescription(new Error("Failed to fetch"))).toBeUndefined();
		expect(refusalDescription({ message: "x", data: null })).toBeUndefined();
		expect(refusalDescription(undefined)).toBeUndefined();
		expect(refusalDescription("boom")).toBeUndefined();
	});

	it("returns the issue messages of an input the schema refused, not its JSON", () => {
		const issue =
			"This git URL is not allowed; use an http(s), ssh, or user@host:path URL";
		expect(
			refusalDescription({
				message: JSON.stringify([
					{ code: "custom", path: ["customGitUrl"], message: issue },
				]),
				data: {
					code: "BAD_REQUEST",
					zodError: { formErrors: [], fieldErrors: { customGitUrl: [issue] } },
				},
			}),
		).toBe(issue);
		expect(
			refusalDescription({
				message: "[]",
				data: {
					code: "BAD_REQUEST",
					zodError: {
						formErrors: ["Pick a source"],
						fieldErrors: { a: ["Too short"], b: ["Too short"] },
					},
				},
			}),
		).toBe("Pick a source Too short");
		expect(
			refusalDescription({
				message: "[]",
				data: {
					code: "BAD_REQUEST",
					zodError: { formErrors: [], fieldErrors: {} },
				},
			}),
		).toBeUndefined();
	});

	it("returns nothing for an empty message", () => {
		expect(
			refusalDescription({ message: "", data: { code: "BAD_REQUEST" } }),
		).toBeUndefined();
	});
});
