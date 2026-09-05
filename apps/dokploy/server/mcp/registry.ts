import type { AnyRouter } from "@trpc/server";
import { z } from "zod";
import {
	type DokployMcpScope,
	isDestructiveScope,
	resolveToolScope,
} from "./scopes";

export interface McpToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface McpToolDefinition {
	/** `router-procedure`, identical to @dokploy/mcp. */
	name: string;
	/** `router.procedure` as registered in appRouter. */
	path: string;
	routerName: string;
	procedureName: string;
	type: "query" | "mutation";
	description: string;
	inputSchema: Record<string, unknown> & { type?: string; $schema?: string };
	scope: DokployMcpScope;
	annotations: McpToolAnnotations;
}

interface ProcedureDef {
	type: "query" | "mutation" | "subscription";
	meta?: {
		openapi?: { enabled?: boolean; description?: string; summary?: string };
	};
	inputs?: unknown[];
}

const JSON_SCHEMA_2020 = "https://json-schema.org/draft/2020-12/schema";
const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

/** Unwrap optional/nullable/default wrappers so the object schema is at the root. */
const unwrapZod = (schema: unknown): unknown => {
	let current = schema as {
		_zod?: { def?: { type?: string; innerType?: unknown } };
	};
	for (let i = 0; i < 5; i += 1) {
		const def = current?._zod?.def;
		if (!def) break;
		if (
			(def.type === "optional" ||
				def.type === "nullable" ||
				def.type === "default") &&
			def.innerType
		) {
			current = def.innerType as typeof current;
			continue;
		}
		break;
	}
	return current;
};

const stripNestedSchemaKeys = (node: unknown): void => {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) stripNestedSchemaKeys(item);
		return;
	}
	const record = node as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		if (key === "$schema") {
			delete record[key];
			continue;
		}
		stripNestedSchemaKeys(value);
	}
};

/**
 * Zod input → JSON schema for MCP clients. Returns null when the input is not
 * an object schema (the tool is then skipped: MCP arguments are always an
 * object). Unrepresentable constructs (transforms, custom refinements) become
 * `{}` (any) rather than throwing.
 */
const toObjectJsonSchema = (
	inputs: unknown[] | undefined,
): McpToolDefinition["inputSchema"] | null => {
	if (!inputs || inputs.length === 0) {
		return { $schema: JSON_SCHEMA_2020, ...EMPTY_OBJECT_SCHEMA };
	}
	const converted: Record<string, unknown>[] = [];
	for (const raw of inputs) {
		const schema = unwrapZod(raw);
		if (!schema || typeof schema !== "object" || !("_zod" in schema))
			return null;
		try {
			converted.push(
				z.toJSONSchema(schema as z.ZodType, {
					target: "draft-2020-12",
					unrepresentable: "any",
					io: "input",
				}) as Record<string, unknown>,
			);
		} catch {
			return null;
		}
	}
	const root =
		converted.length === 1
			? converted[0]!
			: { type: "object", allOf: converted };
	for (const part of converted) stripNestedSchemaKeys(part);
	if (root.type !== "object") return null;
	return {
		...root,
		$schema: JSON_SCHEMA_2020,
	} as McpToolDefinition["inputSchema"];
};

export interface BuildRegistryOptions {
	/** Router names whose procedures are never exposed (the `mcp` router itself). */
	excludeRouters?: string[];
}

/**
 * Derives the tool list from a tRPC router. Pure: no caching, no I/O. The
 * production registry (`getMcpToolRegistry`) caches the result of calling this
 * on `appRouter` once per process.
 */
export const buildMcpToolRegistry = (
	router: AnyRouter,
	options: BuildRegistryOptions = {},
): McpToolDefinition[] => {
	const excluded = new Set(options.excludeRouters ?? []);
	const procedures = router._def.procedures as Record<
		string,
		{ _def: ProcedureDef }
	>;
	const tools: McpToolDefinition[] = [];
	for (const [path, procedure] of Object.entries(procedures)) {
		const def = procedure._def;
		if (def.type === "subscription") continue;
		if (def.meta?.openapi?.enabled === false) continue;
		const segments = path.split(".");
		const routerName = segments[0] ?? "";
		const procedureName = segments.slice(1).join(".");
		if (!routerName || !procedureName || excluded.has(routerName)) continue;
		const inputSchema = toObjectJsonSchema(def.inputs);
		if (!inputSchema) {
			console.warn(`[mcp] skipping ${path}: input is not an object schema`);
			continue;
		}
		const type = def.type;
		const scope = resolveToolScope({ routerName, procedureName, type });
		const method = type === "query" ? "GET" : "POST";
		const name = segments.join("-");
		tools.push({
			name,
			path,
			routerName,
			procedureName,
			type,
			description:
				def.meta?.openapi?.description ??
				def.meta?.openapi?.summary ??
				`${method} /${path}`,
			inputSchema,
			scope,
			annotations: {
				title: name,
				readOnlyHint: type === "query",
				idempotentHint: type === "query",
				destructiveHint:
					isDestructiveScope(scope) ||
					(scope === "dokploy:admin" &&
						/^(clean|remove|delete)/i.test(procedureName)),
				openWorldHint: true,
			},
		});
	}
	return tools;
};

export const toolsForScopes = (
	tools: McpToolDefinition[],
	scopes: Set<string>,
) => tools.filter((tool) => scopes.has(tool.scope));

export const countToolsByScope = (tools: McpToolDefinition[]) => {
	const counts: Record<string, number> = {};
	for (const tool of tools) counts[tool.scope] = (counts[tool.scope] ?? 0) + 1;
	return counts;
};

let cached: McpToolDefinition[] | null = null;

/** Process-wide registry built from appRouter on first use. */
export const getMcpToolRegistry = async (): Promise<McpToolDefinition[]> => {
	if (cached) return cached;
	const { appRouter } = await import("@/server/api/root");
	cached = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
	return cached;
};
