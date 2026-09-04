import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createCallerFactory,
	createTRPCRouter,
	publicProcedure,
} from "@/server/api/trpc";
import { buildMcpToolRegistry, toolsForScopes } from "@/server/mcp/registry";

const sampleRouter = createTRPCRouter({
	application: createTRPCRouter({
		one: publicProcedure
			.input(z.object({ applicationId: z.string() }))
			.query(() => ({})),
		deploy: publicProcedure
			.meta({
				openapi: {
					method: "POST",
					path: "/application.deploy",
					description: "Deploy an application",
				},
			})
			.input(z.object({ applicationId: z.string() }).optional())
			.mutation(() => ({})),
		delete: publicProcedure
			.input(z.object({ applicationId: z.string() }))
			.mutation(() => ({})),
		hidden: publicProcedure
			.meta({ openapi: { method: "POST", path: "/x", enabled: false } })
			.mutation(() => ({})),
		noInput: publicProcedure.query(() => ({})),
		scalarInput: publicProcedure.input(z.string()).query(() => ({})),
	}),
	mcp: createTRPCRouter({
		connectionInfo: publicProcedure.query(() => ({})),
	}),
});

// createCallerFactory is referenced so the import stays honest about the router type.
void createCallerFactory;

describe("buildMcpToolRegistry", () => {
	const tools = buildMcpToolRegistry(sampleRouter, { excludeRouters: ["mcp"] });
	const names = tools.map((tool) => tool.name);

	it("names tools router-procedure and skips excluded/hidden/non-object-input procedures", () => {
		expect(names).toEqual([
			"application-one",
			"application-deploy",
			"application-delete",
			"application-noInput",
		]);
	});

	it("uses the openapi description when present, else METHOD /router.procedure", () => {
		expect(
			tools.find((t) => t.name === "application-deploy")?.description,
		).toBe("Deploy an application");
		expect(tools.find((t) => t.name === "application-one")?.description).toBe(
			"GET /application.one",
		);
		expect(
			tools.find((t) => t.name === "application-delete")?.description,
		).toBe("POST /application.delete");
	});

	it("emits an object JSON schema with a single top-level 2020-12 $schema", () => {
		const deploy = tools.find((t) => t.name === "application-deploy");
		expect(deploy?.inputSchema.type).toBe("object");
		expect(deploy?.inputSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(JSON.stringify(deploy?.inputSchema.properties)).not.toContain(
			"$schema",
		);
		const noInput = tools.find((t) => t.name === "application-noInput");
		expect(noInput?.inputSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {},
		});
	});

	it("annotates queries as read-only and delete scopes as destructive", () => {
		const one = tools.find((t) => t.name === "application-one");
		expect(one?.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			destructiveHint: false,
			openWorldHint: true,
		});
		const del = tools.find((t) => t.name === "application-delete");
		expect(del?.scope).toBe("dokploy:services:delete");
		expect(del?.annotations.destructiveHint).toBe(true);
	});

	it("toolsForScopes filters by granted scopes", () => {
		expect(
			toolsForScopes(tools, new Set(["dokploy:read"])).map((t) => t.name),
		).toEqual(["application-one", "application-noInput"]);
	});
});
