import path from "node:path";
import { quote } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A deployment built on a build server writes its log there. Two things have to
 * follow that host: the row records it (`buildServerId`) so the readers know
 * where to look, and the old-log cleanup removes the file there, not on the
 * host that serves the app.
 */

const mocks = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	inserted: [] as Array<Record<string, unknown>>,
	deletedIds: [] as string[],
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	findPreviewDeploymentById: vi.fn(),
	removeRollbackById: vi.fn(),
}));

// The ids a drizzle `eq(...)` condition is bound to.
const paramsOf = (node: unknown): unknown[] => {
	if (!node || typeof node !== "object") return [];
	const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
	if (Array.isArray(chunks)) return chunks.flatMap(paramsOf);
	if (constructorName(node) === "Param") {
		return [(node as { value: unknown }).value];
	}
	return [];
};
const constructorName = (node: object) => node.constructor?.name;

vi.mock("@dokploy/server/db", () => ({
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
	db: {
		query: {
			deployments: { findMany: vi.fn(async () => mocks.rows) },
		},
		insert: () => ({
			values: (values: Record<string, unknown>) => ({
				returning: async () => {
					mocks.inserted.push(values);
					return [{ deploymentId: "new-deployment", ...values }];
				},
			}),
		}),
		delete: () => ({
			where: (condition: unknown) => {
				const [deploymentId] = paramsOf(condition) as string[];
				const row = mocks.rows.find((r) => r.deploymentId === deploymentId);
				if (deploymentId) mocks.deletedIds.push(deploymentId);
				return Object.assign(Promise.resolve([]), {
					returning: async () => (row ? [row] : []),
				});
			},
		}),
	},
}));

vi.mock("@dokploy/server/services/application", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findApplicationById: mocks.findApplicationById,
}));

vi.mock("@dokploy/server/services/compose", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findComposeById: mocks.findComposeById,
}));

vi.mock(
	"@dokploy/server/services/preview-deployment",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		findPreviewDeploymentById: mocks.findPreviewDeploymentById,
	}),
);

vi.mock("@dokploy/server/services/rollbacks", async (importOriginal) => ({
	...(await importOriginal<object>()),
	removeRollbackById: mocks.removeRollbackById,
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: vi.fn(async (serverId: string) => ({ serverId })),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const {
	createDeployment,
	createDeploymentCompose,
	createDeploymentPreview,
	removeDeployment,
} = await import("@dokploy/server/services/deployment");

const previewRow = (
	application: Record<string, unknown> | null,
	compose: Record<string, unknown> | null = null,
) => ({
	previewDeploymentId: "preview-1",
	appName: "web-preview-abc",
	application,
	compose,
});

const remoteCalls = () =>
	mocks.execAsyncRemote.mock.calls as Array<[string, string]>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows = [];
	mocks.inserted = [];
	mocks.deletedIds = [];
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.removeRollbackById.mockResolvedValue(undefined);
});

describe("createDeploymentPreview records the build server", () => {
	it("records the application's build server and keeps the serving host on the row", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(
			previewRow({
				applicationId: "app-1",
				serverId: "srv-1",
				buildServerId: "build-1",
			}),
		);

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(mocks.inserted).toHaveLength(1);
		expect(mocks.inserted[0]).toMatchObject({
			serverId: "srv-1",
			buildServerId: "build-1",
			previewDeploymentId: "preview-1",
		});
		// The log is created where the build will append to it.
		expect(remoteCalls()[0]?.[0]).toBe("build-1");
	});

	it("records a policy-forced build server the application does not carry", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(
			previewRow({
				applicationId: "app-1",
				serverId: "srv-1",
				buildServerId: null,
			}),
		);

		await createDeploymentPreview(
			{ previewDeploymentId: "preview-1", title: "t" } as never,
			{ buildServerId: "policy-build" },
		);

		expect(mocks.inserted[0]).toMatchObject({
			serverId: "srv-1",
			buildServerId: "policy-build",
		});
		expect(remoteCalls()[0]?.[0]).toBe("policy-build");
	});

	it("records a build server for a preview that is served locally", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(
			previewRow({
				applicationId: "app-1",
				serverId: null,
				buildServerId: "build-1",
			}),
		);

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(mocks.inserted[0]?.buildServerId).toBe("build-1");
		expect(mocks.inserted[0]?.serverId ?? null).toBeNull();
		expect(remoteCalls()[0]?.[0]).toBe("build-1");
	});

	it("does not record the serving host as a build server", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(
			previewRow({
				applicationId: "app-1",
				serverId: "srv-1",
				buildServerId: null,
			}),
		);

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(mocks.inserted[0]).toMatchObject({ serverId: "srv-1" });
		expect(mocks.inserted[0]).not.toHaveProperty("buildServerId");
		// Without a build server the log is still created on the serving host.
		expect(remoteCalls()[0]?.[0]).toBe("srv-1");
	});

	it("does not record a build server for a compose preview", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(
			previewRow(null, { composeId: "compose-1", serverId: "srv-c" }),
		);

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(mocks.inserted[0]).toMatchObject({ serverId: "srv-c" });
		expect(mocks.inserted[0]).not.toHaveProperty("buildServerId");
		expect(remoteCalls()[0]?.[0]).toBe("srv-c");
	});
});

// The code under test normalises log paths with path.join.
const logFile = (name: string) => path.join("/etc/dokploy/logs/web", name);

const row = (n: number, extra: Record<string, unknown>) => ({
	deploymentId: `dep-${n}`,
	logPath: logFile(`web-${n}.log`),
	rollbackId: null,
	errorMessage: null,
	serverId: null,
	buildServerId: null,
	previewDeploymentId: null,
	...extra,
});

// 10 recent rows are kept; everything after them is old.
const keptRows = () =>
	Array.from({ length: 10 }, (_, i) => row(i, { serverId: "srv-1" }));

const rmCalls = () =>
	remoteCalls().filter(([, command]) => command.includes("rm -rf"));

describe("old deployment cleanup", () => {
	beforeEach(() => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			appName: "web",
			serverId: "srv-1",
			buildServerId: null,
		});
	});

	const deploy = () =>
		createDeployment({ applicationId: "app-1", title: "Deploy" } as never);

	it("removes a build-server log on the build server and the rest on their own host", async () => {
		mocks.rows = [
			...keptRows(),
			row(20, { serverId: "srv-1", buildServerId: "build-1" }),
			row(21, { serverId: "srv-1" }),
			row(22, { serverId: "srv-2", buildServerId: "build-1" }),
		];

		await deploy();

		const byHost = new Map(rmCalls());
		expect(rmCalls()).toHaveLength(2);
		// One command per host, carrying every log that host holds.
		expect(byHost.get("build-1")).toContain(logFile("web-20.log"));
		expect(byHost.get("build-1")).toContain(logFile("web-22.log"));
		expect(byHost.get("build-1")).not.toContain("web-21.log");
		expect(byHost.get("srv-1")).toContain(logFile("web-21.log"));
		expect(byHost.get("srv-1")).not.toContain("web-20.log");
		expect(byHost.has("srv-2")).toBe(false);
		expect(mocks.deletedIds.sort()).toEqual(["dep-20", "dep-21", "dep-22"]);
	});

	it("cleans a local row locally", async () => {
		mocks.rows = [...keptRows(), row(30, { serverId: null })];

		await deploy();

		expect(rmCalls()).toHaveLength(0);
		expect(mocks.execAsync).toHaveBeenCalledWith(
			expect.stringContaining(`rm -f ${quote([logFile("web-30.log")])}`),
		);
		expect(mocks.deletedIds).toEqual(["dep-30"]);
	});

	it("quotes the log path", async () => {
		mocks.rows = [
			...keptRows(),
			row(40, {
				serverId: "srv-1",
				logPath: logFile("a b;touch x.log"),
			}),
		];

		await deploy();

		expect(rmCalls()[0]?.[1]).toContain(
			`rm -rf ${quote([logFile("a b;touch x.log")])};`,
		);
	});

	it("keeps cleaning the other hosts, and deploying, when one host fails", async () => {
		mocks.rows = [
			...keptRows(),
			row(50, { serverId: "srv-1", buildServerId: "build-down" }),
			row(51, { serverId: "srv-1" }),
			row(52, { serverId: "srv-1", buildServerId: "build-1" }),
			row(53, { serverId: null }),
		];
		mocks.execAsyncRemote.mockImplementation(async (serverId: string) => {
			if (serverId === "build-down") throw new Error("ssh: connection refused");
			return { stdout: "", stderr: "" };
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const created = await deploy();

		errorSpy.mockRestore();
		expect(created).toMatchObject({ deploymentId: "new-deployment" });
		const hosts = rmCalls().map(([host]) => host);
		expect(hosts).toEqual(
			expect.arrayContaining(["build-down", "srv-1", "build-1"]),
		);
		// Every row is gone, including the one whose host could not be reached.
		expect(mocks.deletedIds.sort()).toEqual([
			"dep-50",
			"dep-51",
			"dep-52",
			"dep-53",
		]);
		expect(mocks.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("web-53.log"),
		);
	});

	it("does not fail the deployment when the cleanup itself cannot run", async () => {
		const { db } = await import("@dokploy/server/db");
		vi.mocked(db.query.deployments.findMany).mockRejectedValueOnce(
			new Error("db down"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(deploy()).resolves.toMatchObject({
			deploymentId: "new-deployment",
		});

		errorSpy.mockRestore();
	});

	it("cleans a build-server preview's old logs on the build server", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(
			previewRow({
				applicationId: "app-1",
				serverId: "srv-1",
				buildServerId: "build-1",
			}),
		);
		mocks.rows = [
			...keptRows(),
			row(60, { serverId: "srv-1", buildServerId: "build-1" }),
		];

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(rmCalls()).toHaveLength(1);
		expect(rmCalls()[0]?.[0]).toBe("build-1");
	});

	it("cleans compose deployments on their own host", async () => {
		mocks.findComposeById.mockResolvedValue({
			composeId: "compose-1",
			appName: "stack",
			serverId: "srv-c",
		});
		mocks.rows = [...keptRows(), row(70, { serverId: "srv-c" })];

		await createDeploymentCompose({
			composeId: "compose-1",
			title: "t",
		} as never);

		expect(rmCalls()).toHaveLength(1);
		expect(rmCalls()[0]?.[0]).toBe("srv-c");
	});
});

describe("cleanup of preview rows that predate the recorded build server", () => {
	const legacy = (n: number, extra: Record<string, unknown> = {}) =>
		row(n, { serverId: "srv-1", previewDeploymentId: "preview-1", ...extra });
	const owner = previewRow({
		applicationId: "app-1",
		serverId: "srv-1",
		buildServerId: "build-1",
	});

	it("removes their logs on the preview owner's build server, looking the owner up once", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(owner);
		mocks.rows = [...keptRows(), legacy(90), legacy(91), legacy(92)];

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(rmCalls()).toHaveLength(1);
		expect(rmCalls()[0]?.[0]).toBe("build-1");
		expect(rmCalls()[0]?.[1]).toContain(logFile("web-90.log"));
		expect(rmCalls()[0]?.[1]).toContain(logFile("web-92.log"));
		// Once for the new deployment, once for all the old rows.
		expect(mocks.findPreviewDeploymentById).toHaveBeenCalledTimes(2);
		expect(mocks.deletedIds.sort()).toEqual(["dep-90", "dep-91", "dep-92"]);
	});

	it("falls back to the row's server when the preview owner cannot be read", async () => {
		mocks.findPreviewDeploymentById
			.mockResolvedValueOnce(owner)
			.mockRejectedValue(new Error("gone"));
		mocks.rows = [...keptRows(), legacy(93)];

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		expect(rmCalls().map(([host]) => host)).toEqual(["srv-1"]);
	});

	it("never deletes locally when it cannot tell where a remote log is", async () => {
		mocks.findPreviewDeploymentById
			.mockResolvedValueOnce(owner)
			.mockRejectedValue(new Error("gone"));
		mocks.rows = [...keptRows(), legacy(94, { serverId: null })];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await createDeploymentPreview({
			previewDeploymentId: "preview-1",
			title: "t",
		} as never);

		errorSpy.mockRestore();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(rmCalls()).toHaveLength(0);
		expect(mocks.deletedIds).toEqual(["dep-94"]);
	});

	it("removeDeployment deletes a legacy preview log on the build server", async () => {
		mocks.findPreviewDeploymentById.mockResolvedValue(owner);
		mocks.rows = [legacy(95)];

		await removeDeployment("dep-95");

		expect(remoteCalls()).toEqual([
			["build-1", `rm -f ${quote([logFile("web-95.log")])};`],
		]);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("removeDeployment", () => {
	it("removes a build-server log on the build server", async () => {
		mocks.rows = [row(80, { serverId: "srv-1", buildServerId: "build-1" })];

		await removeDeployment("dep-80");

		expect(remoteCalls()).toEqual([
			["build-1", `rm -f ${quote([logFile("web-80.log")])};`],
		]);
	});

	it("removes any other log on the host that serves it", async () => {
		mocks.rows = [row(81, { serverId: "srv-1" })];

		await removeDeployment("dep-81");

		expect(remoteCalls()).toEqual([
			["srv-1", `rm -f ${quote([logFile("web-81.log")])};`],
		]);
	});
});
