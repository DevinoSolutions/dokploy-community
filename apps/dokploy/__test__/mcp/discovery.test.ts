import { describe, expect, it } from "vitest";
import {
	buildAuthorizationServerMetadata,
	buildProtectedResourceMetadata,
} from "@/server/mcp/discovery";

describe("discovery metadata", () => {
	const origin = "https://dok.example.com";

	it("authorization server document points at the fork consent page and plugin endpoints", () => {
		const doc = buildAuthorizationServerMetadata(origin);
		expect(doc).toMatchObject({
			issuer: origin,
			authorization_endpoint: `${origin}/mcp/authorize`,
			token_endpoint: `${origin}/api/auth/mcp/token`,
			registration_endpoint: `${origin}/api/auth/mcp/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: [
				"none",
				"client_secret_basic",
				"client_secret_post",
			],
		});
		expect(doc.scopes_supported).toEqual([
			"openid",
			"offline_access",
			"dokploy:read",
			"dokploy:deploy",
			"dokploy:services:write",
			"dokploy:services:delete",
			"dokploy:projects:write",
			"dokploy:projects:delete",
			"dokploy:backups",
			"dokploy:admin",
		]);
	});

	it("protected resource document names the endpoint and the origin as AS", () => {
		expect(buildProtectedResourceMetadata(origin)).toEqual({
			resource: `${origin}/api/mcp`,
			authorization_servers: [origin],
			scopes_supported:
				buildAuthorizationServerMetadata(origin).scopes_supported,
			bearer_methods_supported: ["header"],
		});
	});
});
