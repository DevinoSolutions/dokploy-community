import { describe, expect, it } from "vitest";
import { parseContainerHealth } from "@/lib/docker-health";

describe("parseContainerHealth (#1557)", () => {
	it("detects a healthy container", () => {
		expect(parseContainerHealth("Up 2 minutes (healthy)")).toBe("healthy");
	});

	it("detects an unhealthy container", () => {
		expect(parseContainerHealth("Up 10 minutes (unhealthy)")).toBe("unhealthy");
	});

	it("detects a starting healthcheck", () => {
		expect(parseContainerHealth("Up 5 seconds (health: starting)")).toBe(
			"starting",
		);
	});

	it("does not confuse 'healthy' inside 'unhealthy'", () => {
		// the substring "healthy" must not win over the full "unhealthy" token
		expect(parseContainerHealth("Up 1 minute (unhealthy)")).not.toBe("healthy");
	});

	it("returns none when no healthcheck is present", () => {
		expect(parseContainerHealth("Up 3 hours")).toBe("none");
		expect(parseContainerHealth("Exited (0) 4 minutes ago")).toBe("none");
	});

	it("returns none for empty or missing status", () => {
		expect(parseContainerHealth("")).toBe("none");
		expect(parseContainerHealth(null)).toBe("none");
		expect(parseContainerHealth(undefined)).toBe("none");
	});

	it("is case insensitive", () => {
		expect(parseContainerHealth("Up 2 minutes (Healthy)")).toBe("healthy");
	});
});
