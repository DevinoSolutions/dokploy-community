import { redactProjectSecrets } from "@dokploy/server";
import { apiUpdateCompose } from "@dokploy/server/db/schema";
import {
	deployGuardrailsSchema,
	deployHealthCheckSchema,
	deployStallSnapshotSchema,
} from "@dokploy/server/db/validations/compose-guardrails";
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

describe("deployStallSnapshotSchema", () => {
	it("defaults to 60s / 30s / 5 snapshots", () => {
		expect(deployStallSnapshotSchema.parse({})).toEqual({
			afterSeconds: 60,
			everySeconds: 30,
			maxSnapshots: 5,
		});
	});

	it("bounds afterSeconds to 15-1800", () => {
		const after = (afterSeconds: number) =>
			deployStallSnapshotSchema.safeParse({ afterSeconds }).success;
		expect(after(14)).toBe(false);
		expect(after(15)).toBe(true);
		expect(after(1800)).toBe(true);
		expect(after(1801)).toBe(false);
		expect(after(30.5)).toBe(false);
	});

	it("bounds everySeconds to 10-600", () => {
		const every = (everySeconds: number) =>
			deployStallSnapshotSchema.safeParse({ everySeconds }).success;
		expect(every(9)).toBe(false);
		expect(every(10)).toBe(true);
		expect(every(600)).toBe(true);
		expect(every(601)).toBe(false);
		expect(every(10.5)).toBe(false);
	});

	it("bounds maxSnapshots to 1-20", () => {
		const max = (maxSnapshots: number) =>
			deployStallSnapshotSchema.safeParse({ maxSnapshots }).success;
		expect(max(0)).toBe(false);
		expect(max(1)).toBe(true);
		expect(max(20)).toBe(true);
		expect(max(21)).toBe(false);
		expect(max(2.5)).toBe(false);
	});

	it("rejects non-numbers", () => {
		for (const value of ["60", null, true]) {
			expect(
				deployStallSnapshotSchema.safeParse({ afterSeconds: value }).success,
			).toBe(false);
		}
	});

	it("is optional and nullable inside the guardrails, and old rows still parse", () => {
		expect(deployGuardrailsSchema.safeParse({}).success).toBe(true);
		expect(
			deployGuardrailsSchema.safeParse({ stallSnapshot: null }).success,
		).toBe(true);
		// A row written before the field existed.
		expect(
			deployGuardrailsSchema.safeParse({
				phaseTimestamps: true,
				dockerEvents: false,
				healthCheck: { url: "http://localhost/h", timeoutSeconds: 10 },
			}).success,
		).toBe(true);
		expect(
			deployGuardrailsSchema.safeParse({ stallSnapshot: { afterSeconds: 5 } })
				.success,
		).toBe(false);
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
				stallSnapshot: null,
			}),
		).toBeNull();
	});

	it("treats a malformed stored value as off instead of failing a deploy", () => {
		expect(
			resolveDeployGuardrails({ healthCheck: { url: "ftp://x" } }),
		).toBeNull();
		expect(resolveDeployGuardrails("garbage")).toBeNull();
		expect(resolveDeployGuardrails({ phaseTimestamps: "yes" })).toBeNull();
		expect(
			resolveDeployGuardrails({ stallSnapshot: { afterSeconds: 1 } }),
		).toBeNull();
	});

	it("resolves each flag independently", () => {
		expect(resolveDeployGuardrails({ dockerEvents: true })).toEqual({
			phaseTimestamps: false,
			dockerEvents: true,
			healthCheck: null,
			stallSnapshot: null,
		});
		expect(
			resolveDeployGuardrails({ stallSnapshot: { afterSeconds: 120 } }),
		).toEqual({
			phaseTimestamps: false,
			dockerEvents: false,
			healthCheck: null,
			stallSnapshot: { afterSeconds: 120, everySeconds: 30, maxSnapshots: 5 },
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
					stallSnapshot: {
						afterSeconds: 120,
						everySeconds: 20,
						maxSnapshots: 3,
					},
				},
			}).success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({
				...base,
				deployGuardrails: { stallSnapshot: { maxSnapshots: 99 } },
			}).success,
		).toBe(false);
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

describe("project export", () => {
	const payload = () => ({
		project: { name: "p", description: null, env: null },
		environments: [
			{
				name: "prod",
				description: null,
				env: null,
				services: {
					applications: [{ name: "app", healthCheckSwarm: { Test: ["CMD"] } }],
					compose: [
						{
							name: "stack",
							deployGuardrails: {
								phaseTimestamps: true,
								dockerEvents: true,
								healthCheck: {
									url: "https://example.com/hook/SECRET?t=1",
									timeoutSeconds: 30,
								},
								stallSnapshot: {
									afterSeconds: 90,
									everySeconds: 20,
									maxSnapshots: 4,
								},
							},
						},
					],
					postgres: [],
					mysql: [],
					mariadb: [],
					mongo: [],
					redis: [],
					libsql: [],
				},
			},
		],
	});

	it("drops the health check URL unless secrets are included, keeps the flags", () => {
		const result = redactProjectSecrets(payload(), false);
		const services = result.environments[0]?.services;
		expect(services?.compose[0]).toMatchObject({
			deployGuardrails: {
				phaseTimestamps: true,
				dockerEvents: true,
				healthCheck: null,
				stallSnapshot: { afterSeconds: 90, everySeconds: 20, maxSnapshots: 4 },
			},
		});
		expect(JSON.stringify(result)).not.toContain("SECRET");
		// Unrelated health check settings are not touched.
		expect(services?.applications[0]).toMatchObject({
			healthCheckSwarm: { Test: ["CMD"] },
		});
	});

	it("keeps it with includeSecrets", () => {
		expect(JSON.stringify(redactProjectSecrets(payload(), true))).toContain(
			"https://example.com/hook/SECRET?t=1",
		);
	});
});
