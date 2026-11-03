import { describe, expect, it, vi } from "vitest";

/**
 * On Dokploy Cloud the run poller (and its 6 hour backstop) does not run, so a registered row would never end:
 * registration is refused there, before anything is read or written.
 */

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	IS_CLOUD: true,
}));
vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(),
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	removeLastTenDeployments: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-cancel", () => ({
	appendLogLine: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(),
}));

const { registerExternalBuild } = await import(
	"@dokploy/server/services/external-build"
);

describe("registerExternalBuild on Dokploy Cloud", () => {
	it("is refused with a 400 before the service is even loaded", async () => {
		const loadTarget = vi.fn();
		await expect(
			registerExternalBuild(
				{
					applicationId: "app-1",
					buildOrigin: "github-actions",
					buildRunUrl: "https://github.com/acme/web/actions/runs/42",
					buildRunId: "42",
					buildRepository: "acme/web",
					buildCommitSha: "abcdef0123456789",
					title: "GHA production",
				},
				{ loadTarget } as never,
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("not available on Dokploy Cloud"),
		});
		expect(loadTarget).not.toHaveBeenCalled();
	});
});
