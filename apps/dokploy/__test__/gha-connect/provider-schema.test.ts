import {
	apiCreateApplication,
	apiUpdateApplication,
} from "@dokploy/server/db/schema/application";
import {
	apiCreateCompose,
	apiUpdateCompose,
} from "@dokploy/server/db/schema/compose";
import { describe, expect, it } from "vitest";

/** Only Connect makes a service follow GitHub Actions: no create call may set the type; the update calls still name it. */
describe("the github-actions source type in the API schemas", () => {
	it("is refused when a service is created", () => {
		expect(
			apiCreateApplication.safeParse({
				name: "web",
				environmentId: "env-1",
				sourceType: "github-actions",
			}).success,
		).toBe(false);
		expect(
			apiCreateCompose.safeParse({
				name: "stack",
				environmentId: "env-1",
				sourceType: "github-actions",
			}).success,
		).toBe(false);
	});

	it("still takes the other source types at create", () => {
		expect(
			apiCreateApplication.safeParse({
				name: "web",
				environmentId: "env-1",
				sourceType: "docker",
			}).success,
		).toBe(true);
		expect(
			apiCreateCompose.safeParse({
				name: "stack",
				environmentId: "env-1",
				sourceType: "raw",
			}).success,
		).toBe(true);
	});

	it("is accepted by the update calls, so a client can send the whole record back", () => {
		expect(
			apiUpdateApplication.safeParse({
				applicationId: "a",
				sourceType: "github-actions",
			}).success,
		).toBe(true);
		expect(
			apiUpdateCompose.safeParse({
				composeId: "c",
				sourceType: "github-actions",
			}).success,
		).toBe(true);
	});
});
