import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	insertValues: vi.fn(),
	pdFindFirst: vi.fn(),
	orgFindFirst: vi.fn(),
	dbDelete: vi.fn(),
	findComposeById: vi.fn(),
	createDomain: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	removeDeploymentsByPreviewDeploymentId: vi.fn(),
	removeComposeDirectory: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: vi.fn(() => ({
			values: (values: unknown) => ({
				// Throwing inside the async body turns a synchronous mock throw
				// (e.g. the simulated 23505 unique violation) into a rejection,
				// matching the driver behavior the service handles.
				returning: async () => [mocks.insertValues(values)],
			}),
		})),
		update: vi.fn(() => ({
			set: () => ({
				where: () => ({ returning: async () => [{}] }),
			}),
		})),
		delete: mocks.dbDelete.mockImplementation(() => ({
			where: () => ({ returning: async () => [{}] }),
		})),
		query: {
			previewDeployments: {
				findFirst: mocks.pdFindFirst,
				findMany: vi.fn(async () => []),
			},
			organization: {
				findFirst: mocks.orgFindFirst,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/compose", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/compose")
	>()),
	findComposeById: mocks.findComposeById,
	runComposeBuild: vi.fn(),
}));

vi.mock("@dokploy/server/services/domain", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/services/domain")>()),
	createDomain: mocks.createDomain,
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/deployment")
	>()),
	removeDeploymentsByPreviewDeploymentId:
		mocks.removeDeploymentsByPreviewDeploymentId,
}));

vi.mock(
	"@dokploy/server/utils/filesystem/directory",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/utils/filesystem/directory")
		>()),
		removeComposeDirectory: mocks.removeComposeDirectory,
	}),
);

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

import {
	createComposePreview,
	removeComposePreview,
} from "@dokploy/server/services/preview-deployment";

const composeFixture = (overrides: Record<string, unknown> = {}) =>
	({
		composeId: "compose-1",
		name: "My Compose",
		appName: "myapp",
		sourceType: "git",
		github: null,
		owner: null,
		repository: null,
		serverId: null,
		server: null,
		suffix: "",
		randomize: false,
		composeType: "docker-compose",
		previewWildcard: "${appName}-pr${prNumber}.example.com",
		previewHttps: false,
		previewPath: "/",
		previewCertificateType: "none",
		previewCustomCertResolver: null,
		domains: [],
		environment: { project: { organizationId: "org-1" } },
		...overrides,
	}) as any;

const createInput = {
	composeId: "compose-1",
	branch: "feature-branch",
	pullRequestId: "pr-id-1",
	pullRequestNumber: "42",
	pullRequestTitle: "Add feature",
	pullRequestURL: "https://github.com/owner/repo/pull/42",
};

describe("createComposePreview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findComposeById.mockResolvedValue(composeFixture());
		mocks.insertValues.mockImplementation((values: any) => ({
			previewDeploymentId: "pd-1",
			...values,
		}));
	});

	it("creates the row with an isolated preview appName", async () => {
		const result = await createComposePreview(createInput);

		expect(result.previewDeploymentId).toBe("pd-1");
		expect(mocks.insertValues).toHaveBeenCalledTimes(1);
		const inserted = mocks.insertValues.mock.calls[0]?.[0];
		expect(inserted.composeId).toBe("compose-1");
		expect(inserted.branch).toBe("feature-branch");
		expect(inserted.pullRequestId).toBe("pr-id-1");
		expect(inserted.appName).toMatch(/^preview-myapp-/);
	});

	it("reuses the existing row on a unique violation instead of duplicating", async () => {
		mocks.insertValues.mockImplementation(() => {
			throw Object.assign(new Error("duplicate key"), { code: "23505" });
		});
		const existing = {
			previewDeploymentId: "existing-pd",
			composeId: "compose-1",
			pullRequestId: "pr-id-1",
		};
		mocks.pdFindFirst.mockResolvedValue(existing);

		const result = await createComposePreview(createInput);

		expect(result).toBe(existing);
		// The reuse path returns before templating any new domains.
		expect(mocks.createDomain).not.toHaveBeenCalled();
	});

	it("clones the compose domains into per-service preview domains with distinct hosts", async () => {
		mocks.findComposeById.mockResolvedValue(
			composeFixture({
				domains: [
					{
						serviceName: "web",
						port: 8080,
						path: "/",
						internalPath: null,
						stripPath: false,
					},
					{
						serviceName: "api",
						port: 3000,
						path: "/",
						internalPath: null,
						stripPath: false,
					},
				],
			}),
		);

		await createComposePreview(createInput);

		expect(mocks.createDomain).toHaveBeenCalledTimes(2);
		const created = mocks.createDomain.mock.calls.map((call) => call[0]);
		const hosts = created.map((domain) => domain.host);
		expect(hosts).toEqual([
			"myapp-web-pr42.example.com",
			"myapp-api-pr42.example.com",
		]);
		expect(new Set(hosts).size).toBe(2);
		for (const domain of created) {
			expect(domain.domainType).toBe("preview");
			expect(domain.composeId).toBe("compose-1");
			expect(domain.previewDeploymentId).toBe("pd-1");
		}
		expect(created[0]?.serviceName).toBe("web");
		expect(created[1]?.serviceName).toBe("api");
	});
});

describe("removeComposePreview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.pdFindFirst.mockResolvedValue({
			previewDeploymentId: "pd-1",
			composeId: "compose-1",
			appName: "preview-myapp-abc123",
			pullRequestId: "pr-id-1",
			domain: null,
			domains: [],
			application: null,
			compose: { composeId: "compose-1", serverId: null },
		});
		mocks.findComposeById.mockResolvedValue(composeFixture());
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	});

	it("tears down the stack with volumes, removes the network and deletes the row", async () => {
		await removeComposePreview("pd-1");

		const commands = mocks.execAsync.mock.calls.map((call) => call[0]);
		expect(
			commands.some((command) =>
				command.includes(
					"docker compose -p preview-myapp-abc123 down --volumes",
				),
			),
		).toBe(true);
		expect(
			commands.some((command) =>
				command.includes("docker network rm preview-myapp-abc123"),
			),
		).toBe(true);
		expect(mocks.removeDeploymentsByPreviewDeploymentId).toHaveBeenCalled();
		expect(mocks.removeComposeDirectory).toHaveBeenCalledWith(
			"preview-myapp-abc123",
			null,
		);
		expect(mocks.dbDelete).toHaveBeenCalled();
	});

	it("uses docker stack rm for stack composes", async () => {
		mocks.findComposeById.mockResolvedValue(
			composeFixture({ composeType: "stack" }),
		);

		await removeComposePreview("pd-1");

		const commands = mocks.execAsync.mock.calls.map((call) => call[0]);
		expect(
			commands.some((command) =>
				command.includes("docker stack rm preview-myapp-abc123"),
			),
		).toBe(true);
	});
});
