import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Service-level behaviour of the Snapvisor integration: looking up (never
 * creating — see the docstring on `registerPreviewDeployment`) the Snapvisor
 * build for a preview deployment's latest commit, and storing the result.
 * Application and compose previews go through the same code.
 * Snapvisor itself is faked at the `fetch` boundary so the real REST client
 * runs.
 */

const mocks = vi.hoisted(() => ({
	deploymentFindFirst: vi.fn(),
	integrationFindFirst: vi.fn(async () => undefined as unknown),
	composeFindFirst: vi.fn(),
	getGitCommitInfo: vi.fn(),
	updateDeployment: vi.fn(async () => [{}]),
	findApplicationById: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	updatePreviewDeployment: vi.fn(async () => [{}]),
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) => {
					if (table === "deployments") {
						return { findFirst: mocks.deploymentFindFirst, findMany: vi.fn() };
					}
					if (table === "compose") {
						return { findFirst: mocks.composeFindFirst, findMany: vi.fn() };
					}
					if (table === "snapvisorIntegration") {
						return {
							findFirst: mocks.integrationFindFirst,
							findMany: vi.fn(),
						};
					}
					return tableMock();
				},
			}),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/providers/git", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/providers/git")
	>()),
	getGitCommitInfo: mocks.getGitCommitInfo,
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/deployment")
	>()),
	updateDeployment: mocks.updateDeployment,
}));

vi.mock("@dokploy/server/services/application", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/application")
	>()),
	findApplicationById: mocks.findApplicationById,
}));

vi.mock(
	"@dokploy/server/services/preview-deployment",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/services/preview-deployment")
		>()),
		findPreviewDeploymentById: mocks.findPreviewDeploymentById,
		updatePreviewDeployment: mocks.updatePreviewDeployment,
	}),
);

const {
	finalizePreviewBuildMetadata,
	findLatestPreviewCommitSha,
	refreshPreviewBuild,
	registerPreviewDeployment,
	snapvisorBuildReviewUrl,
} = await import("@dokploy/server/services/snapvisor");

const ORG = "org-1";
const PREVIEW_ID = "preview-1";
// Snapvisor's `headSha` filter matches on the full SHA1: 40 hex characters.
const FULL_SHA = "abc1234defabc1234defabc1234defabc1234def";

const application = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	name: "web-app",
	snapvisorProjectName: "web",
	environment: { project: { organizationId: ORG } },
	...overrides,
});

// The narrow row `findComposeSnapvisorTarget` selects (not a full compose).
const composeRow = (overrides: Record<string, unknown> = {}) => ({
	composeId: "compose-1",
	name: "stack",
	snapvisorProjectName: "stack-web",
	environment: { project: { organizationId: ORG } },
	...overrides,
});

const composePreview = () => ({
	previewDeploymentId: PREVIEW_ID,
	applicationId: null,
	composeId: "compose-1",
});

const buildResponse = (project: string) => ({
	results: [
		{
			id: "build-9",
			number: 9,
			head: { sha: FULL_SHA, branch: "feature" },
			base: null,
			status: "no-changes",
			stats: null,
			url: `https://app.snapvisor.io/my-team/${project}/builds/9`,
		},
	],
	pageInfo: { total: 1, page: 1, perPage: 1 },
});

let toolCalls: { url: string }[] = [];
let responder: (url: string) => unknown = () => ({
	results: [],
	pageInfo: { total: 0, page: 1, perPage: 10 },
});

const installFetch = () => {
	toolCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			toolCalls.push({ url });
			return Response.json(responder(url));
		}),
	);
};

const integrationRow = {
	snapvisorId: "sv-1",
	organizationId: ORG,
	name: "Snapvisor",
	accessToken: "token-abc",
	accountSlug: "my-team",
	baseUrl: "https://api.snapvisor.io",
	createdAt: new Date(),
};

beforeEach(() => {
	vi.clearAllMocks();
	installFetch();
	mocks.findPreviewDeploymentById.mockResolvedValue({
		previewDeploymentId: PREVIEW_ID,
		applicationId: "app-1",
		composeId: null,
	});
	mocks.composeFindFirst.mockResolvedValue(composeRow());
	mocks.getGitCommitInfo.mockResolvedValue({
		hash: FULL_SHA,
		message: "feat: change the page",
	});
	mocks.findApplicationById.mockResolvedValue(application());
	mocks.deploymentFindFirst.mockResolvedValue({
		description: `Commit: ${FULL_SHA}`,
		createdAt: new Date().toISOString(),
	});
	mocks.integrationFindFirst.mockResolvedValue(integrationRow);
});

describe("registerPreviewDeployment", () => {
	it("looks up the Snapvisor build for the deployed commit and stores it", async () => {
		responder = (url) => {
			expect(url).toContain("/v2/projects/my-team/web/builds");
			expect(url).toContain(`headSha=${FULL_SHA}`);
			return {
				results: [
					{
						id: "build-1",
						number: 42,
						head: { sha: FULL_SHA, branch: "feature" },
						base: null,
						status: "changes-detected",
						stats: null,
						url: "https://app.snapvisor.io/my-team/web/builds/42",
					},
				],
				pageInfo: { total: 1, page: 1, perPage: 1 },
			};
		};

		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});

		expect(toolCalls[0]?.url.startsWith("https://api.snapvisor.io/v2/")).toBe(
			true,
		);
		expect(result.registered).toBe(true);
		expect(result.build?.id).toBe("build-1");
		expect(mocks.updatePreviewDeployment).toHaveBeenCalledWith(PREVIEW_ID, {
			snapvisorDeploymentId: "build-1",
			snapvisorBuildId: "42",
			snapvisorBuildStatus: "changes-detected",
		});
	});

	it("is skipped when the application has no Snapvisor project configured", async () => {
		mocks.findApplicationById.mockResolvedValue(
			application({ snapvisorProjectName: null }),
		);
		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "Visual testing is off",
		});
		expect(toolCalls).toHaveLength(0);
		expect(mocks.updatePreviewDeployment).not.toHaveBeenCalled();
	});

	it("is skipped for a preview that belongs to no service", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue({
			previewDeploymentId: PREVIEW_ID,
			applicationId: null,
			composeId: null,
		});
		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "Not a service preview",
		});
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
		expect(mocks.composeFindFirst).not.toHaveBeenCalled();
		expect(toolCalls).toHaveLength(0);
	});

	it("is skipped when no commit sha has been recorded yet", async () => {
		mocks.deploymentFindFirst.mockResolvedValue(undefined);

		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "No commit sha recorded yet",
		});
		expect(toolCalls).toHaveLength(0);
	});
});

describe("registerPreviewDeployment for a compose preview", () => {
	beforeEach(() => {
		mocks.findPreviewDeploymentById.mockResolvedValue(composePreview());
	});

	it("looks up the build for the head sha in the compose service's project and stores it", async () => {
		responder = (url) => {
			expect(url).toContain("/v2/projects/my-team/stack-web/builds");
			expect(url).toContain(`headSha=${FULL_SHA}`);
			return buildResponse("stack-web");
		};

		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});

		expect(toolCalls).toHaveLength(1);
		expect(result.registered).toBe(true);
		expect(mocks.updatePreviewDeployment).toHaveBeenCalledWith(PREVIEW_ID, {
			snapvisorDeploymentId: "build-9",
			snapvisorBuildId: "9",
			snapvisorBuildStatus: "no-changes",
		});
		// The application finder is not involved for a compose preview.
		expect(mocks.findApplicationById).not.toHaveBeenCalled();
	});

	it("reads the deployment of the compose preview for the sha", async () => {
		responder = () => buildResponse("stack-web");
		await registerPreviewDeployment({ previewDeploymentId: PREVIEW_ID });
		expect(mocks.deploymentFindFirst).toHaveBeenCalledTimes(1);
	});

	it("is skipped when the compose service has no Snapvisor project", async () => {
		mocks.composeFindFirst.mockResolvedValue(
			composeRow({ snapvisorProjectName: null }),
		);
		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "Visual testing is off",
		});
		expect(toolCalls).toHaveLength(0);
		expect(mocks.updatePreviewDeployment).not.toHaveBeenCalled();
	});

	it("is skipped when Snapvisor is not connected", async () => {
		mocks.integrationFindFirst.mockResolvedValue(undefined);
		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "Snapvisor is not connected",
		});
		expect(toolCalls).toHaveLength(0);
	});

	it("is skipped when no commit sha has been recorded yet", async () => {
		mocks.deploymentFindFirst.mockResolvedValue(undefined);
		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "No commit sha recorded yet",
		});
		expect(toolCalls).toHaveLength(0);
	});

	it("reports a missing build without storing anything", async () => {
		responder = () => ({
			results: [],
			pageInfo: { total: 0, page: 1, perPage: 1 },
		});
		const result = await registerPreviewDeployment({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result).toEqual({
			registered: false,
			reason: "No Snapvisor build for this commit yet",
		});
		expect(mocks.updatePreviewDeployment).not.toHaveBeenCalled();
	});

	it("refresh re-runs the same lookup and updates the stored status", async () => {
		responder = () => buildResponse("stack-web");
		const result = await refreshPreviewBuild({
			previewDeploymentId: PREVIEW_ID,
		});
		expect(result.registered).toBe(true);
		expect(mocks.updatePreviewDeployment).toHaveBeenCalledWith(PREVIEW_ID, {
			snapvisorDeploymentId: "build-9",
			snapvisorBuildId: "9",
			snapvisorBuildStatus: "no-changes",
		});
	});

	it("fails with NOT_FOUND when the compose service is gone", async () => {
		mocks.composeFindFirst.mockResolvedValue(undefined);
		await expect(
			registerPreviewDeployment({ previewDeploymentId: PREVIEW_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("finalizePreviewBuildMetadata", () => {
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("writes the Commit marker for a compose preview and links the build", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(composePreview());
		responder = () => buildResponse("stack-web");

		await finalizePreviewBuildMetadata({
			type: "compose",
			hasGitSource: true,
			previewDeploymentId: PREVIEW_ID,
			appName: "preview-stack-abc123",
			deploymentId: "deployment-1",
			serverId: "server-1",
		});
		await flush();

		expect(mocks.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "preview-stack-abc123",
			type: "compose",
			serverId: "server-1",
		});
		expect(mocks.updateDeployment).toHaveBeenCalledWith("deployment-1", {
			title: "feat: change the page",
			description: `Commit: ${FULL_SHA}`,
		});
		// The marker is exactly what findLatestPreviewCommitSha reads back.
		const [, written] = mocks.updateDeployment.mock.calls[0] as unknown as [
			string,
			{ description: string },
		];
		mocks.deploymentFindFirst.mockResolvedValue({
			description: written.description,
			createdAt: new Date().toISOString(),
		});
		await expect(findLatestPreviewCommitSha(PREVIEW_ID)).resolves.toBe(
			FULL_SHA,
		);
		expect(mocks.updatePreviewDeployment).toHaveBeenCalledWith(PREVIEW_ID, {
			snapvisorDeploymentId: "build-9",
			snapvisorBuildId: "9",
			snapvisorBuildStatus: "no-changes",
		});
	});

	it("reads the commit from the application checkout for an application preview", async () => {
		responder = () => buildResponse("web");
		await finalizePreviewBuildMetadata({
			type: "application",
			hasGitSource: true,
			previewDeploymentId: PREVIEW_ID,
			appName: "preview-web-abc123",
			deploymentId: "deployment-1",
			serverId: null,
		});
		await flush();
		expect(mocks.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "preview-web-abc123",
			type: "application",
			serverId: null,
		});
	});

	it("skips the commit marker for a build without a git checkout", async () => {
		await finalizePreviewBuildMetadata({
			type: "application",
			hasGitSource: false,
			previewDeploymentId: PREVIEW_ID,
			appName: "preview-web-abc123",
			deploymentId: "deployment-1",
			serverId: null,
		});
		await flush();
		expect(mocks.getGitCommitInfo).not.toHaveBeenCalled();
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("does not write a marker when the commit cannot be read", async () => {
		mocks.getGitCommitInfo.mockResolvedValue(null);
		await finalizePreviewBuildMetadata({
			type: "compose",
			hasGitSource: true,
			previewDeploymentId: PREVIEW_ID,
			appName: "preview-stack-abc123",
			deploymentId: "deployment-1",
			serverId: null,
		});
		await flush();
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("never fails the deploy when the Snapvisor link-up throws", async () => {
		mocks.findPreviewDeploymentById.mockRejectedValue(new Error("db down"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await expect(
			finalizePreviewBuildMetadata({
				type: "compose",
				hasGitSource: true,
				previewDeploymentId: PREVIEW_ID,
				appName: "preview-stack-abc123",
				deploymentId: "deployment-1",
				serverId: null,
			}),
		).resolves.toBeUndefined();
		await flush();
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});
});

describe("findLatestPreviewCommitSha", () => {
	const FULL_SHA_2 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

	it("extracts the sha from the `Commit: <sha>` marker", async () => {
		mocks.deploymentFindFirst.mockResolvedValue({
			description: `Commit: ${FULL_SHA_2}`,
			createdAt: new Date().toISOString(),
		});
		await expect(findLatestPreviewCommitSha(PREVIEW_ID)).resolves.toBe(
			FULL_SHA_2,
		);
	});

	it("returns null when there is no deployment or no marker", async () => {
		mocks.deploymentFindFirst.mockResolvedValue(undefined);
		await expect(findLatestPreviewCommitSha(PREVIEW_ID)).resolves.toBeNull();

		mocks.deploymentFindFirst.mockResolvedValue({
			description: "Manual redeploy",
			createdAt: new Date().toISOString(),
		});
		await expect(findLatestPreviewCommitSha(PREVIEW_ID)).resolves.toBeNull();
	});

	it("rejects an abbreviated sha (Snapvisor's headSha filter needs the full 40 characters)", async () => {
		mocks.deploymentFindFirst.mockResolvedValue({
			description: "Commit: abc1234",
			createdAt: new Date().toISOString(),
		});
		await expect(findLatestPreviewCommitSha(PREVIEW_ID)).resolves.toBeNull();
	});
});

describe("legacy app.snapvisor.io base URL", () => {
	it("still calls the API host for an integration saved with the old default", async () => {
		mocks.integrationFindFirst.mockResolvedValue({
			...integrationRow,
			baseUrl: "https://app.snapvisor.io/",
		});
		await registerPreviewDeployment({ previewDeploymentId: PREVIEW_ID });
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.url.startsWith("https://api.snapvisor.io/v2/")).toBe(
			true,
		);
	});
});

describe("snapvisorBuildReviewUrl", () => {
	it("builds web links on the web host for the API default and the legacy value", () => {
		for (const baseUrl of [
			"https://api.snapvisor.io",
			"https://app.snapvisor.io/",
		]) {
			expect(
				snapvisorBuildReviewUrl({ baseUrl, accountSlug: "my-team" }, "web", 42),
			).toBe("https://app.snapvisor.io/my-team/web/builds/42");
		}
	});

	it("uses a custom host as-is", () => {
		expect(
			snapvisorBuildReviewUrl(
				{ baseUrl: "https://sv.example/", accountSlug: "t" },
				"p",
				"7",
			),
		).toBe("https://sv.example/t/p/builds/7");
	});
});
