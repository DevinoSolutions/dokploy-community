import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The write side of the fork's cancel trail is best-effort: whatever the
 * database does, the cancel it describes goes through.
 */

const mocks = vi.hoisted(() => ({
	values: vi.fn(),
	insert: vi.fn(),
	findMany: vi.fn(),
	count: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: mocks.insert,
		query: { deploymentCancelAudit: { findMany: mocks.findMany } },
		$count: mocks.count,
	},
}));

const { recordDeploymentCancelAudit, listDeploymentCancelAudit } = await import(
	"@dokploy/server/services/deployment-cancel-audit"
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.values.mockResolvedValue(undefined);
	mocks.insert.mockReturnValue({ values: mocks.values });
});

describe("recordDeploymentCancelAudit", () => {
	it("stores the action, the actor, the organization and the target", async () => {
		await recordDeploymentCancelAudit({
			organizationId: "org-1",
			action: "kill_process",
			actor: {
				type: "api_key",
				userId: "user-1",
				email: "user@example.com",
				apiKeyId: "key-1",
			},
			targetType: "deployment",
			targetId: "dep-1",
			targetName: "app-abc123",
			applicationId: "a1",
			deploymentId: "dep-1",
			metadata: { title: "Rebuild" },
		});

		expect(mocks.values).toHaveBeenCalledWith({
			organizationId: "org-1",
			action: "kill_process",
			actorType: "api_key",
			actorId: "user-1",
			actorEmail: "user@example.com",
			apiKeyId: "key-1",
			oauthClientId: null,
			targetType: "deployment",
			targetId: "dep-1",
			targetName: "app-abc123",
			applicationId: "a1",
			composeId: null,
			deploymentId: "dep-1",
			metadata: JSON.stringify({ title: "Rebuild" }),
		});
	});

	it("stores the OAuth client id of an MCP token call, and no key id", async () => {
		await recordDeploymentCancelAudit({
			organizationId: "org-1",
			action: "cancel_deployment",
			actor: {
				type: "oauth_client",
				userId: "user-1",
				email: "user@example.com",
				oauthClientId: "client-1",
			},
			targetType: "application",
			targetId: "a1",
		});

		expect(mocks.values).toHaveBeenCalledWith(
			expect.objectContaining({
				actorType: "oauth_client",
				actorId: "user-1",
				apiKeyId: null,
				oauthClientId: "client-1",
			}),
		);
	});

	it("writes a system actor with no user", async () => {
		await recordDeploymentCancelAudit({
			organizationId: "org-1",
			action: "coalesce_drop",
			actor: { type: "system" },
			targetType: "application",
			targetId: "a1",
		});

		expect(mocks.values).toHaveBeenCalledWith(
			expect.objectContaining({
				actorType: "system",
				actorId: null,
				actorEmail: null,
				apiKeyId: null,
				metadata: null,
			}),
		);
	});

	it("never throws when the insert fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.values.mockRejectedValue(new Error("db down"));

		await expect(
			recordDeploymentCancelAudit({
				organizationId: "org-1",
				action: "clean_queue",
				actor: { type: "user", userId: "user-1" },
				targetType: "application",
			}),
		).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalledTimes(1);
		logged.mockRestore();
	});

	it("never throws when the insert itself throws synchronously", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.insert.mockImplementation(() => {
			throw new Error("no connection");
		});

		await expect(
			recordDeploymentCancelAudit({
				organizationId: "org-1",
				action: "clean_queue",
				actor: { type: "user", userId: "user-1" },
				targetType: "application",
			}),
		).resolves.toBeUndefined();
		logged.mockRestore();
	});
});

describe("listDeploymentCancelAudit", () => {
	it("returns a page of entries with the total", async () => {
		mocks.findMany.mockResolvedValue([{ deploymentCancelAuditId: "e1" }]);
		mocks.count.mockResolvedValue(7);

		const out = await listDeploymentCancelAudit({
			organizationId: "org-1",
			targetId: "a1",
			limit: 5,
			offset: 10,
		});

		expect(out).toEqual({
			logs: [{ deploymentCancelAuditId: "e1" }],
			total: 7,
		});
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 5, offset: 10 }),
		);
	});
});
