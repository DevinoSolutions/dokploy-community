import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({ db: {} }));

import {
	presentGithubConnection,
	presentGithubWatch,
} from "@dokploy/server/services/github-deployments/store";

describe("what the API and MCP may show of a connection", () => {
	const row = {
		connectionId: "c1",
		organizationId: "org1",
		createdByUserId: "u1",
		githubLogin: "amin",
		githubUserId: "123",
		scopes: "repo_deployment,read:packages",
		sharedWithOrganization: false,
		accessToken: "gho_super_secret_token",
		status: "active",
		lastError: null,
		createdAt: new Date("2026-11-01T00:00:00Z"),
	};

	it("carries the login and scopes but never the token", () => {
		const shown = presentGithubConnection(row);
		expect(shown).toEqual({
			connectionId: "c1",
			githubLogin: "amin",
			scopes: ["repo_deployment", "read:packages"],
			sharedWithOrganization: false,
			status: "active",
			lastError: null,
			createdAt: row.createdAt,
		});
		expect(JSON.stringify(shown)).not.toContain("gho_super_secret_token");
		expect(shown).not.toHaveProperty("accessToken");
		expect(shown).not.toHaveProperty("githubUserId");
	});

	it("reports an empty scope list as an empty array", () => {
		expect(presentGithubConnection({ ...row, scopes: "" }).scopes).toEqual([]);
	});

	it("a watch shows its progress but not the ETag or the organization", () => {
		const shown = presentGithubWatch({
			watchId: "w1",
			organizationId: "org1",
			serviceType: "compose",
			serviceId: "svc",
			connectionId: "c1",
			owner: "o",
			repo: "r",
			environment: "production",
			enabled: true,
			postLogUrl: false,
			lastSeenDeploymentId: 5,
			etag: 'W/"x"',
			inflightDeploymentId: null,
			inflightStartedAt: null,
			lastCheckedAt: null,
			lastError: null,
			createdAt: new Date(0),
		});
		expect(shown).not.toHaveProperty("etag");
		expect(shown).not.toHaveProperty("organizationId");
		expect(shown.lastSeenDeploymentId).toBe(5);
		expect(shown.postLogUrl).toBe(false);
	});
});
