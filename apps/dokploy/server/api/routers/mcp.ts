import {
	createConsentProof,
	findOAuthApplicationByClientId,
	findOrganizationName,
	getMcpRefreshTokenSeconds,
	isMcpDisabled,
	listMcpAuthorizations,
	MCP_ENDPOINT_PATH,
	MCP_PLUGIN_AUTHORIZE_PATH,
	recordMcpConsent,
	resolveDefaultOrganizationId,
	resolveMcpOrigin,
	revokeMcpAuthorization,
} from "@dokploy/server/services/mcp-oauth";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { countToolsByScope, getMcpToolRegistry } from "@/server/mcp/registry";
import { DOKPLOY_SCOPES, isDokployScope } from "@/server/mcp/scopes";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/** Never exposed over REST or MCP: these manage the MCP grant itself. */
const hidden = (name: string) => ({
	openapi: {
		enabled: false,
		method: "POST" as const,
		path: `/mcp.${name}` as const,
	},
});

export const mcpRouter = createTRPCRouter({
	connectionInfo: protectedProcedure
		.meta(hidden("connectionInfo"))
		.query(async ({ ctx }) => {
			const disabled = isMcpDisabled();
			const origin = disabled ? null : await resolveMcpOrigin(ctx.req.headers);
			const organizationId = await resolveDefaultOrganizationId(ctx.user.id);
			const organization = organizationId
				? await findOrganizationName(organizationId)
				: null;
			const counts = countToolsByScope(await getMcpToolRegistry());
			const endpoint = origin ? `${origin}${MCP_ENDPOINT_PATH}` : null;
			return {
				enabled: !disabled && !!origin,
				reason: disabled
					? ("disabled" as const)
					: origin
						? null
						: ("unconfigured" as const),
				origin,
				endpoint,
				addCommand: endpoint
					? `claude mcp add --transport http --scope user dokploy ${endpoint}`
					: null,
				organization,
				refreshTokenDays: Math.round(getMcpRefreshTokenSeconds() / 86400),
				scopes: DOKPLOY_SCOPES.map((scope) => ({
					...scope,
					toolCount: counts[scope.id] ?? 0,
				})),
			};
		}),

	listAuthorizations: protectedProcedure
		.meta(hidden("listAuthorizations"))
		.query(({ ctx }) => listMcpAuthorizations(ctx.user.id)),

	revokeAuthorization: protectedProcedure
		.meta(hidden("revokeAuthorization"))
		.input(z.object({ clientId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await revokeMcpAuthorization(ctx.user.id, input.clientId);
			return { success: true };
		}),

	/**
	 * Consent page → plugin handoff. Validates the client and every OAuth
	 * parameter, then mints the consent proof the plugin's authorize hook
	 * requires (see packages/server/src/lib/auth.ts).
	 */
	approveAuthorization: protectedProcedure
		.meta(hidden("approveAuthorization"))
		.input(
			z.object({
				clientId: z.string().min(1),
				redirectUri: z.string().min(1),
				responseType: z.string(),
				state: z.string().optional(),
				codeChallenge: z.string().min(1),
				codeChallengeMethod: z.string(),
				resource: z.string().optional(),
				scopes: z.array(z.string()),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const client = await findOAuthApplicationByClientId(input.clientId);
			if (!client || client.disabled) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Unknown OAuth client",
				});
			}
			if (!client.redirectUrls.includes(input.redirectUri)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "redirect_uri is not registered for this client",
				});
			}
			if (input.responseType !== "code") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "response_type must be code",
				});
			}
			if (input.codeChallengeMethod !== "S256") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "PKCE S256 is required",
				});
			}
			if (!input.scopes.every(isDokployScope)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Unknown scope requested",
				});
			}
			const selectedScopes = [...new Set(input.scopes)].sort();
			const scope = ["openid", "offline_access", ...selectedScopes].join(" ");
			// Grant record: gives the settings card a stable "authorized at" and a
			// scope history that survives refresh-token rotation.
			await recordMcpConsent(ctx.user.id, input.clientId, selectedScopes);
			const state = input.state ?? "";
			const consent = createConsentProof({
				userId: ctx.user.id,
				clientId: input.clientId,
				redirectUri: input.redirectUri,
				state,
				codeChallenge: input.codeChallenge,
				scope,
			});
			const params = new URLSearchParams({
				client_id: input.clientId,
				redirect_uri: input.redirectUri,
				response_type: "code",
				code_challenge: input.codeChallenge,
				code_challenge_method: "S256",
				scope,
				consent,
			});
			if (state) params.set("state", state);
			if (input.resource) params.set("resource", input.resource);
			return { url: `${MCP_PLUGIN_AUTHORIZE_PATH}?${params.toString()}` };
		}),
});
