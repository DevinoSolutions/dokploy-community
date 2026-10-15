import { describe, expect, it } from "vitest";
import {
	maskAttribute,
	maskNetworkRequest,
} from "@/lib/session-replay-posthog";
import {
	scrubBreadcrumb,
	scrubErrorEvent,
	scrubEventUrls,
	scrubRecordingEvent,
} from "@/lib/session-replay-sentry";
import {
	isSensitiveLocation,
	scrubUrlProperties,
	stripUrl,
	stripUrlsInText,
} from "@/lib/telemetry-privacy";

describe("stripUrl", () => {
	it("drops query and hash but keeps origin and path", () => {
		expect(stripUrl("https://dok.example.com/a/b?token=x#frag")).toBe(
			"https://dok.example.com/a/b",
		);
		expect(stripUrl("/api/trpc/user.getUserByToken?input=%7B%7D")).toBe(
			"/api/trpc/user.getUserByToken",
		);
		expect(stripUrl("/reset-password#access_token=abc")).toBe(
			"/reset-password",
		);
	});

	it("drops credentials in the authority", () => {
		expect(stripUrl("https://user:pw@host.example.com/x?y=1")).toBe(
			"https://host.example.com/x",
		);
	});

	it("tolerates empty, relative and non-string input", () => {
		expect(stripUrl("")).toBe("");
		expect(stripUrl("?token=x")).toBe("");
		expect(stripUrl("dashboard/projects")).toBe("dashboard/projects");
		expect(stripUrl(undefined as unknown as string)).toBeUndefined();
	});
});

describe("stripUrlsInText", () => {
	it("removes an unencoded JSON input entirely", () => {
		expect(
			stripUrlsInText(
				'GET /api/trpc/user.getUserByToken?input={"token":"abc","n":{"a":1}} failed',
			),
		).not.toContain("abc");
		expect(
			stripUrlsInText(
				'GET /api/trpc/user.getUserByToken?input={"token":"abc"} failed',
			),
		).toBe("GET /api/trpc/user.getUserByToken failed");
	});

	it("strips queries from absolute URLs and /api paths inside messages", () => {
		expect(
			stripUrlsInText(
				"GET https://d.example.com/api/trpc/x?input=secret failed; retry /api/trpc/y?token=t now",
			),
		).toBe(
			"GET https://d.example.com/api/trpc/x failed; retry /api/trpc/y now",
		);
	});
});

describe("isSensitiveLocation", () => {
	it("flags credential pages", () => {
		for (const url of [
			"/reset-password?token=abc",
			"/reset-password",
			"/send-reset-password",
			"/invitation?token=abc",
			"/accept-invitation/123",
			"/register",
			"/mcp/authorize?client_id=x&state=y",
			"https://dok.example.com/Reset-Password/?x=1",
		]) {
			expect(isSensitiveLocation(url), url).toBe(true);
		}
	});

	it("flags token-bearing params anywhere, including the hash", () => {
		expect(
			isSensitiveLocation("/dashboard/settings/git-providers?code=1&state=2"),
		).toBe(true);
		expect(isSensitiveLocation("/dashboard/home?token=abc")).toBe(true);
		expect(isSensitiveLocation("/dashboard/home#access_token=abc")).toBe(true);
	});

	it("allows ordinary dashboard pages", () => {
		for (const url of [
			"/",
			"/dashboard/projects",
			"/dashboard/project/abc/environment/def?tab=logs",
			"https://dok.example.com/dashboard/settings/profile",
			"/registered-things",
			"/invitations-overview",
		]) {
			expect(isSensitiveLocation(url), url).toBe(false);
		}
	});
});

describe("scrubUrlProperties", () => {
	it("strips every URL-like PostHog property", () => {
		const properties = scrubUrlProperties({
			$current_url: "https://d.example.com/dashboard/x?a=1#b",
			$referrer: "https://d.example.com/reset-password?token=t",
			$initial_current_url: "https://d.example.com/invitation?token=t",
			$initial_referrer: "$direct",
			$session_entry_url: "https://d.example.com/p?q=1",
			$session_entry_referrer: "https://x.example.com/?q=1",
			$pathname: "/dashboard/x",
			$screen_width: 100,
		});
		expect(JSON.stringify(properties)).not.toMatch(/[?#]/);
		expect(properties.$screen_width).toBe(100);
	});
});

describe("Sentry scrubbers", () => {
	it("drops console breadcrumbs and strips URLs from the rest", () => {
		expect(
			scrubBreadcrumb({ category: "console", message: "logs" }),
		).toBeNull();
		expect(
			scrubBreadcrumb({
				category: "fetch",
				data: {
					url: "/api/trpc/user.getUserByToken?input=secret",
					method: "GET",
				},
			}),
		).toEqual({
			category: "fetch",
			data: { url: "/api/trpc/user.getUserByToken", method: "GET" },
		});
		expect(
			scrubBreadcrumb({
				category: "navigation",
				data: { from: "/a?token=1", to: "/b#x", previous: "/c?code=2" },
			})?.data,
		).toEqual({ from: "/a", to: "/b", previous: "/c" });
	});

	it("strips request and replay urls from events", () => {
		const event = scrubEventUrls({
			request: {
				url: "https://d.example.com/reset-password?token=t",
				query_string: "token=t",
				headers: {
					Referer: "https://d.example.com/invitation?token=t",
					"User-Agent": "ua",
				},
			},
			urls: ["https://d.example.com/p?token=t", "/q#h"],
		} as never) as never as {
			request: {
				url: string;
				query_string?: string;
				headers: Record<string, string>;
			};
			urls: string[];
		};
		expect(event.request.url).toBe("https://d.example.com/reset-password");
		expect(event.request.query_string).toBeUndefined();
		expect(event.request.headers.Referer).toBe(
			"https://d.example.com/invitation",
		);
		expect(event.request.headers["User-Agent"]).toBe("ua");
		expect(event.urls).toEqual(["https://d.example.com/p", "/q"]);
	});

	it("redacts secrets and query strings in error text", () => {
		const event = scrubErrorEvent({
			message: "failed https://d.example.com/api/x?token=abc",
			exception: {
				values: [
					{
						value: "deploy failed PGPASSWORD=hunter2 psql",
						stacktrace: {
							frames: [{ filename: "https://d.example.com/_next/a.js?v=1" }],
						},
					},
				],
			},
		} as never);
		expect(event.message).toBe("failed https://d.example.com/api/x");
		expect(event.exception?.values?.[0]?.value).not.toContain("hunter2");
		expect(
			event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename,
		).toBe("https://d.example.com/_next/a.js");
	});

	it("strips urls from custom replay frames", () => {
		const span = scrubRecordingEvent({
			data: {
				tag: "performanceSpan",
				payload: {
					description: "https://d.example.com/api/trpc/x?input=secret",
					data: { url: "/y?z=1" },
				},
			},
		});
		expect(span.data.payload.description).toBe(
			"https://d.example.com/api/trpc/x",
		);
		expect(span.data.payload.data).toEqual({ url: "/y" });
	});
});

describe("PostHog helpers", () => {
	it("stars sensitive attribute values", () => {
		for (const name of [
			"title",
			"aria-label",
			"placeholder",
			"alt",
			"href",
			"value",
			"data-token",
			"DATA-Foo",
		]) {
			expect(maskAttribute(name, "secret-value")).toBe("************");
		}
		expect(maskAttribute("class", "btn")).toBe("btn");
	});

	it("strips network request urls and drops headers and bodies", () => {
		const masked = maskNetworkRequest({
			name: "https://d.example.com/api/trpc/x?input=secret",
			method: "GET",
			requestHeaders: { authorization: "t" },
			responseBody: "body",
		} as never) as Record<string, unknown>;
		expect(masked.name).toBe("https://d.example.com/api/trpc/x");
		expect(masked.method).toBe("GET");
		expect(masked.requestHeaders).toBeUndefined();
		expect(masked.responseBody).toBeUndefined();
	});
});
