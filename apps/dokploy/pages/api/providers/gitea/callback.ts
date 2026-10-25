import { updateGitea } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderOAuthAccess,
	clearGitProviderOAuthNonceCookie,
	gitProviderOAuthNonceMatches,
	readGitProviderOAuthNonceCookie,
	verifyGitProviderOAuthState,
} from "@/server/utils/git-provider-oauth";
import { findGitea, type Gitea, redirectWithError } from "./helper";

// Helper to fetch access token from Gitea
const fetchAccessToken = async (gitea: Gitea, code: string) => {
	// Use internal URL for token exchange when Gitea is on same instance as Dokploy
	const baseUrl = gitea.giteaInternalUrl || gitea.giteaUrl;
	const response = await fetch(`${baseUrl}/login/oauth/access_token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: gitea.clientId as string,
			client_secret: gitea.clientSecret as string,
			code,
			grant_type: "authorization_code",
			redirect_uri: gitea.redirectUri || "",
		}),
	});

	const responseText = await response.text();
	return response.ok
		? JSON.parse(responseText)
		: { error: "Token exchange failed", responseText };
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { code, state } = req.query;

	// The nonce cookie is single use: it is cleared whatever the outcome.
	const cookieNonce = readGitProviderOAuthNonceCookie(req, "gitea");
	clearGitProviderOAuthNonceCookie(req, res, "gitea");

	if (!code || Array.isArray(code) || !state || Array.isArray(state)) {
		return redirectWithError(
			res,
			"Invalid authorization code or state parameter",
		);
	}

	// The state has to be one this server signed for this provider, and the
	// session has to be the one that started the flow and may update it.
	const oauthState = verifyGitProviderOAuthState(state, "gitea");
	if (!oauthState) {
		return res.status(400).json({ error: "Invalid or expired OAuth state" });
	}
	if (!gitProviderOAuthNonceMatches(cookieNonce, oauthState.nonce)) {
		return res
			.status(403)
			.json({ error: "OAuth flow was not started from this browser" });
	}

	const gitea = await findGitea(oauthState.providerId);
	if (!gitea) {
		return res.status(404).json({ error: "Git provider not found" });
	}

	const access = await checkGitProviderOAuthAccess(
		req,
		gitea.gitProvider,
		oauthState,
	);
	if (!access.ok) {
		return res.status(access.status).json({ error: access.error });
	}

	// Fetch the access token from Gitea
	const result = await fetchAccessToken(gitea, code as string);

	if (result.error) {
		console.error("Token exchange failed:", result);
		return redirectWithError(res, result.error);
	}

	if (!result.access_token) {
		console.error("Missing access token:", result);
		return redirectWithError(res, "No access token received");
	}

	const expiresAt = result.expires_in
		? Math.floor(Date.now() / 1000) + result.expires_in
		: null;

	try {
		await updateGitea(gitea.giteaId, {
			accessToken: result.access_token,
			refreshToken: result.refresh_token,
			expiresAt,
			...(result.organizationName
				? { organizationName: result.organizationName }
				: {}),
		});

		return res.redirect(
			307,
			"/dashboard/settings/git-providers?connected=true",
		);
	} catch (updateError) {
		console.error("Failed to update Gitea provider:", updateError);
		return redirectWithError(res, "Failed to store access token");
	}
}
