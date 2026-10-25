import { beforeEach, describe, expect, it, vi } from "vitest";

// The installation id GitHub sends back is only stored when GitHub confirms,
// with the app's own credentials, that it is an installation of that app.

const mocks = vi.hoisted(() => ({
	request: vi.fn(),
	constructed: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		request = mocks.request;
		constructor(options: unknown) {
			mocks.constructed(options);
		}
	},
}));

const { verifyGithubInstallation } = await import(
	"@dokploy/server/utils/providers/github"
);

const app = {
	githubAppId: 7,
	githubPrivateKey: "pem",
	githubUrl: "https://github.com",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("verifyGithubInstallation", () => {
	it("accepts an installation of the provider's app", async () => {
		mocks.request.mockResolvedValue({ data: { id: 42, app_id: 7 } });

		await expect(verifyGithubInstallation(app, "42")).resolves.toEqual({
			ok: true,
		});
		expect(mocks.request).toHaveBeenCalledWith(
			"GET /app/installations/{installation_id}",
			{ installation_id: 42 },
		);
		// Authenticated as the app itself, on the provider's own instance.
		expect(mocks.constructed).toHaveBeenCalledWith(
			expect.objectContaining({
				auth: { appId: 7, privateKey: "pem" },
				baseUrl: "https://api.github.com",
			}),
		);
	});

	it("uses the Enterprise API host of the provider", async () => {
		mocks.request.mockResolvedValue({ data: { id: 42, app_id: 7 } });

		await verifyGithubInstallation(
			{ ...app, githubUrl: "https://github.corp.acme.com" },
			"42",
		);

		expect(mocks.constructed).toHaveBeenCalledWith(
			expect.objectContaining({
				baseUrl: "https://github.corp.acme.com/api/v3",
			}),
		);
	});

	it("refuses an installation that belongs to another app", async () => {
		mocks.request.mockResolvedValue({ data: { id: 42, app_id: 8 } });

		await expect(verifyGithubInstallation(app, "42")).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("refuses an installation GitHub does not know", async () => {
		mocks.request.mockRejectedValue(
			Object.assign(new Error("x"), { status: 404 }),
		);

		await expect(verifyGithubInstallation(app, "42")).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("reports GitHub errors as unavailable, not as a mismatch", async () => {
		mocks.request.mockRejectedValue(
			Object.assign(new Error("x"), { status: 502 }),
		);

		await expect(verifyGithubInstallation(app, "42")).resolves.toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it.each([
		"",
		"0",
		"-1",
		"1.5",
		"abc",
		"42/../../x",
		"1e3",
		"12345678901234567",
	])(
		"refuses the malformed installation id %j without asking GitHub",
		async (id) => {
			await expect(verifyGithubInstallation(app, id)).resolves.toEqual({
				ok: false,
				reason: "invalid",
			});
			expect(mocks.request).not.toHaveBeenCalled();
		},
	);

	it("cannot verify without the app's credentials", async () => {
		await expect(
			verifyGithubInstallation({ ...app, githubPrivateKey: null }, "42"),
		).resolves.toEqual({ ok: false, reason: "unavailable" });
		expect(mocks.request).not.toHaveBeenCalled();
	});
});
