import {
	MCP_AUTHORIZE_PAGE_PATH,
	MCP_ENDPOINT_PATH,
} from "@dokploy/server/services/mcp-oauth";
import { DOKPLOY_MCP_SCOPE_IDS } from "@dokploy/server/services/mcp-scopes";

const SCOPES_SUPPORTED = ["openid", "offline_access", ...DOKPLOY_MCP_SCOPE_IDS];

/** RFC 8414 document. `issuer` must equal the origin the client fetched it from. */
export const buildAuthorizationServerMetadata = (origin: string) => ({
	issuer: origin,
	authorization_endpoint: `${origin}${MCP_AUTHORIZE_PAGE_PATH}`,
	token_endpoint: `${origin}/api/auth/mcp/token`,
	registration_endpoint: `${origin}/api/auth/mcp/register`,
	scopes_supported: SCOPES_SUPPORTED,
	response_types_supported: ["code"],
	response_modes_supported: ["query"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: [
		"none",
		"client_secret_basic",
		"client_secret_post",
	],
	subject_types_supported: ["public"],
});

/** RFC 9728 document for the MCP endpoint. */
export const buildProtectedResourceMetadata = (origin: string) => ({
	resource: `${origin}${MCP_ENDPOINT_PATH}`,
	authorization_servers: [origin],
	scopes_supported: SCOPES_SUPPORTED,
	bearer_methods_supported: ["header"],
});
