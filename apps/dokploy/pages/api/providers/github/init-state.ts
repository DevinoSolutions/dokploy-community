import { parseGithubBaseUrl } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderCreateAccess,
	createGitProviderOAuthNonce,
	createGitProviderOAuthState,
	isFetchSiteAllowed,
	setGitProviderOAuthNonceCookie,
} from "@/server/utils/git-provider-oauth";

// Issues the signed `state` the GitHub App manifest form carries to GitHub, and
// the nonce cookie that ties it to this browser. The dashboard calls it right
// before it submits the form.
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "POST") {
		return res.status(405).json({ error: "Method not allowed" });
	}

	if (!isFetchSiteAllowed(req)) {
		return res.status(403).json({ error: "Forbidden" });
	}

	const githubUrl = req.body?.githubUrl;
	if (githubUrl !== undefined && typeof githubUrl !== "string") {
		return res.status(400).json({ error: "Invalid GitHub URL" });
	}
	const parsed = parseGithubBaseUrl(githubUrl);
	if ("error" in parsed) {
		return res.status(400).json({ error: parsed.error });
	}

	const access = await checkGitProviderCreateAccess(req);
	if (!access.ok) {
		return res.status(access.status).json({ error: access.error });
	}

	const nonce = createGitProviderOAuthNonce();
	const state = createGitProviderOAuthState(
		{
			provider: "github_init",
			providerId: parsed.url,
			userId: access.userId,
			organizationId: access.organizationId,
		},
		{ nonce },
	);

	setGitProviderOAuthNonceCookie(req, res, "github_init", nonce);
	res.setHeader("Cache-Control", "no-store");
	return res.status(200).json({ state });
}
