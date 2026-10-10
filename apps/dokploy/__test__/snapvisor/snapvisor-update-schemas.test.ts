import {
	apiUpdateApplication,
	apiUpdateCompose,
} from "@dokploy/server/db/schema";
import { describe, expect, it } from "vitest";

/**
 * The Snapvisor project of a service is set through
 * `snapvisor.setApplicationProject` / `setComposeProject`, which validate the
 * slug and check the organization. The generic update schemas must not be a
 * second way in.
 */
describe("generic update schemas and snapvisorProjectName", () => {
	it("apiUpdateCompose drops snapvisorProjectName", () => {
		const parsed = apiUpdateCompose.parse({
			composeId: "compose-1",
			name: "stack",
			snapvisorProjectName: "https://evil.example/x",
		});
		expect(parsed).not.toHaveProperty("snapvisorProjectName");
		expect(parsed.name).toBe("stack");
	});

	it("apiUpdateApplication drops snapvisorProjectName", () => {
		const parsed = apiUpdateApplication.parse({
			applicationId: "app-1",
			name: "web",
			snapvisorProjectName: "https://evil.example/x",
		});
		expect(parsed).not.toHaveProperty("snapvisorProjectName");
		expect(parsed.name).toBe("web");
	});
});
