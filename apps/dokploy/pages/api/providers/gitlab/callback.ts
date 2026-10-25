import { findGitlabById, updateGitlab } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderOAuthAccess,
	clearGitProviderOAuthNonceCookie,
	gitProviderOAuthNonceMatches,
	readGitProviderOAuthNonceCookie,
	verifyGitProviderOAuthState,
} from "@/server/utils/git-provider-oauth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { code, gitlabId, state } = req.query;

	// The nonce cookie is single use: it is cleared whatever the outcome.
	const cookieNonce = readGitProviderOAuthNonceCookie(req, "gitlab");
	clearGitProviderOAuthNonceCookie(req, res, "gitlab");

	if (!code || Array.isArray(code)) {
		return res.status(400).json({ error: "Missing or invalid code" });
	}

	if (!gitlabId || Array.isArray(gitlabId)) {
		return res.status(400).json({ error: "Invalid GitLab provider ID" });
	}

	// The state has to be one this server signed for this provider, and the
	// session has to be the one that started the flow and may update it.
	const oauthState = verifyGitProviderOAuthState(state, "gitlab");
	if (!oauthState || oauthState.providerId !== gitlabId) {
		return res.status(400).json({ error: "Invalid or expired OAuth state" });
	}
	if (!gitProviderOAuthNonceMatches(cookieNonce, oauthState.nonce)) {
		return res
			.status(403)
			.json({ error: "OAuth flow was not started from this browser" });
	}

	const gitlab = await findGitlabById(gitlabId).catch(() => null);
	if (!gitlab) {
		return res.status(404).json({ error: "Git provider not found" });
	}

	const access = await checkGitProviderOAuthAccess(
		req,
		gitlab.gitProvider,
		oauthState,
	);
	if (!access.ok) {
		return res.status(access.status).json({ error: access.error });
	}

	// Use internal URL for token exchange when GitLab is on same instance as Dokploy
	const baseUrl = gitlab.gitlabInternalUrl || gitlab.gitlabUrl;
	const gitlabUrl = new URL(baseUrl);

	const headers: HeadersInit = {
		"Content-Type": "application/x-www-form-urlencoded",
	};

	// In case of basic auth being present in the URL, we need to remove it from the URL
	// and add it to the Authorization header.
	if (gitlabUrl.username && gitlabUrl.password) {
		headers.Authorization = `Basic ${Buffer.from(`${gitlabUrl.username}:${gitlabUrl.password}`).toString("base64")}`;
	}

	const url = gitlabUrl.origin + gitlabUrl.pathname.replace(/\/$/, "");

	const response = await fetch(`${url}/oauth/token`, {
		method: "POST",
		headers,
		redirect: "manual",
		body: new URLSearchParams({
			client_id: gitlab.applicationId as string,
			client_secret: gitlab.secret as string,
			code: code as string,
			grant_type: "authorization_code",
			redirect_uri: `${gitlab.redirectUri}?gitlabId=${gitlabId}`,
		}),
	});

	if (!response.ok) {
		return res.status(response.status).json({
			error: `GitLab token exchange failed: ${response.statusText}`,
		});
	}

	const result = await response.json();

	if (!result.access_token || !result.refresh_token) {
		return res.status(400).json({ error: "Missing or invalid code" });
	}

	const expiresAt = result.expires_in
		? Math.floor(Date.now() / 1000) + result.expires_in
		: null;
	await updateGitlab(gitlab.gitlabId, {
		accessToken: result.access_token,
		refreshToken: result.refresh_token,
		expiresAt,
	});

	return res.redirect(307, "/dashboard/settings/git-providers");
}
