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

/**
 * `saveEnvironment` REPLACES the whole variable set, and a read over MCP
 * returns the values blanked, so the tool says how to do it safely (T-7007).
 */
const SAVE_ENVIRONMENT_NOTE: Record<string, string> = {
	saveEnvironment:
		" Replaces the entire env, so a call that would drop existing variables is refused (the error names them): pass mergeEnv: true to set or add only the variables you send and keep the rest, with unsetKeys to remove named ones, or replaceAll: true to replace everything on purpose. Values read back blank over MCP (use the envKeys tool for the names), and an empty env is refused unless allowEmptySecrets is true with the dokploy:admin scope.",
};

/** Routers whose `saveEnvironment` writes a variable block (the ones the replace guard covers). */
export const ENV_SAVE_ROUTERS: ReadonlySet<string> = new Set([
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

/** Fields of a saveEnvironment input that hold a dotenv-style block. */
export const ENV_BLOCK_FIELDS = ["env", "buildArgs", "buildSecrets"] as const;

/** MCP-only arguments of the environment save tools; stripped before the procedure runs. */
export const REPLACE_ALL_ARG = "replaceAll";
export const MERGE_ENV_ARG = "mergeEnv";
export const UNSET_KEYS_ARG = "unsetKeys";

export const isEnvSaveTool = (
	tool: Pick<McpToolDefinition, "type" | "routerName" | "procedureName">,
) =>
	tool.type === "mutation" &&
	tool.procedureName === "saveEnvironment" &&
	ENV_SAVE_ROUTERS.has(tool.routerName);

/** Routers whose update tool can also carry a variable block (a service row, or the shared project/environment env). */
export const ENV_UPDATE_ROUTERS: ReadonlySet<string> = new Set([
	...ENV_SAVE_ROUTERS,
	"project",
	"environment",
]);

/** Every column that holds a dotenv-style block. */
export const ENV_LIKE_FIELDS = [
	"env",
	"buildArgs",
	"buildSecrets",
	"previewEnv",
	"previewBuildArgs",
	"previewBuildSecrets",
] as const;

export const isEnvUpdateTool = (
	tool: Pick<McpToolDefinition, "type" | "routerName" | "procedureName">,
) =>
	tool.type === "mutation" &&
	tool.procedureName === "update" &&
	ENV_UPDATE_ROUTERS.has(tool.routerName);

/** The variable-block fields a tool's input schema takes. */
export const envFieldsOf = (
	tool: Pick<McpToolDefinition, "inputSchema">,
): Array<(typeof ENV_LIKE_FIELDS)[number]> => {
	const properties = tool.inputSchema.properties;
	if (typeof properties !== "object" || properties === null) return [];
	return ENV_LIKE_FIELDS.filter((field) => field in properties);
};

const ENV_UPDATE_NOTE =
	" Through MCP, a call whose env, buildArgs, buildSecrets or preview variable blocks would drop variables that exist now (or blank their values) is refused, and the error names them (names only when the grant includes dokploy:read); pass replaceAll: true to replace a block on purpose. Values read back blank over MCP.";

const ENV_UPDATE_EXTRA_PROPERTIES = {
	[REPLACE_ALL_ARG]: {
		type: "boolean",
		description:
			"Replace the variable blocks you send even if existing variables are dropped or blanked.",
	},
};

const ENV_SAVE_EXTRA_PROPERTIES = {
	[REPLACE_ALL_ARG]: {
		type: "boolean",
		description:
			"Replace the whole variable set even if existing variables are dropped. Without it, a call that would drop existing variables is refused.",
	},
	[MERGE_ENV_ARG]: {
		type: "boolean",
		description:
			"Keep existing variables: those you send are set or added, the rest are untouched. Send an empty string for a block you do not change.",
	},
	[UNSET_KEYS_ARG]: {
		description:
			"With mergeEnv: names of variables to remove. An array applies to env; an object may name env, buildArgs and buildSecrets separately.",
		anyOf: [
			{ type: "array", items: { type: "string" } },
			{
				type: "object",
				properties: Object.fromEntries(
					ENV_BLOCK_FIELDS.map((field) => [
						field,
						{ type: "array", items: { type: "string" } },
					]),
				),
			},
		],
	},
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
		if (
			isEnvSaveTool({ type, routerName, procedureName }) &&
			inputSchema.properties &&
			typeof inputSchema.properties === "object"
		) {
			inputSchema.properties = {
				...(inputSchema.properties as Record<string, unknown>),
				...ENV_SAVE_EXTRA_PROPERTIES,
			};
		}
		if (
			isEnvUpdateTool({ type, routerName, procedureName }) &&
			inputSchema.properties &&
			typeof inputSchema.properties === "object"
		) {
			inputSchema.properties = {
				...(inputSchema.properties as Record<string, unknown>),
				...ENV_UPDATE_EXTRA_PROPERTIES,
			};
		}
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
				(def.meta?.openapi?.description ??
					def.meta?.openapi?.summary ??
					`${method} /${path}`) +
				(SAVE_ENVIRONMENT_NOTE[procedureName] ?? "") +
				(isEnvUpdateTool({ type, routerName, procedureName })
					? ENV_UPDATE_NOTE
					: ""),
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
