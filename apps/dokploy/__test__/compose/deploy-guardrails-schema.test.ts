import {
	deployGuardrailsSchema,
	deployHealthCheckSchema,
} from "@dokploy/server/db/validations/compose-guardrails";
import { apiUpdateCompose } from "@dokploy/server/db/schema";
import { resolveDeployGuardrails } from "@dokploy/server/utils/builders/compose-guardrails";
import { describe, expect, it } from "vitest";

describe("deployHealthCheckSchema", () => {
	it("accepts http and https URLs and defaults the timeout to 60s", () => {
		for (const url of ["http://localhost:3000/health", "https://example.com"]) {
			const parsed = deployHealthCheckSchema.parse({ url });
			expect(parsed.url).toBe(url);
			expect(parsed.timeoutSeconds).toBe(60);
			expect(parsed.expectedStatus).toBeUndefined();
		}
	});

	it.each([
		"ftp://example.com/file",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"gopher://example.com",
		"example.com/health",
		"//example.com",
		"",
	])("rejects the non-http(s) URL %j", (url) => {
		expect(deployHealthCheckSchema.safeParse({ url }).success).toBe(false);
	});

	it.each([
		"http://example.com/a b",
		"http://example.com/a\nb",
		"http://example.com/a\tb",
		"http://example.com/\u0000",
	])("rejects whitespace and control characters (%j)", (url) => {
		expect(deployHealthCheckSchema.safeParse({ url }).success).toBe(false);
	});

	it("rejects credentials in the URL (they would land in the log)", () => {
		expect(
			deployHealthCheckSchema.safeParse({ url: "http://user:pw@example.com/" })
				.success,
		).toBe(false);
	});

	it("rejects a URL that is too long", () => {
		const url = `http://example.com/${"a".repeat(2100)}`;
		expect(deployHealthCheckSchema.safeParse({ url }).success).toBe(false);
	});

	it("bounds the timeout to 5-600 seconds", () => {
		const url = "http://localhost/health";
		const timeout = (timeoutSeconds: number) =>
			deployHealthCheckSchema.safeParse({ url, timeoutSeconds }).success;
		expect(timeout(4)).toBe(false);
		expect(timeout(5)).toBe(true);
		expect(timeout(600)).toBe(true);
		expect(timeout(601)).toBe(false);
		expect(timeout(30.5)).toBe(false);
	});

	it("accepts an expected status only within 100-599", () => {
		const url = "http://localhost/health";
		const status = (expectedStatus: number) =>
			deployHealthCheckSchema.safeParse({ url, expectedStatus }).success;
		expect(status(200)).toBe(true);
		expect(status(204)).toBe(true);
		expect(status(99)).toBe(false);
		expect(status(600)).toBe(false);
	});
});

describe("resolveDeployGuardrails", () => {
	it("treats null, empty and all-false settings as off", () => {
		expect(resolveDeployGuardrails(null)).toBeNull();
		expect(resolveDeployGuardrails(undefined)).toBeNull();
		expect(resolveDeployGuardrails({})).toBeNull();
		expect(
			resolveDeployGuardrails({
				phaseTimestamps: false,
				dockerEvents: false,
				healthCheck: null,
			}),
		).toBeNull();
	});

	it("treats a malformed stored value as off instead of failing a deploy", () => {
		expect(resolveDeployGuardrails({ healthCheck: { url: "ftp://x" } })).toBeNull();
		expect(resolveDeployGuardrails("garbage")).toBeNull();
		expect(resolveDeployGuardrails({ phaseTimestamps: "yes" })).toBeNull();
	});

	it("resolves each flag independently", () => {
		expect(resolveDeployGuardrails({ dockerEvents: true })).toEqual({
			phaseTimestamps: false,
			dockerEvents: true,
			healthCheck: null,
		});
		expect(
			resolveDeployGuardrails({
				healthCheck: { url: "http://localhost/h", timeoutSeconds: 10 },
			}),
		).toMatchObject({
			healthCheck: { url: "http://localhost/h", timeoutSeconds: 10 },
		});
	});
});

describe("compose.update input", () => {
	const base = { composeId: "c1" };

	it("accepts deployGuardrails, null (reset) and its absence", () => {
		expect(apiUpdateCompose.safeParse(base).success).toBe(true);
		expect(
			apiUpdateCompose.safeParse({ ...base, deployGuardrails: null }).success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({
				...base,
				deployGuardrails: {
					phaseTimestamps: true,
					dockerEvents: true,
					healthCheck: { url: "https://example.com/up", timeoutSeconds: 90 },
				},
			}).success,
		).toBe(true);
	});

	it("rejects an invalid scheme or out-of-range timeout", () => {
		expect(
			apiUpdateCompose.safeParse({
				...base,
				deployGuardrails: { healthCheck: { url: "ftp://example.com" } },
			}).success,
		).toBe(false);
		expect(
			apiUpdateCompose.safeParse({
				...base,
				deployGuardrails: {
					healthCheck: { url: "http://example.com", timeoutSeconds: 1000 },
				},
			}).success,
		).toBe(false);
	});

	it("parses through the guardrails schema directly", () => {
		expect(deployGuardrailsSchema.safeParse({}).success).toBe(true);
	});
});
