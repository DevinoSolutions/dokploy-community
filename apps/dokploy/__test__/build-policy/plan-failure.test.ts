import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding 3 of the PR #209 review.
 *
 * `NO_BUILD_SERVER` and `NO_REGISTRY` used to be thrown before the deployment
 * record existed, so a refused deploy produced nothing a team would ever see:
 * no deployment row, no error status, no build-failure notification. Spec §7
 * requires the notification, and the deployment list is where people look.
 */

const mocks = vi.hoisted(() => ({
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateApplicationStatus: vi.fn(),
	sendBuildErrorNotifications: vi.fn(),
	getDokployUrl: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: mocks.createDeployment,
	updateDeployment: vi.fn(),
	updateDeploymentStatus: mocks.updateDeploymentStatus,
	getDeploymentErrorMessage: vi.fn(),
}));

vi.mock("@dokploy/server/services/application", () => ({
	updateApplicationStatus: mocks.updateApplicationStatus,
	findApplicationById: vi.fn(),
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: mocks.getDokployUrl,
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: mocks.sendBuildErrorNotifications,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));

import { reportBuildPolicyPlanFailure } from "@dokploy/server/services/build-policy/apply";
import { BuildPolicyError } from "@dokploy/server/services/build-policy/errors";

const APPLICATION = (serverId: string | null = "deploy-server-1") => ({
	applicationId: "app-1",
	appName: "sendly-web",
	name: "Sendly Web",
	serverId,
	environment: {
		projectId: "project-1",
		project: { name: "Sendly", organizationId: "org-1" },
	},
});

const report = (application = APPLICATION()) =>
	reportBuildPolicyPlanFailure({
		application,
		titleLog: "Manual deployment",
		descriptionLog: "from the dashboard",
		error: new BuildPolicyError(
			"NO_BUILD_SERVER",
			"This organization enforces remote builds but has no build server configured.",
		),
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDeployment.mockResolvedValue({
		deploymentId: "deployment-1",
		logPath: "/var/log/deployment-1.log",
	});
	mocks.updateDeploymentStatus.mockResolvedValue({});
	mocks.updateApplicationStatus.mockResolvedValue({});
	mocks.sendBuildErrorNotifications.mockResolvedValue(undefined);
	mocks.getDokployUrl.mockResolvedValue("http://localhost:3000");
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("reportBuildPolicyPlanFailure", () => {
	it("creates the deployment record the refused deploy would have had", async () => {
		await report();
		expect(mocks.createDeployment).toHaveBeenCalledWith({
			applicationId: "app-1",
			title: "Manual deployment",
			description: "from the dashboard",
		});
	});

	it("marks the deployment and the application as errored", async () => {
		await report();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-1",
			"error",
		);
		expect(mocks.updateApplicationStatus).toHaveBeenCalledWith(
			"app-1",
			"error",
		);
	});

	it("sends one build-error notification carrying the reason", async () => {
		await report();
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
		expect(mocks.sendBuildErrorNotifications.mock.calls[0]?.[0]).toMatchObject({
			projectName: "Sendly",
			applicationName: "Sendly Web",
			applicationType: "application",
			organizationId: "org-1",
		});
		expect(
			String(
				mocks.sendBuildErrorNotifications.mock.calls[0]?.[0]?.errorMessage,
			),
		).toMatch(/build server/i);
	});

	it("appends the reason to the deployment log on the unit's own server", async () => {
		await report();
		expect(mocks.execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(String(mocks.execAsyncRemote.mock.calls[0]?.[0])).toBe(
			"deploy-server-1",
		);
		expect(String(mocks.execAsyncRemote.mock.calls[0]?.[1])).toContain(
			"/var/log/deployment-1.log",
		);
	});

	it("writes the log locally when the unit has no server", async () => {
		await report(APPLICATION(null));
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("never lets its own failure mask the policy error the caller rethrows", async () => {
		mocks.createDeployment.mockRejectedValue(new Error("db down"));
		await expect(report()).resolves.toBeUndefined();
	});

	it("still marks the error and notifies when the log write fails", async () => {
		// An unreachable build host is exactly when a refusal is likeliest, so the
		// best-effort log append must not cost the team the notification.
		mocks.execAsyncRemote.mockRejectedValue(new Error("ssh down"));
		await report();
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"deployment-1",
			"error",
		);
		expect(mocks.sendBuildErrorNotifications).toHaveBeenCalledTimes(1);
	});
});
