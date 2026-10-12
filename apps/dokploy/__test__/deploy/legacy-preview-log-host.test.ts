import { quote } from "shell-quote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Preview deployments written before `buildServerId` was recorded have no
 * build server on the row. Their log is on whichever host built them, and the
 * owner may have gained or lost a build server since, so the readers probe the
 * candidate hosts for the file. Every other row reads from one host, directly.
 * deployment.readLogs and deployment.logHost (the log drawer) share the answer.
 */

const mocks = vi.hoisted(() => ({
	deployment: null as Record<string, unknown> | null,
	// Hosts (null = this host) that hold the log file.
	filesOn: new Set<string | null>(),
	// Hosts whose probe never answers.
	hanging: new Set<string>(),
	isCloud: false,
	findPreviewDeploymentById: vi.fn(),
	findPreviewDeploymentLogOwner: vi.fn(),
	findServerById: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: new Proxy({}, { get: () => ({ findFirst: vi.fn() }) }) },
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
		findPreviewDeploymentLogOwner: mocks.findPreviewDeploymentLogOwner,
	}),
);

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get IS_CLOUD() {
		return mocks.isCloud;
	},
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: mocks.findServerById,
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkServicePermissionAndAccess: mocks.checkServicePermissionAndAccess,
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "owner@test.com", role: "owner" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

const logPath = "/etc/dokploy/logs/web-pr-4/web-pr-4-2026-10-12:12:00:00.log";
const probe = `test -f ${quote([logPath])}`;

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

// The owner as it is configured now.
const ownedBy = (
	application: Record<string, unknown> | null,
	compose: Record<string, unknown> | null = null,
) => ({ previewDeploymentId: "preview-1", application, compose });

const probedHosts = () => [
	...mocks.execAsyncRemote.mock.calls
		.filter(([, command]) => command === probe)
		.map(([host]) => host as string),
	...mocks.execAsync.mock.calls
		.filter(([command]) => command === probe)
		.map(() => null),
];
const tailedHosts = () =>
	mocks.execAsyncRemote.mock.calls
		.filter(([, command]) => command !== probe)
		.map(([host]) => host as string);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.filesOn = new Set();
	mocks.hanging = new Set();
	mocks.isCloud = false;
	mocks.checkServicePermissionAndAccess.mockResolvedValue(undefined);
	mocks.findPreviewDeploymentById.mockResolvedValue({
		previewDeploymentId: "preview-1",
		applicationId: "app-1",
		composeId: null,
	});
	mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
		ownedBy({ serverId: "server-1", buildServerId: "build-1" }),
	);
	mocks.findServerById.mockImplementation(async (serverId: string) => ({
		serverId,
		organizationId: serverId.startsWith("foreign") ? "org-2" : "org-1",
	}));
	mocks.execAsyncRemote.mockImplementation(
		async (host: string, command: string) => {
			if (command === probe) {
				if (mocks.hanging.has(host)) return new Promise(() => {});
				if (mocks.filesOn.has(host)) return { stdout: "", stderr: "" };
				throw new Error("not found");
			}
			return { stdout: `built on ${host}\n`, stderr: "" };
		},
	);
	mocks.execAsync.mockImplementation(async (command: string) => {
		if (command === probe) {
			if (mocks.filesOn.has(null)) return { stdout: "", stderr: "" };
			throw new Error("not found");
		}
		return { stdout: "local\n", stderr: "" };
	});
});

describe("deployment.readLogs for a legacy preview deployment", () => {
	it("reads from the owner's current host when it has the file", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.filesOn.add("build-1");

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("built on build-1\n");
		expect(probedHosts()).toEqual(expect.arrayContaining(["build-1"]));
		expect(tailedHosts()).toEqual(["build-1"]);
	});

	it("reads the app's server when the owner gained a build server after the preview ran", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.filesOn.add("server-1");

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("built on server-1\n");
		expect(probedHosts()).toEqual(expect.arrayContaining(["build-1", "server-1"]));
		expect(tailedHosts()).toEqual(["server-1"]);
	});

	it("reads the owner's server when the owner has since lost its build server", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
			ownedBy({ serverId: "server-2", buildServerId: null }),
		);
		mocks.filesOn.add("server-2");

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(tailedHosts()).toEqual(["server-2"]);
	});

	it("reads a compose preview from the compose server", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
			ownedBy(null, { serverId: "server-3" }),
		);
		mocks.filesOn.add("server-3");

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(tailedHosts()).toEqual(["server-3"]);
	});

	it("reads locally when only this host has the file", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
			ownedBy({ serverId: null, buildServerId: null }),
		);
		mocks.filesOn.add(null);

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("local\n");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("falls back to the host that runs it when no candidate has the file", async () => {
		mocks.deployment = legacyPreviewRow();

		const out = await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(out).toBe("built on server-1\n");
		expect(tailedHosts()).toEqual(["server-1"]);
	});

	it("still finds the file when the owner cannot be looked up", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.findPreviewDeploymentLogOwner.mockRejectedValue(new Error("gone"));
		mocks.filesOn.add("server-1");

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(probedHosts()).toEqual(expect.arrayContaining(["server-1"]));
		expect(tailedHosts()).toEqual(["server-1"]);
	});

	it("never contacts a candidate that belongs to another organization", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
			ownedBy({ serverId: "server-1", buildServerId: "foreign-build" }),
		);
		mocks.filesOn.add("foreign-build").add("server-1");

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsyncRemote.mock.calls.map(([host]) => host)).not.toContain(
			"foreign-build",
		);
		expect(tailedHosts()).toEqual(["server-1"]);
	});

	it("refuses to read from a foreign fallback host", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: "foreign-server" });

		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(tailedHosts()).toEqual([]);
	});
});

describe("probe timeouts and cloud", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not wait on a hanging candidate: the next one wins after the timeout", async () => {
		vi.useFakeTimers();
		mocks.deployment = legacyPreviewRow();
		mocks.hanging.add("build-1");
		mocks.filesOn.add("server-1");

		const pending = caller().readLogs({ deploymentId: "dep-1", tail: 10 });
		await vi.advanceTimersByTimeAsync(5000);

		await expect(pending).resolves.toBe("built on server-1\n");
		// Both were probed together, not one after the other.
		expect(probedHosts()).toEqual(expect.arrayContaining(["build-1", "server-1"]));
	});

	it("answers at once when the first candidate has the file, though a later one hangs", async () => {
		vi.useFakeTimers();
		mocks.deployment = legacyPreviewRow();
		mocks.hanging.add("server-1");
		mocks.filesOn.add("build-1");

		const pending = caller().readLogs({ deploymentId: "dep-1", tail: 10 });
		await vi.advanceTimersByTimeAsync(5000);

		await expect(pending).resolves.toBe("built on build-1\n");
	});

	it("keeps the owner's host first when several hosts have the file", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.filesOn.add("build-1").add("server-1").add(null);

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(tailedHosts()).toEqual(["build-1"]);
	});

	it("falls back when every candidate hangs", async () => {
		vi.useFakeTimers();
		mocks.deployment = legacyPreviewRow();
		mocks.hanging.add("build-1").add("server-1");

		const pending = caller().readLogs({ deploymentId: "dep-1", tail: 10 });
		await vi.advanceTimersByTimeAsync(5000);

		await expect(pending).resolves.toBe("built on server-1\n");
	});

	it("never probes this host in the cloud, whichever source named it", async () => {
		mocks.isCloud = true;
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
			ownedBy({ serverId: null, buildServerId: null }),
		);
		mocks.filesOn.add(null).add("server-2");
		mocks.deployment.application = { applicationId: "app-1", serverId: "server-2" };

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(tailedHosts()).toEqual(["server-2"]);
	});
});

describe("rows that are not legacy previews", () => {
	it("reads a recorded build server directly, with no probe or owner lookup", async () => {
		mocks.deployment = legacyPreviewRow({ buildServerId: "build-9" });

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(tailedHosts()).toEqual(["build-9"]);
		expect(probedHosts()).toEqual([]);
		expect(mocks.findPreviewDeploymentLogOwner).not.toHaveBeenCalled();
	});

	it("reads a non-preview row from its serving host, with no probe", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			previewDeploymentId: null,
			logPath,
			serverId: null,
			buildServerId: null,
			application: { applicationId: "app-1", serverId: "server-1" },
			compose: null,
			schedule: null,
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		expect(tailedHosts()).toEqual(["server-1"]);
		expect(probedHosts()).toEqual([]);
		expect(mocks.findPreviewDeploymentLogOwner).not.toHaveBeenCalled();
	});

	it("refuses a recorded build server that belongs to another organization", async () => {
		mocks.deployment = legacyPreviewRow({ buildServerId: "foreign-build" });

		await expect(
			caller().readLogs({ deploymentId: "dep-1", tail: 10 }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});

describe("deployment.logHost", () => {
	it("answers with the host readLogs reads from", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.filesOn.add("server-1");

		await expect(caller().logHost({ deploymentId: "dep-1" })).resolves.toEqual({
			serverId: "server-1",
		});
	});

	it("answers null for a log on this host", async () => {
		mocks.deployment = legacyPreviewRow({ serverId: null });
		mocks.findPreviewDeploymentLogOwner.mockResolvedValue(
			ownedBy({ serverId: null, buildServerId: null }),
		);
		mocks.filesOn.add(null);

		await expect(caller().logHost({ deploymentId: "dep-1" })).resolves.toEqual({
			serverId: null,
		});
	});

	it("answers the recorded build server without probing", async () => {
		mocks.deployment = legacyPreviewRow({ buildServerId: "build-9" });

		await expect(caller().logHost({ deploymentId: "dep-1" })).resolves.toEqual({
			serverId: "build-9",
		});
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("answers the old fallback when no candidate has the file", async () => {
		mocks.deployment = legacyPreviewRow();

		await expect(caller().logHost({ deploymentId: "dep-1" })).resolves.toEqual({
			serverId: "server-1",
		});
	});

	it("checks read access to the deployment before probing anything", async () => {
		mocks.deployment = legacyPreviewRow();
		mocks.checkServicePermissionAndAccess.mockRejectedValue(
			new Error("no access"),
		);

		await expect(caller().logHost({ deploymentId: "dep-1" })).rejects.toThrow(
			"no access",
		);
		expect(mocks.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"app-1",
			{ deployment: ["read"] },
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.findPreviewDeploymentLogOwner).not.toHaveBeenCalled();
	});
});
