import { findGitlabById } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderOAuthAccess,
	createGitProviderOAuthState,
} from "@/server/utils/git-provider-oauth";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		return res.status(405).json({ error: "Method not allowed" });
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

	const state = createGitProviderOAuthState({
		provider: "gitlab",
		providerId: gitlab.gitlabId,
		userId: access.userId,
		organizationId: access.organizationId,
	});

	// Same redirect_uri the callback sends with the token exchange.
	const redirectUri = `${gitlab.redirectUri}?gitlabId=${gitlab.gitlabId}`;
	const scope = "api read_user read_repository";
	const authUrl = `${gitlab.gitlabUrl}/oauth/authorize?client_id=${gitlab.applicationId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scopes=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;

	return res.redirect(307, authUrl);
}
