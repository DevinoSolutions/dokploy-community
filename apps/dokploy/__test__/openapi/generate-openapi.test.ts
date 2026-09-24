import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";

/**
 * /swagger and settings.getOpenApiDocument build the document from the whole
 * router. OpenAPI v3 can't describe a subscription, so one subscription
 * without `openapi: { enabled: false }` makes every request for the spec fail.
 */
describe("OpenAPI document", () => {
	it("generates from the full app router", () => {
		const document = generateOpenApiDocument(appRouter, {
			title: "Dokploy API",
			version: "1.0.0",
			baseUrl: "http://localhost:3000/api",
		});

		expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
		expect(document.paths).not.toHaveProperty([
			"/application.transferWithLogs",
		]);
		expect(document.paths).not.toHaveProperty(["/backupPolicy.runNow"]);
	});
});
