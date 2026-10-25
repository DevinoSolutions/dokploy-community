// utils/gitea-utils.ts
// This file contains client-safe utilities for Gitea integration

/**
 * Returns the URL that starts the Gitea OAuth flow. The server route checks the
 * session, signs the OAuth state and redirects to the Gitea authorize page.
 *
 * @param giteaId The ID of the Gitea provider
 * @param clientId The OAuth client ID
 * @param giteaUrl The base URL of the Gitea instance
 * @returns The URL to open, or "#" when the configuration is incomplete
 */
export const getGiteaOAuthUrl = (
	giteaId: string,
	clientId: string,
	giteaUrl: string,
): string => {
	if (!giteaId || !clientId || !giteaUrl) {
		// Return a marker that can be checked by the caller
		return "#";
	}

	return `/api/providers/gitea/authorize?giteaId=${encodeURIComponent(giteaId)}`;
};

// Interfaces for Gitea API responses and components
export interface Repository {
	name: string;
	url: string;
	id: number;
	owner: {
		username: string;
	};
}

export interface Branch {
	name: string;
}

export interface GiteaProviderType {
	giteaId: string;
	gitProvider: {
		name: string;
		gitProviderId: string;
		providerType: "github" | "gitlab" | "bitbucket" | "gitea";
		createdAt: string;
		organizationId: string;
	};
	name: string;
}

export interface GiteaProviderResponse {
	giteaId: string;
	clientId: string;
	giteaUrl: string;
}

export interface GitProvider {
	gitProviderId: string;
	name: string;
	providerType: string;
	giteaId?: string;
	gitea?: {
		giteaId: string;
		giteaUrl: string;
		clientId: string;
	};
}

export interface GiteaProvider {
	gitea?: {
		giteaId?: string;
		giteaUrl?: string;
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		organizationName?: string;
	};
	name?: string;
	gitProviderId?: string;
}
