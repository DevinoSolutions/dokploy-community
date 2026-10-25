import { findGithubById } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	checkGitProviderOAuthAccess,
	createGitProviderOAuthNonce,
	createGitProviderOAuthState,
	isFetchSiteAllowed,
	setGitProviderOAuthNonceCookie,
} from "@/server/utils/git-provider-oauth";

// Starts the "install the GitHub App" step: checks the session, signs the
// state and sends the browser to the app's installation page. GitHub calls
// back on /api/providers/github/setup.
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "GET") {
		return res.status(405).json({ error: "Method not allowed" });
	}

	if (!isFetchSiteAllowed(req)) {
		return res.status(403).json({ error: "Forbidden" });
	}

	const { githubId } = req.query;
	if (!githubId || Array.isArray(githubId)) {
		return res.status(400).json({ error: "Invalid GitHub provider ID" });
	}

	const github = await findGithubById(githubId).catch(() => null);
	if (!github) {
		return res.status(404).json({ error: "Git provider not found" });
	}

	const access = await checkGitProviderOAuthAccess(req, github.gitProvider);
	if (!access.ok) {
		return res.status(access.status).json({ error: access.error });
	}

	let installUrl: URL;
	try {
		installUrl = new URL(github.githubAppName ?? "");
		if (installUrl.protocol !== "https:" && installUrl.protocol !== "http:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		return res.status(400).json({ error: "Invalid GitHub App URL" });
	}
	installUrl.pathname = `${installUrl.pathname.replace(/\/+$/, "")}/installations/new`;
	installUrl.search = "";
	installUrl.hash = "";

	const nonce = createGitProviderOAuthNonce();
	installUrl.searchParams.set(
		"state",
		createGitProviderOAuthState(
			{
				provider: "github_setup",
				providerId: github.githubId,
				userId: access.userId,
				organizationId: access.organizationId,
			},
			{ nonce },
		),
	);

	setGitProviderOAuthNonceCookie(req, res, "github_setup", nonce);
	return res.redirect(307, installUrl.toString());
}
