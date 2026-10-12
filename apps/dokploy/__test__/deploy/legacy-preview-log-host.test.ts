import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Preview deployments written before `buildServerId` was recorded have no
 * build server on the row. Their log still lives on the owner's build server
 * (else the owner's server), so reads resolve it through the owner, and the
 * list endpoint hands the log drawer that host as `logServerId`.
 */

const mocks = vi.hoisted(() => ({
	deployment: null as Record<string, unknown> | null,
	listRows: [] as Array<Record<string, unknown>>,
	preview: null as Record<string, unknown> | null,
	findPreviewDeploymentById: vi.fn(),
	findServerById: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: { findMany: vi.fn(async () => mocks.listRows) },
		},
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findDeploymentById: vi.fn(async () => mocks.deployment),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock(
	"@dokploy/server/services/preview-deployment",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		findPreviewDeploymentById: mocks.findPreviewDeploymentById,
	}),
);

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: mocks.findServerById,
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkServicePermissionAndAccess: vi.fn(async () => {}),
	checkPermission: vi.fn(async () => {}),
}));

vi.mock("@/server/utils/deployment-all-by-type-target", () => ({
	resolveDeploymentAllByTypeAuthTarget: vi.fn(async () => ({
		kind: "service",
		serviceId: "preview-1",
	})),
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");
const { resolveDeploymentLogReadHost, withDeploymentLogServerId } =
	await import("@dokploy/server/services/deployment-log-host");

const caller = () =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "owner@test.com", role: "owner" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const logPath = "/etc/dokploy/logs/web-pr-4/web-pr-4-2026-10-12:12:00:00.log";

const legacyPreviewRow = (overrides: Record<string, unknown> = {}) => ({
	deploymentId: "dep-1",
	previewDeploymentId: "preview-1",
	logPath,
	serverId: "server-1",
	buildServerId: null,
	application: null,
	compose: null,
	schedule: null,
	...overrides,
});

const ownedBy = (
	application: Record<string, unknown> | null,
	compose: Record<string, unknown> | null = null,
) => ({
	previewDeploymentId: "preview-1",
	applicationId: application ? "app-1" : null,
	composeId: compose ? "compose-1" : null,
	application,
	compose,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.preview = ownedBy({
		applicationId: "app-1",
		serverId: "server-1",
		buildServerId: "build-1",
	});
	mocks.findPreviewDeploymentById.mockImplementation(async () => {
		if (!mocks.preview) throw new Error("Preview Deployment not found");
		return mocks.preview;
	});
	mocks.findServerById.mockImplementation(async (serverId: string) => ({
		serverId,
		organizationId: serverId.startsWith("foreign") ? "org-2" : "org-1",
	}));
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "built\n", stderr: "" });
	mocks.execAsync.mockResolvedValue({ stdout: "local\n", stderr: "" });
});

describe("deployment.readLogs for a legacy preview deployment", () => {
	it("reads the log from the owner's build server", async () => {
		mocks.deployment = legacyPreviewRow();

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("built\n");
		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("build-1");
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("falls back to the owner's server when it has no build server", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.preview = ownedBy({
			applicationId: "app-1",
			serverId: "server-2",
			buildServerId: null,
		});

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-2");
	});

	it("reads a compose preview from the compose server", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.preview = ownedBy(null, { composeId: "compose-1", serverId: "server-3" });

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-3");
	});

	it("reads locally when the owner has no server at all", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.preview = ownedBy({
			applicationId: "app-1",
			serverId: null,
			buildServerId: null,
		});

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("local\n");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("keeps the recorded build server without looking up the owner", async () => {
		mocks.deployment = legacyPreviewRow({ buildServerId: "build-9" });

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("build-9");
		// Only the access check reads the preview, not the host resolution.
		expect(mocks.findPreviewDeploymentById).toHaveBeenCalledTimes(1);
	});

	it("does not look up an owner for a non-preview row", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath,
			serverId: null,
			buildServerId: null,
			application: { applicationId: "app-1", serverId: "server-1" },
			compose: null,
			schedule: null,
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls[0]?.[0]).toBe("server-1");
		expect(mocks.findPreviewDeploymentById).not.toHaveBeenCalled();
	});

	it("refuses a log host that belongs to another organization", async () => {
		mocks.deployment = legacyPreviewRow({ buildServerId: "foreign-build" });

		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("refuses a foreign server resolved through the owner", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.preview = ownedBy({
			applicationId: "app-1",
			serverId: "server-1",
			buildServerId: "foreign-build",
		});

		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("deployment.allByType log host", () => {
	const listed = (rows: Array<Record<string, unknown>>) => {
		mocks.listRows = rows;
		return caller().allByType({ id: "preview-1", type: "previewDeployment" });
	};

	it("gives a legacy preview row its owner's build server as logServerId", async () => {
		const rows = await listed([
			{ deploymentId: "a", previewDeploymentId: "preview-1", buildServerId: null },
			{ deploymentId: "b", previewDeploymentId: "preview-1", buildServerId: null },
		]);

		expect(rows.map((r) => r.logServerId)).toEqual(["build-1", "build-1"]);
		// One owner lookup for the whole list, not one per row.
		expect(mocks.findPreviewDeploymentById).toHaveBeenCalledTimes(1);
	});

	it("uses the recorded build server of a new row without a lookup", async () => {
		const rows = await listed([
			{
				deploymentId: "a",
				previewDeploymentId: "preview-1",
				buildServerId: "build-7",
			},
		]);

		expect(rows[0]?.logServerId).toBe("build-7");
		expect(mocks.findPreviewDeploymentById).not.toHaveBeenCalled();
	});

	it("leaves non-preview rows to the host that serves the service", async () => {
		const rows = await listed([
			{
				deploymentId: "a",
				applicationId: "app-1",
				previewDeploymentId: null,
				buildServerId: null,
			},
			{
				deploymentId: "b",
				applicationId: "app-1",
				previewDeploymentId: null,
				buildServerId: "build-2",
			},
		]);

		expect(rows.map((r) => r.logServerId)).toEqual([null, "build-2"]);
		expect(mocks.findPreviewDeploymentById).not.toHaveBeenCalled();
	});

	it("leaves a row to the serving host when the owner cannot be found", async () => {
		mocks.preview = null;

		const rows = await listed([
			{ deploymentId: "a", previewDeploymentId: "preview-1", buildServerId: null },
		]);

		expect(rows[0]?.logServerId).toBeNull();
	});
});

describe("log host helpers", () => {
	it("resolveDeploymentLogReadHost keeps the caller's fallback for non-preview rows", async () => {
		const host = await resolveDeploymentLogReadHost(
			{ serverId: null, buildServerId: null, previewDeploymentId: null },
			"serving-host",
		);

		expect(host).toBe("serving-host");
	});

	it("resolveDeploymentLogReadHost falls back when the owner cannot be found", async () => {
		mocks.preview = null;

		const host = await resolveDeploymentLogReadHost(
			{ serverId: "server-1", buildServerId: null, previewDeploymentId: "preview-1" },
			"serving-host",
		);

		expect(host).toBe("serving-host");
	});

	it("withDeploymentLogServerId looks each preview owner up once", async () => {
		const rows = await withDeploymentLogServerId([
			{ previewDeploymentId: "p1", buildServerId: null },
			{ previewDeploymentId: "p1", buildServerId: null },
			{ previewDeploymentId: "p2", buildServerId: null },
		]);

		expect(rows.map((r) => r.logServerId)).toEqual([
			"build-1",
			"build-1",
			"build-1",
		]);
		expect(mocks.findPreviewDeploymentById).toHaveBeenCalledTimes(2);
	});
});
