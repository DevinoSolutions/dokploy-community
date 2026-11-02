import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.registerExternalBuild / finishExternalBuild at the service level: the registration is checked against
 * its own run link, one run of one service is one row however often it is registered, a service Dokploy builds
 * itself is refused, and a row is only ended while it still waits for GitHub.
 */

const mocks = vi.hoisted(() => ({
	update: [] as Array<{ set: Record<string, unknown>; returned: unknown[] }>,
	returnQueue: [] as unknown[][],
	appendLogLine: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: () => ({
			set: (set: Record<string, unknown>) => ({
				where: () => ({
					returning: () => {
						const returned = mocks.returnQueue.shift() ?? [];
						mocks.update.push({ set, returned });
						return Promise.resolve(returned);
					},
				}),
			}),
		}),
	},
}));
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
	appendLogLine: mocks.appendLogLine,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(),
}));

const {
	externalBuildLogHeader,
	finishExternalBuild,
	registerExternalBuild,
	validateRegistration,
} = await import("@dokploy/server/services/external-build");
type RegisterDeps = Parameters<typeof registerExternalBuild>[1];
type Target = Awaited<ReturnType<NonNullable<RegisterDeps>["loadTarget"]>>;

const RUN = "https://github.com/acme/web/actions/runs/42";

const input = (overrides: Record<string, unknown> = {}) => ({
	applicationId: "app-1",
	buildOrigin: "github-actions" as const,
	buildRunUrl: RUN,
	buildRunId: "42",
	buildRepository: "acme/web",
	buildCommitSha: "ABCDEF0123456789abcdef0123456789abcdef01",
	title: "GHA production abcdef01: ship it",
	...overrides,
});

const target = (overrides: Partial<Target> = {}): Target => ({
	kind: "application",
	serviceId: "app-1",
	appName: "web-abc123",
	serverId: null,
	buildServerId: null,
	dokployBuilds: false,
	...overrides,
});

/** In-memory stand-ins for the database and the host. */
const makeDeps = (loaded: Target = target()) => {
	const rows: Array<{ deploymentId: string; buildRunUrl: string }> = [];
	const createLog = vi.fn(
		async (_target: Target, _header: string) => "/logs/web-abc123/web.log",
	);
	const deps: NonNullable<RegisterDeps> = {
		loadTarget: async () => loaded,
		findExisting: async (_target, buildRunUrl) =>
			rows.find((row) => row.buildRunUrl === buildRunUrl),
		createLog,
		insertRow: vi.fn(async (_target, row) => {
			const created = {
				deploymentId: `dep-${rows.length + 1}`,
				buildRunUrl: row.buildRunUrl,
			};
			// A real insert takes a moment: concurrent calls must still not both insert.
			await new Promise((resolve) => setTimeout(resolve, 5));
			rows.push(created);
			return created;
		}),
		prune: vi.fn(async () => {}),
		now: () => new Date("2026-11-02T10:00:00.000Z"),
	};
	return { deps, rows, createLog };
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.update.length = 0;
	mocks.returnQueue.length = 0;
});

describe("validateRegistration", () => {
	it("normalises the link, lower-cases the sha and trims the text", () => {
		const out = validateRegistration(
			input({
				buildRunUrl: `${RUN}/job/9?pr=1#step`,
				title: "  hello  ",
				description: " d ",
			}),
		);
		expect(out).toMatchObject({
			buildRunUrl: RUN,
			buildRunId: "42",
			buildRepository: "acme/web",
			buildCommitSha: "abcdef0123456789abcdef0123456789abcdef01",
			title: "hello",
			description: "d",
		});
	});

	it("keeps the attempt in the link, so a re-run is another registration", () => {
		expect(
			validateRegistration(input({ buildRunUrl: `${RUN}/attempts/2` }))
				.buildRunUrl,
		).toBe(`${RUN}/attempts/2`);
	});

	it.each([
		[
			"a link that is not a run",
			{ buildRunUrl: "https://github.com/acme/web" },
		],
		[
			"a link on another host",
			{ buildRunUrl: "https://evil.example/acme/web/actions/runs/42" },
		],
		["a repository that is not the link's", { buildRepository: "acme/other" }],
		["a run id that is not the link's", { buildRunId: "43" }],
		["a malformed repository", { buildRepository: "acme" }],
		["a sha that is not hex", { buildCommitSha: "not-a-sha" }],
		["an empty title", { title: "   " }],
	])("refuses %s", (_name, overrides) => {
		expect(() => validateRegistration(input(overrides))).toThrow();
	});

	it("accepts the repository in another letter case", () => {
		expect(() =>
			validateRegistration(input({ buildRepository: "Acme/Web" })),
		).not.toThrow();
	});
});

describe("registerExternalBuild", () => {
	it("creates a running row with the log header that names the run", async () => {
		const { deps, rows, createLog } = makeDeps();
		const result = await registerExternalBuild(input(), deps);

		expect(result).toEqual({ deploymentId: "dep-1", created: true });
		expect(rows).toHaveLength(1);
		expect(deps.prune).toHaveBeenCalledTimes(1);
		const header = createLog.mock.calls[0]?.[1] ?? "";
		expect(header).toContain("runs on GitHub Actions");
		expect(header).toContain(`Open the run: ${RUN}`);
		expect(header).toContain("abcdef01");
		const inserted = vi.mocked(deps.insertRow).mock.calls[0]?.[1];
		expect(inserted).toMatchObject({
			logPath: "/logs/web-abc123/web.log",
			startedAt: "2026-11-02T10:00:00.000Z",
			buildRunUrl: RUN,
			buildRunId: "42",
			buildRepository: "acme/web",
		});
	});

	it("returns the same row for the same service and run, and writes no second log", async () => {
		const { deps, rows, createLog } = makeDeps();
		const first = await registerExternalBuild(input(), deps);
		const second = await registerExternalBuild(
			input({ buildRunUrl: `${RUN}/job/7`, title: "retried step" }),
			deps,
		);

		expect(second).toEqual({
			deploymentId: first.deploymentId,
			created: false,
		});
		expect(rows).toHaveLength(1);
		expect(createLog).toHaveBeenCalledTimes(1);
	});

	it("does not insert twice when two calls arrive together", async () => {
		const { deps, rows } = makeDeps();
		const [a, b] = await Promise.all([
			registerExternalBuild(input(), deps),
			registerExternalBuild(input(), deps),
		]);
		expect(rows).toHaveLength(1);
		expect(a.deploymentId).toBe(b.deploymentId);
		expect([a.created, b.created].sort()).toEqual([false, true]);
	});

	it("makes another row for another attempt of the run", async () => {
		const { deps, rows } = makeDeps();
		const first = await registerExternalBuild(input(), deps);
		const rerun = await registerExternalBuild(
			input({ buildRunUrl: `${RUN}/attempts/2` }),
			deps,
		);
		expect(rerun.deploymentId).not.toBe(first.deploymentId);
		expect(rows).toHaveLength(2);
	});

	it("returns the row another process registered first (unique index) instead of failing", async () => {
		const { deps, rows } = makeDeps();
		const winner = { deploymentId: "dep-winner", buildRunUrl: RUN };
		let lookups = 0;
		deps.findExisting = async () => {
			lookups++;
			// Not there at first; there once the insert lost the race.
			return lookups > 1 ? winner : undefined;
		};
		deps.insertRow = vi.fn(async () => {
			throw Object.assign(new Error("duplicate key"), { code: "23505" });
		});

		const result = await registerExternalBuild(input(), deps);

		expect(result).toEqual({ deploymentId: "dep-winner", created: false });
		expect(rows).toHaveLength(0);
	});

	it("also recognises the violation when the driver wraps it", async () => {
		const { deps } = makeDeps();
		let lookups = 0;
		deps.findExisting = async () =>
			++lookups > 1 ? { deploymentId: "dep-w" } : undefined;
		deps.insertRow = vi.fn(async () => {
			throw Object.assign(new Error("failed query"), {
				cause: { code: "23505" },
			});
		});
		await expect(registerExternalBuild(input(), deps)).resolves.toEqual({
			deploymentId: "dep-w",
			created: false,
		});
	});

	it("does not hide any other insert failure", async () => {
		const { deps } = makeDeps();
		deps.insertRow = vi.fn(async () => {
			throw new Error("connection lost");
		});
		await expect(registerExternalBuild(input(), deps)).rejects.toThrow(
			"connection lost",
		);
	});

	it("refuses a service that Dokploy builds itself", async () => {
		const { deps, rows } = makeDeps(target({ dokployBuilds: true }));
		await expect(registerExternalBuild(input(), deps)).rejects.toThrow(
			/builds this service itself/,
		);
		expect(rows).toHaveLength(0);
	});

	it("checks the registration before it touches the service", async () => {
		const { deps } = makeDeps();
		const load = vi.spyOn(deps, "loadTarget");
		await expect(
			registerExternalBuild(input({ buildRunId: "1" }), deps),
		).rejects.toThrow(/buildRunId/);
		expect(load).not.toHaveBeenCalled();
	});
});

describe("externalBuildLogHeader", () => {
	it("tells where the build runs and that the deploy continues the log", () => {
		const header = externalBuildLogHeader(validateRegistration(input()));
		expect(header.split("\n")[0]).toBe("Initializing deployment");
		expect(header).toContain("continues this log");
	});
});

describe("finishExternalBuild", () => {
	const deployment = (overrides: Record<string, unknown> = {}) => ({
		deploymentId: "dep-1",
		logPath: "/logs/web.log",
		serverId: null,
		buildServerId: null,
		buildOrigin: "github-actions",
		buildRunUrl: RUN,
		buildRunId: "42",
		...overrides,
	});

	it("ends a waiting row as error and writes the reason and the link to its log", async () => {
		mocks.returnQueue.push([{ deploymentId: "dep-1" }]);
		const result = await finishExternalBuild(deployment(), {
			conclusion: "failure",
			message: "tests are red",
		});

		expect(result).toEqual({ updated: true, status: "error" });
		expect(mocks.update[0]?.set).toMatchObject({
			status: "error",
			errorMessage:
				"GitHub Actions run #42 failed. tests are red The run has the details.",
			buildRunStatus: "completed",
			buildRunStep: null,
		});
		expect(typeof mocks.update[0]?.set.finishedAt).toBe("string");
		const lines = mocks.appendLogLine.mock.calls.map((call) => call[2]);
		expect(lines).toEqual([
			"[GitHub Actions] GitHub Actions run #42 failed. tests are red",
			`[GitHub Actions] Open the run: ${RUN}`,
		]);
	});

	it("words a skipped build as skipped, not as a failure", async () => {
		mocks.returnQueue.push([{ deploymentId: "dep-1" }]);
		await finishExternalBuild(deployment(), {
			conclusion: "skipped",
			message: "no changes",
		});
		expect(mocks.update[0]?.set).toMatchObject({
			status: "cancelled",
			errorMessage: "Build skipped (no changes)",
		});
	});

	it("ends cancelled and skipped runs as cancelled", async () => {
		mocks.returnQueue.push(
			[{ deploymentId: "dep-1" }],
			[{ deploymentId: "dep-1" }],
		);
		expect(
			(await finishExternalBuild(deployment(), { conclusion: "cancelled" }))
				.status,
		).toBe("cancelled");
		expect(
			(await finishExternalBuild(deployment(), { conclusion: "skipped" }))
				.status,
		).toBe("cancelled");
	});

	it("changes nothing, and writes nothing, for a row a deploy took over or that already ended", async () => {
		mocks.returnQueue.push([]);
		const result = await finishExternalBuild(deployment(), {
			conclusion: "failure",
		});
		expect(result).toEqual({ updated: false, status: null });
		expect(mocks.appendLogLine).not.toHaveBeenCalled();
	});

	it("only ends rows built by GitHub Actions", async () => {
		await expect(
			finishExternalBuild(deployment({ buildOrigin: "dokploy" }), {
				conclusion: "failure",
			}),
		).rejects.toThrow(/not built by GitHub Actions/);
		expect(mocks.update).toHaveLength(0);
	});

	it("writes to the log on the build server when there is one", async () => {
		mocks.returnQueue.push([{ deploymentId: "dep-1" }]);
		await finishExternalBuild(
			deployment({ serverId: "srv-1", buildServerId: "build-1" }),
			{ conclusion: "failure" },
		);
		expect(mocks.appendLogLine.mock.calls[0]?.[0]).toBe("build-1");
	});
});
