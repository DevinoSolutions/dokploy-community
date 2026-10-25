import {
	createGithub,
	deriveGithubApiUrl,
	parseGithubBaseUrl,
	verifyGithubInstallation,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { Octokit } from "octokit";
import { github } from "@/server/db/schema";
import {
	checkGitProviderCreateAccess,
	checkGitProviderOAuthAccess,
	clearGitProviderOAuthNonceCookie,
	gitProviderOAuthNonceMatches,
	readGitProviderOAuthNonceCookie,
	verifyGitProviderOAuthState,
} from "@/server/utils/git-provider-oauth";

type Query = {
	code: string;
	state: string;
	installation_id: string;
	setup_action: string;
	githubUrl?: string;
};

// GitHub calls back here twice, with the `state` the dashboard sent along:
// `github_init` after the app was created from the manifest, `github_setup`
// after it was installed. Both are signed by this server and tied to the
// browser that started them, because they write to the organization's
// providers.
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { code, state, installation_id, githubUrl }: Query = req.query as Query;

	const oauthState =
		verifyGitProviderOAuthState(state, "github_init") ??
		verifyGitProviderOAuthState(state, "github_setup");

	if (!oauthState) {
		clearGitProviderOAuthNonceCookie(req, res, "github_init");
		clearGitProviderOAuthNonceCookie(req, res, "github_setup");
		return res.status(400).json({
			error: code
				? "Invalid or expired setup state, start again from Git Providers"
				: "Missing code parameter",
		});
	}

	// The nonce cookie is single use: it is cleared whatever the outcome.
	const cookieNonce = readGitProviderOAuthNonceCookie(req, oauthState.provider);
	clearGitProviderOAuthNonceCookie(req, res, oauthState.provider);

	if (!code) {
		return res.status(400).json({ error: "Missing code parameter" });
	}
	if (!gitProviderOAuthNonceMatches(cookieNonce, oauthState.nonceHash)) {
		return res
			.status(403)
			.json({ error: "Setup was not started from this browser" });
	}

	if (oauthState.provider === "github_init") {
		// Reject before any outbound request: this runs on a GET the user can be
		// linked into, so the host is not trusted. It also has to be the one the
		// signed state was issued for.
		const parsed = parseGithubBaseUrl(githubUrl);
		if ("error" in parsed) {
			return res.status(400).json({ error: parsed.error });
		}
		if (parsed.url !== oauthState.providerId) {
			return res.status(400).json({ error: "GitHub URL does not match" });
		}

		const access = await checkGitProviderCreateAccess(req, oauthState);
		if (!access.ok) {
			return res.status(access.status).json({ error: access.error });
		}

		const baseUrl = parsed.url;
		const octokit = new Octokit({ baseUrl: deriveGithubApiUrl(baseUrl) });
		const { data } = await octokit.request(
			"POST /app-manifests/{code}/conversions",
			{
				code: code as string,
			},
		);

		await createGithub(
			{
				name: data.name,
				githubAppName: data.html_url,
				githubAppId: data.id,
				githubClientId: data.client_id,
				githubClientSecret: data.client_secret,
				githubWebhookSecret: data.webhook_secret,
				githubPrivateKey: data.pem,
				githubUrl: baseUrl,
			},
			access.organizationId,
			access.userId,
		);
	} else {
		const provider = await db.query.github.findFirst({
			where: eq(github.githubId, oauthState.providerId),
			with: { gitProvider: true },
		});
		if (!provider) {
			return res.status(404).json({ error: "Github provider not found" });
		}

		// Same rule as the provider update route: only its creator or an org
		// owner/admin may change the installation it uses.
		const access = await checkGitProviderOAuthAccess(
			req,
			provider.gitProvider,
			oauthState,
		);
		if (!access.ok) {
			return res.status(access.status).json({ error: access.error });
		}

		if (typeof installation_id !== "string") {
			return res.status(400).json({ error: "Missing installation id" });
		}
		const installation = await verifyGithubInstallation(
			provider,
			installation_id,
		);
		if (!installation.ok) {
			if (installation.reason === "unavailable") {
				return res
					.status(502)
					.json({ error: "Could not verify the installation with GitHub" });
			}
			return res
				.status(400)
				.json({ error: "Installation does not belong to this GitHub App" });
		}

		await db
			.update(github)
			.set({
				githubInstallationId: installation_id,
			})
			.where(eq(github.githubId, provider.githubId))
			.returning();
	}

	res.redirect(307, "/dashboard/settings/git-providers");
}
