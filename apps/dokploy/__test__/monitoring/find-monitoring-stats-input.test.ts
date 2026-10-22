import { apiFindMonitoringStats } from "@dokploy/server/db/schema/application";
import { describe, expect, it } from "vitest";

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
