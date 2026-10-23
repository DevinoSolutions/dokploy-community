import {
	apiFindMonitoringStats,
	MONITORING_APP_NAME_PATTERN,
} from "@dokploy/server/db/schema/application";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("apiFindMonitoringStats", () => {
	it.each([
		"dokploy",
		"dokploy-abc_123",
		"app-web-x1y2z3",
		"stack-abc_web.1.k3j2h1g0f9e8",
		"a..b",
	])("accepts %j", (appName) => {
		expect(apiFindMonitoringStats.safeParse({ appName }).success).toBe(true);
	});

	it.each(["", ".", "..", "../other", "a/b", "a\b", "a b", "a\u0000b"])(
		"rejects %j",
		(appName) => {
			expect(apiFindMonitoringStats.safeParse({ appName }).success).toBe(false);
		},
	);
});

describe("apiFindMonitoringStats JSON schema", () => {
	it("still advertises the appName pattern", () => {
		const schema = z.toJSONSchema(apiFindMonitoringStats, {
			io: "input",
			unrepresentable: "any",
		});
		expect(schema.properties?.appName).toMatchObject({
			pattern: MONITORING_APP_NAME_PATTERN.source,
		});
	});
});
