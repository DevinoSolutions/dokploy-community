import { describe, expect, it } from "vitest";
import {
	getPostLoginDestination,
	isSafeRelativePath,
} from "@/lib/post-login-redirect";

describe("isSafeRelativePath", () => {
	it.each(["/dashboard/home", "/mcp/authorize?client_id=a&state=b"])(
		"accepts %s",
		(path) => expect(isSafeRelativePath(path)).toBe(true),
	);
	it.each([
		"//evil.com",
		"/\\evil.com",
		"https://evil.com",
		"javascript:alert(1)",
		"dashboard",
		"",
	])("rejects %s", (path) => expect(isSafeRelativePath(path)).toBe(false));

	// `?redirect=/%09/evil.com` arrives decoded; a Location header carrying the
	// tab is re-parsed by the browser as https://evil.com/.
	it.each(["/\t/evil.com", "/a\nb", "/a\rb"])(
		"rejects the control character in %j",
		(path) => expect(isSafeRelativePath(path)).toBe(false),
	);
});

describe("getPostLoginDestination", () => {
	it("defaults to the dashboard", () => {
		expect(getPostLoginDestination({})).toBe("/dashboard/home");
	});

	it("honours a safe redirect and ignores an unsafe one", () => {
		expect(getPostLoginDestination({ redirect: "/mcp/authorize?x=1" })).toBe(
			"/mcp/authorize?x=1",
		);
		expect(getPostLoginDestination({ redirect: "https://evil.com" })).toBe(
			"/dashboard/home",
		);
		expect(getPostLoginDestination({ redirect: ["/a", "/b"] })).toBe("/a");
	});

	it("rebuilds the consent URL when the plugin's login fallback shape is present", () => {
		expect(
			getPostLoginDestination({
				client_id: "c1",
				redirect_uri: "http://localhost:1/cb",
				response_type: "code",
				state: "s",
				consent: "should-be-dropped",
			}),
		).toBe(
			"/mcp/authorize?client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&response_type=code&state=s",
		);
	});
});
