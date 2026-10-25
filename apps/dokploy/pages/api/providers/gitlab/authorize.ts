import { findGitlabById } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderOAuthAccess,
	createGitProviderOAuthNonce,
	createGitProviderOAuthState,
	isCrossSiteRequest,
	setGitProviderOAuthNonceCookie,
} from "@/server/utils/git-provider-oauth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		return res.status(405).json({ error: "Method not allowed" });
	}

	if (isCrossSiteRequest(req)) {
		return res.status(403).json({ error: "Forbidden" });
	}

	const { gitlabId } = req.query;
	if (!gitlabId || Array.isArray(gitlabId)) {
		return res.status(400).json({ error: "Invalid GitLab provider ID" });
	}

	const gitlab = await findGitlabById(gitlabId).catch(() => null);
	if (!gitlab) {
		return res.status(404).json({ error: "Git provider not found" });
	}

	const access = await checkGitProviderOAuthAccess(req, gitlab.gitProvider);
	if (!access.ok) {
		return res.status(access.status).json({ error: access.error });
	}

	if (!gitlab.applicationId || !gitlab.redirectUri) {
		return res.status(400).json({ error: "Incomplete OAuth configuration" });
	}

	let authUrl: URL;
	try {
		authUrl = new URL(`${gitlab.gitlabUrl}/oauth/authorize`);
	} catch {
		return res.status(400).json({ error: "Invalid GitLab URL" });
	}

	const nonce = createGitProviderOAuthNonce();
	const state = createGitProviderOAuthState(
		{
			provider: "gitlab",
			providerId: gitlab.gitlabId,
			userId: access.userId,
			organizationId: access.organizationId,
		},
		{ nonce },
	);

	// Same redirect_uri the callback sends with the token exchange.
	authUrl.searchParams.set("client_id", gitlab.applicationId);
	authUrl.searchParams.set(
		"redirect_uri",
		`${gitlab.redirectUri}?gitlabId=${gitlab.gitlabId}`,
	);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("scopes", "api read_user read_repository");
	authUrl.searchParams.set("state", state);

	setGitProviderOAuthNonceCookie(req, res, "gitlab", nonce);
	return res.redirect(307, authUrl.toString());
}
