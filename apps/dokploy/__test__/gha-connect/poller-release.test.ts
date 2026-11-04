import {
	applications,
	compose,
	deployments,
	ghaConnection,
	ghaRelease,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema";
import type { WatchRow } from "@dokploy/server/services/github-deployments";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	events: [] as string[],
	updates: [] as Array<{
		tx: number;
		table: unknown;
		values: Record<string, unknown>;
	}>,
	txCount: 0,
	/** Rows the locked selects answer in turn: the watch row, the connection row, then the release row. */
	lockedQueue: [] as Array<Record<string, unknown> | null>,
	queueAdd: vi.fn(),
	getJobs: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	getDokployUrl: vi.fn(),
	registerExternalBuild: vi.fn(),
	/** The deployments table, as far as the poller reads it: one row the run registered. */
	deploymentRow: null as Record<string, unknown> | null,
	/** gha_release rows the poller looks up by deployment id. */
	releaseRows: [] as unknown[],
	listEnabledGithubWatches: vi.fn(),
	deleteGithubWatch: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	getDokployUrl: mocks.getDokployUrl,
	registerExternalBuild: mocks.registerExternalBuild,
}));

vi.mock("@dokploy/server/db", async () => {
	const { PgDialect } = await import("drizzle-orm/pg-core");
	const dialect = new PgDialect();
	/**
	 * Whether the deployment row satisfies a condition, read from the SQL the
	 * poller built: a `title like` pattern or a `buildRunId =` value.
	 */
	const rowMatches = (condition: unknown) => {
		const row = mocks.deploymentRow;
		if (!row) return false;
		const { sql, params } = dialect.sqlToQuery(condition as never);
		const values = params.map(String);
		if (/"title" like/.test(sql)) {
			const pattern = values.find((v) => v.includes("%"));
			if (!pattern) return false;
			const [head = "", tail = ""] = pattern.split("%");
			const title = String(row.title);
			return title.startsWith(head) && title.endsWith(tail);
		}
		if (/"buildRunId" =/.test(sql))
			return values.includes(String(row.buildRunId));
		return false;
	};
	const makeTx = (id: number) => ({
		select: () => ({
			from: () => ({
				where: () => ({
					for: async () => {
						const next = mocks.lockedQueue.shift();
						return next ? [next] : [];
					},
				}),
			}),
		}),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					mocks.updates.push({ tx: id, table, values });
					mocks.events.push(`tx${id}:write`);
				},
			}),
		}),
	});
	return {
		db: {
			transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
				mocks.txCount += 1;
				const id = mocks.txCount;
				mocks.events.push(`tx${id}:begin`);
				const result = await fn(makeTx(id));
				mocks.events.push(`tx${id}:commit`);
				return result;
			},
			select: () => ({
				from: (table: unknown) => ({
					where: (condition: unknown) =>
						Object.assign(
							Promise.resolve(table === ghaRelease ? mocks.releaseRows : []),
							{
								orderBy: () => ({
									limit: async () =>
										table === deployments && rowMatches(condition)
											? [{ status: mocks.deploymentRow?.status }]
											: [],
								}),
							},
						),
				}),
			}),
			update: (table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						// Only the retitle of the registered row is made outside a transaction.
						if (table === deployments && mocks.deploymentRow) {
							Object.assign(mocks.deploymentRow, values);
						}
					},
				}),
			}),
			query: {
				applications: { findFirst: vi.fn() },
				compose: { findFirst: vi.fn() },
			},
		},
	};
});

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: async (...args: unknown[]) => {
			mocks.events.push("queue:add");
			return mocks.queueAdd(...args);
		},
		getJobs: mocks.getJobs,
	},
}));

vi.mock("@dokploy/server/services/backup", () => ({ findBackupById: vi.fn() }));
vi.mock("@dokploy/server/utils/backups/compose", () => ({
	runComposeBackup: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/background", () => ({
	runBackgroundJob: async (_name: string, fn: () => Promise<void>) => fn(),
}));

vi.mock(
	"@dokploy/server/services/github-deployments",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		listEnabledGithubWatches: mocks.listEnabledGithubWatches,
		deleteGithubWatch: mocks.deleteGithubWatch,
		removeGhcrWatchConfigDirs: mocks.removeGhcrWatchConfigDirs,
	}),
);

const poller = await import("@/server/queues/github-deployments-poller");

const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const NEW2 = `sha256:${"c".repeat(64)}`;
const WEB = "registry.devino.ca/shop/web";
const DOCS = "registry.devino.ca/shop/docs";
const deployment = { id: 120, sha: "d".repeat(40), environment: "production" };

const releaseContext = {
	connectionId: "gc-1",
	serviceKey: "shop",
	manifestReleaseId: "gh-555.1",
	sha: "d".repeat(40),
	runId: 555,
	runAttempt: 1,
	delivery: "pull" as const,
	images: [{ name: "web", composeService: "web", ref: `${WEB}@${NEW}` }],
};
const payload = (
	extra: Array<{ repository: string; digest: string }> = [],
) => ({
	kind: "deploy" as const,
	image: `${WEB}@${NEW}`,
	repository: WEB,
	digest: NEW,
	buildRunUrl: "https://github.com/acme/shop/actions/runs/555",
	...(extra.length > 0 ? { extraImages: extra } : {}),
	release: releaseContext,
});

/** The cursor is already past the Deployment: it waited for the deploy gate. */
const watchRow = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "acme",
	repo: "shop",
	environment: "production",
	enabled: true,
	lastSeenDeploymentId: 130,
	etag: null,
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	ghaConnectionId: "gc-1",
	...overrides,
});
const lockedWatch = (
	watch: WatchRow,
	overrides: Record<string, unknown> = {},
) => ({
	watchId: watch.watchId,
	enabled: true,
	inflightDeploymentId: null,
	owner: watch.owner,
	repo: watch.repo,
	environment: watch.environment,
	connectionId: watch.connectionId,
	lastSeenDeploymentId: watch.lastSeenDeploymentId,
	...overrides,
});
const connectionRow = (overrides: Record<string, unknown> = {}) => ({
	ghaConnectionId: "gc-1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	state: "waiting",
	gateBlocked: false,
	previousSource: null,
	...overrides,
});
const storedRelease = { releaseId: "rel-1" };
const org = { projectId: "proj-1", project: { organizationId: "org-a" } };
const gitApp = {
	applicationId: "app-1",
	sourceType: "github",
	owner: "acme",
	repository: "shop",
	branch: "main",
	autoDeploy: true,
	dockerImage: null,
	serverId: null,
	environmentId: "env-1",
	environment: org,
};
const stack = {
	composeId: "c-1",
	sourceType: "raw",
	composeFile: `services:\n  web:\n    image: ${WEB}@${OLD}\n  docs:\n    image: ${DOCS}@${OLD}\n`,
	serverId: null,
	environmentId: "env-1",
	environment: org,
};
const deps = () => poller.createGithubDeploymentsPollDeps();
const locked = (
	watch: WatchRow,
	connection: Record<string, unknown> | null = connectionRow(),
	release: Record<string, unknown> | null = storedRelease,
) => [lockedWatch(watch), connection, release];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.events = [];
	mocks.updates = [];
	mocks.txCount = 0;
	mocks.lockedQueue = [];
	mocks.queueAdd.mockResolvedValue({ id: "job-1" });
	mocks.getJobs.mockResolvedValue([]);
	mocks.getDokployUrl.mockResolvedValue("https://dokploy.example");
	// The row upkeep registered for the run while GitHub built: open, titled by the run.
	mocks.deploymentRow = null;
	mocks.releaseRows = [];
	mocks.registerExternalBuild.mockImplementation(async () => {
		mocks.deploymentRow = {
			deploymentId: "dep-live",
			title: "GHA run #555",
			buildRunId: "555",
			externalBuildOnly: true,
			status: "running",
		};
		return { deploymentId: "dep-live", created: false };
	});
	mocks.findApplicationById.mockResolvedValue(gitApp);
	mocks.findComposeById.mockResolvedValue(stack);
});

describe("startDeploy: a release of a GitHub Actions connection", () => {
	it("flips a git application to the image at its first release: old source kept, autodeploy off, one transaction", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch);
		const outcome = await deps().startDeploy(watch, deployment, payload());

		expect(outcome.kind).toBe("started");
		expect(mocks.events.indexOf("queue:add")).toBeGreaterThan(
			mocks.events.indexOf("tx1:commit"),
		);
		expect(mocks.updates.every((u) => u.tx === 1)).toBe(true);
		const claim = mocks.updates.find((u) => u.table === githubDeploymentWatch);
		expect(claim?.values).toMatchObject({ inflightDeploymentId: 120 });
		// The cursor is not moved: it is already past this Deployment.
		expect(claim?.values).not.toHaveProperty("lastSeenDeploymentId");
		expect(
			mocks.updates.find((u) => u.table === applications)?.values,
		).toMatchObject({
			sourceType: "docker",
			dockerImage: `${WEB}@${NEW}`,
			autoDeploy: false,
		});
		expect(
			mocks.updates.find((u) => u.table === ghaConnection)?.values,
		).toMatchObject({
			previousSource: expect.objectContaining({
				sourceType: "github",
				branch: "main",
				autoDeploy: true,
			}),
		});
		// The application as it was just before the flip, saved with the release already accepted.
		expect(
			mocks.updates.find((u) => u.table === ghaRelease)?.values,
		).toMatchObject({
			sourceBackup: expect.objectContaining({
				sourceType: "github",
				branch: "main",
				repository: "shop",
			}),
		});
		// The job continues the live GitHub Actions row and carries the build origin.
		expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({
			applicationId: "app-1",
			buildOrigin: "github-actions",
			buildRunUrl: "https://github.com/acme/shop/actions/runs/555",
			deploymentId: "dep-live",
			titleLog: expect.stringMatching(
				/^GHA production dddddddd \[deployment #120\]$/,
			),
		});
	});

	it("keeps the source saved at Connect instead of overwriting it", async () => {
		const watch = watchRow();
		const saved = { sourceType: "github", autoDeploy: true, branch: "main" };
		mocks.lockedQueue = locked(watch, connectionRow({ previousSource: saved }));
		await deps().startDeploy(watch, deployment, payload());
		expect(
			mocks.updates.find((u) => u.table === ghaConnection),
		).toBeUndefined();
	});

	it("an application that already runs the image only gets the new digest", async () => {
		const watch = watchRow();
		mocks.findApplicationById.mockResolvedValue({
			...gitApp,
			sourceType: "docker",
			dockerImage: `${WEB}@${OLD}`,
		});
		mocks.lockedQueue = locked(watch);
		const outcome = await deps().startDeploy(watch, deployment, payload());
		expect(outcome.kind).toBe("started");
		expect(mocks.updates.find((u) => u.table === applications)?.values).toEqual(
			{
				dockerImage: `${WEB}@${NEW}`,
			},
		);
		expect(
			mocks.updates.find((u) => u.table === ghaConnection),
		).toBeUndefined();
	});

	it("pins every image of a compose release and keeps the stored file as the backup", async () => {
		const watch = watchRow({ serviceType: "compose", serviceId: "c-1" });
		mocks.lockedQueue = locked(
			watch,
			connectionRow({ serviceType: "compose", serviceId: "c-1" }),
		);
		const outcome = await deps().startDeploy(
			watch,
			deployment,
			payload([{ repository: DOCS, digest: NEW2 }]),
		);
		expect(outcome.kind).toBe("started");
		const file = mocks.updates.find((u) => u.table === compose)?.values
			.composeFile as string;
		expect(file).toContain(`${WEB}@${NEW}`);
		expect(file).toContain(`${DOCS}@${NEW2}`);
		expect(file).not.toContain(OLD);
		expect(
			mocks.updates.find((u) => u.table === ghaRelease)?.values,
		).toMatchObject({
			sourceBackup: {
				composeId: "c-1",
				sourceType: "raw",
				composeFile: stack.composeFile,
			},
		});
		expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({
			composeId: "c-1",
		});
	});

	it("rejects when the connection is gone, writing and enqueuing nothing", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch, null);
		const outcome = await deps().startDeploy(watch, deployment, payload());
		expect(outcome.kind).toBe("rejected");
		expect(mocks.updates).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("is stale, not failed, when the connection was disconnected between the tick and the start", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch, connectionRow({ state: "disconnected" }));
		const outcome = await deps().startDeploy(watch, deployment, payload());
		expect(outcome.kind).toBe("stale");
		expect(mocks.updates).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("is stale, and writes nothing, when the gate settings changed since the gate answered", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch, connectionRow({ gateVersion: 4 }));
		const stale = payload();
		stale.release = {
			...releaseContext,
			gateVersion: 3,
		} as typeof stale.release;
		expect((await deps().startDeploy(watch, deployment, stale)).kind).toBe(
			"stale",
		);
		expect(mocks.updates).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();

		// The version the gate read is the one stored: it starts.
		mocks.lockedQueue = locked(watch, connectionRow({ gateVersion: 3 }));
		const current = payload();
		current.release = {
			...releaseContext,
			gateVersion: 3,
		} as typeof current.release;
		expect((await deps().startDeploy(watch, deployment, current)).kind).toBe(
			"started",
		);
	});

	it("is stale, and writes nothing, when the connection got blocked for a reason that is not the gate's", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(
			watch,
			connectionRow({ state: "blocked", gateBlocked: false }),
		);
		expect((await deps().startDeploy(watch, deployment, payload())).kind).toBe(
			"stale",
		);
		expect(mocks.updates).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("starts through a block the gate itself set", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(
			watch,
			connectionRow({ state: "blocked", gateBlocked: true }),
		);
		expect((await deps().startDeploy(watch, deployment, payload())).kind).toBe(
			"started",
		);
	});

	it("is stale when the release is no longer waiting (superseded, failed or deployed since)", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch, connectionRow(), null);
		expect((await deps().startDeploy(watch, deployment, payload())).kind).toBe(
			"stale",
		);
		expect(mocks.updates).toEqual([]);
	});

	it("is stale when the watch moved or already has a deployment in flight", async () => {
		const watch = watchRow();
		for (const change of [
			{ lastSeenDeploymentId: 140 },
			{ inflightDeploymentId: 99 },
			{ enabled: false },
			{ owner: "other" },
		]) {
			mocks.updates = [];
			mocks.lockedQueue = [
				lockedWatch(watch, change),
				connectionRow(),
				storedRelease,
			];
			expect(
				(await deps().startDeploy(watch, deployment, payload())).kind,
			).toBe("stale");
			expect(mocks.updates).toEqual([]);
		}
	});

	it("a github-actions provider application is not flipped: the first release only sets the digest", async () => {
		const watch = watchRow();
		mocks.findApplicationById.mockResolvedValue({
			...gitApp,
			sourceType: "github-actions",
			dockerImage: null,
		});
		mocks.lockedQueue = locked(watch);
		const outcome = await deps().startDeploy(watch, deployment, payload());
		expect(outcome.kind).toBe("started");
		expect(mocks.updates.find((u) => u.table === applications)?.values).toEqual(
			{
				dockerImage: `${WEB}@${NEW}`,
			},
		);
		expect(
			mocks.updates.find((u) => u.table === ghaConnection),
		).toBeUndefined();
	});

	it("a github-actions provider compose stack is pinned like a stored one", async () => {
		const watch = watchRow({ serviceType: "compose", serviceId: "c-1" });
		mocks.findComposeById.mockResolvedValue({
			...stack,
			sourceType: "github-actions",
		});
		mocks.lockedQueue = locked(
			watch,
			connectionRow({ serviceType: "compose", serviceId: "c-1" }),
		);
		expect((await deps().startDeploy(watch, deployment, payload())).kind).toBe(
			"started",
		);
		expect(
			mocks.updates.find((u) => u.table === compose)?.values.composeFile,
		).toContain(`${WEB}@${NEW}`);
	});

	it("rejects several images for an application", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch);
		const outcome = await deps().startDeploy(
			watch,
			deployment,
			payload([{ repository: DOCS, digest: NEW2 }]),
		);
		expect(outcome).toMatchObject({
			kind: "rejected",
			reason: expect.stringContaining("one image"),
		});
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects an image of another repository on an application that runs one", async () => {
		const watch = watchRow();
		mocks.findApplicationById.mockResolvedValue({
			...gitApp,
			sourceType: "docker",
			dockerImage: `registry.devino.ca/other/app@${OLD}`,
		});
		mocks.lockedQueue = locked(watch);
		expect((await deps().startDeploy(watch, deployment, payload())).kind).toBe(
			"rejected",
		);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a compose stack whose file is not stored in Dokploy", async () => {
		const watch = watchRow({ serviceType: "compose", serviceId: "c-1" });
		mocks.findComposeById.mockResolvedValue({ ...stack, sourceType: "git" });
		mocks.lockedQueue = locked(
			watch,
			connectionRow({ serviceType: "compose", serviceId: "c-1" }),
		);
		expect((await deps().startDeploy(watch, deployment, payload())).kind).toBe(
			"rejected",
		);
	});

	it("puts the source, the in-flight mark and the backup back when the enqueue fails, and leaves the release accepted", async () => {
		mocks.queueAdd.mockRejectedValue(new Error("queue closed"));
		const watch = watchRow();
		mocks.lockedQueue = locked(watch);
		await expect(
			deps().startDeploy(watch, deployment, payload()),
		).rejects.toThrow("queue closed");

		const undo = mocks.updates.filter((u) => u.tx === 2);
		expect(undo.find((u) => u.table === githubDeploymentWatch)?.values).toEqual(
			{
				lastSeenDeploymentId: 130,
				inflightDeploymentId: null,
				inflightStartedAt: null,
			},
		);
		expect(undo.find((u) => u.table === applications)?.values).toMatchObject({
			sourceType: "github",
			dockerImage: null,
			autoDeploy: true,
		});
		expect(undo.find((u) => u.table === ghaRelease)?.values).toEqual({
			sourceBackup: null,
		});
	});

	it("starts without a live row when the run has no link", async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch);
		const { buildRunUrl: _link, ...bare } = payload();
		await deps().startDeploy(watch, deployment, bare);
		expect(mocks.registerExternalBuild).not.toHaveBeenCalled();
		expect(mocks.queueAdd.mock.calls[0]?.[1]).not.toHaveProperty(
			"deploymentId",
		);
	});
});

describe("a release that continues the row registered for its run", () => {
	const started = async () => {
		const watch = watchRow();
		mocks.lockedQueue = locked(watch);
		await deps().startDeploy(watch, deployment, payload());
		return watch;
	};
	const inflight = (watch: WatchRow) =>
		deps().inspectInflight({
			...watch,
			inflightDeploymentId: 120,
			inflightStartedAt: new Date(),
		});

	it("is found, and ends as done: the row is retitled with the deployment handle", async () => {
		const watch = await started();
		expect(
			String(mocks.deploymentRow?.title).endsWith("[deployment #120]"),
		).toBe(true);
		// The deploy ran on the reused row and finished.
		if (mocks.deploymentRow) mocks.deploymentRow.status = "done";
		expect(await inflight(watch)).toMatchObject({ state: "done" });
	});

	it("is found by the run it was built by even if the row kept its old title", async () => {
		const watch = await started();
		// The retitle did not happen (a failed write): the lookup must not depend on it.
		if (mocks.deploymentRow) {
			mocks.deploymentRow.title = "GHA run #555";
			mocks.deploymentRow.status = "done";
		}
		mocks.releaseRows = [{ releaseId: "rel-1", runId: 555 }];
		expect(await inflight(watch)).toMatchObject({ state: "done" });
	});

	it("is still running while the reused row is open", async () => {
		const watch = await started();
		expect(await inflight(watch)).toMatchObject({ state: "running" });
	});

	it("was missing before the fix: an untitled row and no run lookup is never found", async () => {
		const watch = await started();
		if (mocks.deploymentRow) {
			mocks.deploymentRow.title = "GHA run #555";
			mocks.deploymentRow.status = "done";
		}
		mocks.releaseRows = [];
		expect(await inflight(watch)).toMatchObject({ state: "missing" });
	});
});
