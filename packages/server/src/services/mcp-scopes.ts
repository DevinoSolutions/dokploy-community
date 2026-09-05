/**
 * Scope ids the MCP OAuth server accepts.
 *
 * This module is deliberately a leaf: it imports nothing, so the web app's
 * scope catalogue (`apps/dokploy/server/mcp/scopes.ts`) can read the ids
 * without dragging `db`, `node-schedule` and the rest of `mcp-oauth.ts` into a
 * page bundle. `services/mcp-oauth.ts` re-exports both names, so existing
 * imports keep working.
 *
 * The catalogue with labels and descriptions lives in
 * `apps/dokploy/server/mcp/scopes.ts`.
 */
export const DOKPLOY_MCP_SCOPE_IDS = [
	"dokploy:read",
	"dokploy:deploy",
	"dokploy:services:write",
	"dokploy:services:delete",
	"dokploy:projects:write",
	"dokploy:projects:delete",
	"dokploy:backups",
	"dokploy:admin",
] as const;

export type DokployMcpScope = (typeof DOKPLOY_MCP_SCOPE_IDS)[number];
