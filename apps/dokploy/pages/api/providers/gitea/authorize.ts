import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderOAuthAccess,
	createGitProviderOAuthNonce,
	createGitProviderOAuthState,
	isFetchSiteAllowed,
	setGitProviderOAuthNonceCookie,
} from "@/server/utils/git-provider-oauth";
import { findGitea, redirectWithError } from "./helper";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	try {
		if (req.method !== "GET") {
			return res.status(405).json({ error: "Method not allowed" });
		}

		if (!isFetchSiteAllowed(req)) {
			return res.status(403).json({ error: "Forbidden" });
		}

		const { giteaId } = req.query;

		if (!giteaId || Array.isArray(giteaId)) {
			return res.status(400).json({ error: "Invalid Gitea provider ID" });
		}

		const gitea = await findGitea(giteaId);
		if (!gitea) {
			return res.status(404).json({ error: "Git provider not found" });
		}

		const access = await checkGitProviderOAuthAccess(req, gitea.gitProvider);
		if (!access.ok) {
			return res.status(access.status).json({ error: access.error });
		}

		if (!gitea.clientId || !gitea.redirectUri) {
			return redirectWithError(res, "Incomplete OAuth configuration");
		}

		const nonce = createGitProviderOAuthNonce();
		const state = createGitProviderOAuthState(
			{
				provider: "gitea",
				providerId: gitea.giteaId,
				userId: access.userId,
				organizationId: access.organizationId,
			},
			{ nonce },
		);

		// Generate the Gitea authorization URL
		const authorizationUrl = new URL(`${gitea.giteaUrl}/login/oauth/authorize`);
		authorizationUrl.searchParams.append("client_id", gitea.clientId);
		authorizationUrl.searchParams.append("response_type", "code");
		authorizationUrl.searchParams.append("redirect_uri", gitea.redirectUri);
		authorizationUrl.searchParams.append(
			"scope",
			"read:repository write:repository read:user read:organization",
		);
		authorizationUrl.searchParams.append("state", state);

		// Redirect user to Gitea authorization URL
		setGitProviderOAuthNonceCookie(req, res, "gitea", nonce);
		return res.redirect(307, authorizationUrl.toString());
	} catch (error) {
		console.error("Error initiating Gitea OAuth flow:", error);
		return res.status(500).json({ error: "Internal server error" });
	}
}
