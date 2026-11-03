import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The router guard of GitHub Actions as a provider (T-13879): a connected service cannot be moved to another source by
 * a side door, and a service cannot be marked github-actions without Connect. The rules are tested in provider.test.ts;
 * this pins that the guard reads the service and its connection and turns a refusal into the right API error.
 */

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findGhaConnection: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
}));
vi.mock("@dokploy/server/services/gha-connect/store", () => ({
	findGhaConnection: mocks.findGhaConnection,
}));

const { assertRedeployable, assertSourceChangeAllowed } = await import(
	"@/server/api/utils/gha-provider-guard"
);

beforeEach(() => {
	vi.resetAllMocks();
});

const GHA = { sourceType: "github-actions" };

describe("assertSourceChangeAllowed", () => {
	it.each([
		["saveDockerProvider", "docker"],
		["saveGithubProvider", "github"],
		["saveGitProvider", "git"],
		["disconnectGitProvider", "github"],
		["update", "raw"],
	])(
		"refuses %s on a connected application with 'disconnect GitHub Actions first'",
		async (_route, next) => {
			mocks.findApplicationById.mockResolvedValue(GHA);
			mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
			await expect(
				assertSourceChangeAllowed({
					serviceType: "application",
					serviceId: "app-1",
					nextSourceType: next,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining("Disconnect GitHub Actions first"),
			});
			expect(mocks.findGhaConnection).toHaveBeenCalledWith(
				"application",
				"app-1",
			);
		},
	);

	it("refuses a connected compose stack the same way", async () => {
		mocks.findComposeById.mockResolvedValue(GHA);
		mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "compose",
				serviceId: "c-1",
				nextSourceType: "github",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
	});

	it("lets a full-record update send the same type back", async () => {
		mocks.findApplicationById.mockResolvedValue(GHA);
		mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "application",
				serviceId: "app-1",
				nextSourceType: "github-actions",
			}),
		).resolves.toBe(false);
	});

	it("lets the compose file editor send raw back, and says the source type is to be left out", async () => {
		mocks.findComposeById.mockResolvedValue(GHA);
		mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "compose",
				serviceId: "c-1",
				nextSourceType: "raw",
			}),
		).resolves.toBe(true);
	});

	it("refuses raw from a template or an import even for that stack (strict)", async () => {
		mocks.findComposeById.mockResolvedValue(GHA);
		mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "compose",
				serviceId: "c-1",
				nextSourceType: "raw",
				strict: true,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("refuses a zip drop on a connected application", async () => {
		mocks.findApplicationById.mockResolvedValue(GHA);
		mocks.findGhaConnection.mockResolvedValue({ ghaConnectionId: "gc-1" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "application",
				serviceId: "app-1",
				nextSourceType: "drop",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("does not read anything when the call sets no source type", async () => {
		await assertSourceChangeAllowed({
			serviceType: "application",
			serviceId: "app-1",
			nextSourceType: undefined,
		});
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
		expect(mocks.findGhaConnection).not.toHaveBeenCalled();
	});

	it("does not look for a connection on a service that is not on GitHub Actions", async () => {
		mocks.findApplicationById.mockResolvedValue({ sourceType: "github" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "application",
				serviceId: "app-1",
				nextSourceType: "docker",
			}),
		).resolves.toBe(false);
		expect(mocks.findGhaConnection).not.toHaveBeenCalled();
	});

	it("refuses to mark a service github-actions without Connect", async () => {
		mocks.findApplicationById.mockResolvedValue({ sourceType: "docker" });
		await expect(
			assertSourceChangeAllowed({
				serviceType: "application",
				serviceId: "app-1",
				nextSourceType: "github-actions",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("Connect GitHub Actions"),
		});
	});

	it("frees a service marked github-actions that has no connection (an orphan)", async () => {
		mocks.findApplicationById.mockResolvedValue(GHA);
		mocks.findGhaConnection.mockResolvedValue(null);
		await expect(
			assertSourceChangeAllowed({
				serviceType: "application",
				serviceId: "app-1",
				nextSourceType: "docker",
			}),
		).resolves.toBe(false);
	});

	it("leaves a missing service to the procedure's own lookup", async () => {
		mocks.findApplicationById.mockRejectedValue(new Error("not found"));
		await expect(
			assertSourceChangeAllowed({
				serviceType: "application",
				serviceId: "gone",
				nextSourceType: "docker",
			}),
		).resolves.toBe(false);
	});
});

describe("assertRedeployable", () => {
	it("names the branch to push to when there is no release yet", async () => {
		mocks.findGhaConnection.mockResolvedValue({ trackedBranch: "dev" });
		await expect(
			assertRedeployable(
				{ sourceType: "github-actions", dockerImage: null },
				"app-1",
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("push to dev"),
		});
	});

	it("lets a service with an image through, and ignores other sources without a lookup", async () => {
		mocks.findGhaConnection.mockResolvedValue({ trackedBranch: "dev" });
		await expect(
			assertRedeployable(
				{ sourceType: "github-actions", dockerImage: "ghcr.io/a/b@sha256:x" },
				"app-1",
			),
		).resolves.toBeUndefined();
		mocks.findGhaConnection.mockClear();
		await expect(
			assertRedeployable({ sourceType: "github", dockerImage: null }, "app-1"),
		).resolves.toBeUndefined();
		expect(mocks.findGhaConnection).not.toHaveBeenCalled();
	});
});
