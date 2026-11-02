import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	createTableSql,
	enumSql,
	migrationStatements,
	PGliteClass,
} from "../helpers/pglite-deployments";

/**
 * The live GitHub Actions rows against a real Postgres (PGlite) with the real drizzle tables and the real 0227
 * migration: the SQL of the guarded UPDATEs, the unique index and the filters runs for real. Only the things outside
 * the database are stood in for: the GitHub read, the log file of the registration and the pruning of old rows.
 *
 * Covers the review of PR 590: a deploy that waits in the queue (H1), the 409 for a row that can no longer be continued
 * (H2), the restart journal (M1), the watchdog's job matching (M2) and the host cleanup guard (M3).
 */

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@dokploy/server/db", () => ({
	db: new Proxy(
		{},
		{
			get: (_target, key) => (holder.db as Record<PropertyKey, unknown>)[key],
		},
	),
}));

const schema = await import("@dokploy/server/db/schema");
const { deployments, applications, deploymentQueueJobs } = schema;
const claimModule = await import("@dokploy/server/services/live-build-claim");
const externalBuild = await import("@dokploy/server/services/external-build");
const pollerModule = await import("@dokploy/server/services/github-run-poller");
const pollerDeps = await import(
	"@dokploy/server/services/github-run-poller-deps"
);
const journal = await import(
	"@dokploy/server/services/deployment-queue-journal"
);
const watchdogData = await import(
	"@dokploy/server/services/deployment-watchdog"
);
const guard = await import("@dokploy/server/utils/docker/cleanup-guard");
const cancel = await import("@dokploy/server/services/deployment-cancel");
const watchdog = await import("@/server/queues/deployment-watchdog");

const RUN = "https://github.com/acme/web/actions/runs/42";
const START = Date.parse("2026-11-02T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let client: { exec: (sql: string) => Promise<unknown> } | null = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-gha-db-"));

const ready = PGliteClass !== null;

beforeAll(async () => {
	if (!PGliteClass) return;
	const pg = new PGliteClass();
	client = pg;
	holder.db = drizzle(pg as never, { schema });
	const { statements, names } = enumSql(schema);
	for (const statement of statements) await pg.exec(statement);
	for (const table of [
		deployments,
		applications,
		schema.compose,
		deploymentQueueJobs,
	]) {
		await pg.exec(createTableSql(table, names));
	}
	// The migration that ships: its ALTERs are no-ops on the generated table, its index is created for real.
	for (const statement of migrationStatements(
		"0227_deployment_live_github_run.sql",
	)) {
		await pg.exec(statement);
	}
}, 120_000);

afterAll(async () => {
	await (client as unknown as { close?: () => Promise<void> })?.close?.();
	fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
	if (!client) return;
	await client.exec(
		'TRUNCATE "deployment", "application", "compose", "deployment_queue_job"',
	);
	await client.exec(
		`INSERT INTO "application" ("applicationId", "appName", "name") VALUES ('app-1', 'web', 'web')`,
	);
});

const target = {
	kind: "application" as const,
	serviceId: "app-1",
	appName: "web",
	serverId: null,
	buildServerId: null,
	dokployBuilds: false,
};

let logSeq = 0;
const register = async (run = 42, attempt = "") => {
	const buildRunUrl = `https://github.com/acme/web/actions/runs/${run}${attempt}`;
	return externalBuild.registerExternalBuild(
		{
			applicationId: "app-1",
			buildOrigin: "github-actions",
			buildRunUrl,
			buildRunId: String(run),
			buildRepository: "acme/web",
			buildCommitSha: "abcdef0123456789",
			title: `GHA production abcdef01 [run ${run}]`,
		},
		{
			...externalBuild.defaultRegisterDeps,
			loadTarget: async () => target,
			createLog: async () => {
				const file = path.join(tmp, `web-${++logSeq}.log`);
				fs.writeFileSync(file, "registered\n");
				return file;
			},
			prune: async () => {},
		},
	);
};

const rowsOfService = () =>
	(holder.db as { select: () => { from: (t: unknown) => Promise<unknown[]> } })
		.select()
		.from(deployments) as Promise<Array<typeof deployments.$inferSelect>>;

const reference = (deploymentId: string) => ({
	deploymentId,
	kind: "application" as const,
	serviceId: "app-1",
});

const claimOf = (deploymentId: string) => ({
	...reference(deploymentId),
	logHost: null,
});

const failedRun = () => ({
	kind: "ok" as const,
	jobs: [
		{
			name: "build",
			status: "completed",
			conclusion: "failure",
			steps: [
				{
					number: 1,
					name: "Build image",
					status: "completed",
					conclusion: "failure",
					started_at: "2026-11-02T10:00:00Z",
					completed_at: "2026-11-02T10:02:13Z",
				},
			],
		},
	],
	run: { status: "completed", conclusion: "failure" },
	authenticated: true,
	rateLimitRemaining: 4000,
	rateLimitResetAt: null,
});

/** The real poller on the real database; only GitHub and the log file are stood in for. */
const pollerAt = (clock: { now: number }) =>
	pollerModule.createGithubRunPoller({
		...pollerDeps.createDefaultGithubRunPollerDeps(),
		now: () => clock.now,
		fetchRun: async () => failedRun(),
		readLog: async () => "",
		appendLines: async () => {},
	});

describe.skipIf(!ready)("a registered row on a real database", () => {
	it("registers once per run link however many legs register at once, and a re-run gets its own row", async () => {
		const [a, b, c] = await Promise.all([register(), register(), register()]);
		expect(new Set([a.deploymentId, b.deploymentId, c.deploymentId]).size).toBe(
			1,
		);
		const rerun = await register(42, "/attempts/2");
		expect(rerun.deploymentId).not.toBe(a.deploymentId);
		const rows = await rowsOfService();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			status: "running",
			externalBuildOnly: true,
			buildRunStatus: "queued",
			deployQueuedAt: null,
		});
	});

	it("the unique index of the shipped migration refuses a second registered row for the same link", async () => {
		await register();
		await expect(
			(
				holder.db as never as {
					insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
				}
			)
				.insert(deployments)
				.values({
					applicationId: "app-1",
					title: "twin",
					logPath: "x",
					buildOrigin: "github-actions",
					buildRunUrl: RUN,
					externalBuildOnly: true,
				}),
		).rejects.toSatisfy((error: unknown) =>
			externalBuild.isUniqueViolation(error),
		);
	});
});

describe.skipIf(!ready)("H1: a deploy that waits in Dokploy's queue", () => {
	it("keeps the row running when the run fails while the deploy is queued, then the job takes it over: one row", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));

		const clock = { now: START + MINUTE };
		const poller = pollerAt(clock);
		await poller.poll();
		// The run failed 40 minutes ago and the job is still queued: the poller must not end the row.
		clock.now = START + 40 * MINUTE;
		await poller.poll();
		clock.now = START + 7 * HOUR;
		await poller.poll();
		let [row] = await rowsOfService();
		expect(row).toMatchObject({
			status: "running",
			externalBuildOnly: true,
			errorMessage: null,
		});
		expect(row?.deployQueuedAt).toBeTruthy();

		// The queue job starts at last and takes the row over.
		const claimed = await claimModule.claimLiveGithubBuild(
			claimOf(deploymentId),
			{ title: "ignored: the registered title stays" },
		);
		expect(claimed?.deploymentId).toBe(deploymentId);
		const rows = await rowsOfService();
		expect(rows).toHaveLength(1);
		[row] = rows;
		expect(row).toMatchObject({
			status: "running",
			externalBuildOnly: false,
			buildRunStatus: "completed",
			title: "GHA production abcdef01 [run 42]",
		});
		expect(row?.deployStartedAt).toBeTruthy();
	});

	it("without a deploy request the same failed run ends the row at once (the control)", async () => {
		const { deploymentId } = await register();
		const clock = { now: START + MINUTE };
		await pollerAt(clock).poll();
		const [row] = await rowsOfService();
		expect(row).toMatchObject({ deploymentId, status: "error" });
		expect(row?.errorMessage).toContain("failed");
	});

	it("only the backstop ends a row whose deploy never ran, after 24 hours", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		// The request time is the real clock; the poller's clock is moved from it.
		const queuedAt = Date.now();
		const clock = { now: queuedAt + 23 * HOUR };
		const poller = pollerAt(clock);
		await poller.poll();
		expect((await rowsOfService())[0]?.status).toBe("running");
		clock.now = queuedAt + 25 * HOUR;
		await poller.poll();
		const [row] = await rowsOfService();
		expect(row?.status).toBe("error");
		expect(row?.errorMessage).toContain("never started");
	});

	it("closes the row as cancelled when the queued deploy leaves the queue without running", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		expect(
			await claimModule.endQueuedLiveBuild(
				deploymentId,
				"cancelled",
				claimModule.QUEUED_DEPLOY_REMOVED_MESSAGE,
			),
		).toBe(true);
		const [row] = await rowsOfService();
		expect(row).toMatchObject({
			status: "cancelled",
			externalBuildOnly: true,
			errorMessage: claimModule.QUEUED_DEPLOY_REMOVED_MESSAGE,
		});
		// Nothing to end twice.
		expect(
			await claimModule.endQueuedLiveBuild(deploymentId, "cancelled", "again"),
		).toBe(false);
	});

	it("does not touch a row that has no deploy on the way when a job is dropped", async () => {
		const { deploymentId } = await register();
		expect(
			await claimModule.endQueuedLiveBuild(deploymentId, "cancelled", "x"),
		).toBe(false);
		expect((await rowsOfService())[0]?.status).toBe("running");
	});

	it("withdraws the request when queueing failed, so the run poller owns the row again", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		await claimModule.withdrawLiveBuildDeploy(deploymentId);
		const clock = { now: START + MINUTE };
		await pollerAt(clock).poll();
		expect((await rowsOfService())[0]?.status).toBe("error");
	});

	it("ends a row whose deploy ran on another host and let the deploy write its own", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		const claimed = await claimModule.claimLiveGithubBuild({
			...claimOf(deploymentId),
			logHost: "srv-elsewhere",
		});
		expect(claimed).toBeNull();
		expect((await rowsOfService())[0]).toMatchObject({
			status: "error",
			externalBuildOnly: true,
		});
	});
});

describe.skipIf(!ready)("H2: a row that can no longer be continued", () => {
	it("is refused with 409 once it ended, and the 400 stays for an unknown or foreign id", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		await claimModule.endQueuedLiveBuild(deploymentId, "cancelled", "gone");

		await expect(
			claimModule.requestLiveBuildDeploy(reference(deploymentId)),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			claimModule.requestLiveBuildDeploy(reference("nope")),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			claimModule.requestLiveBuildDeploy({
				...reference(deploymentId),
				serviceId: "other-app",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("is refused with 409 when a deploy already took the row over", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		await claimModule.claimLiveGithubBuild(claimOf(deploymentId));
		await expect(
			claimModule.requestLiveBuildDeploy(reference(deploymentId)),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("is refused with 409 once the poller closed it, before any deploy was asked for", async () => {
		const { deploymentId } = await register();
		await pollerAt({ now: START + MINUTE }).poll();
		await expect(
			claimModule.requestLiveBuildDeploy(reference(deploymentId)),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe.skipIf(!ready)("M1: the restart journal", () => {
	it("leaves a live row alone and still marks a taken-over row interrupted", async () => {
		const live = await register(42);
		const second = await register(43);
		await claimModule.requestLiveBuildDeploy(reference(second.deploymentId));
		await claimModule.claimLiveGithubBuild(claimOf(second.deploymentId));

		const closed = await journal.markInterruptedQueueDeployments([
			{
				payload: {
					applicationId: "app-1",
					applicationType: "application",
				},
			} as never,
		]);

		expect(closed).toBe(1);
		const rows = await rowsOfService();
		const byId = new Map(rows.map((row) => [row.deploymentId, row]));
		expect(byId.get(live.deploymentId)).toMatchObject({
			status: "running",
			externalBuildOnly: true,
		});
		expect(byId.get(second.deploymentId)).toMatchObject({
			status: "error",
			externalBuildOnly: false,
		});
	});
});

describe.skipIf(!ready)("M2: the watchdog and a taken-over row", () => {
	it("matches the taken-over row to its job by the takeover, not by the registration", async () => {
		const { deploymentId } = await register();
		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		await claimModule.claimLiveGithubBuild(claimOf(deploymentId));
		// The build took 3 hours and the deploy waited in the queue; the job started a minute ago.
		const jobStart = Date.now();
		await (
			holder.db as never as {
				update: (t: unknown) => {
					set: (v: unknown) => { where: (w: unknown) => Promise<unknown> };
				};
			}
		)
			.update(deployments)
			.set({
				createdAt: new Date(jobStart - 3 * HOUR).toISOString(),
				startedAt: new Date(jobStart - 3 * HOUR).toISOString(),
			})
			.where(
				(await import("drizzle-orm")).eq(
					deployments.deploymentId,
					deploymentId,
				),
			);

		const running = await watchdogData.listRunningDeployDeployments();
		expect(running).toHaveLength(1);
		const [row] = running;
		expect(row?.deployStartedAt).toBeTruthy();

		const job = {
			id: "job-1",
			processedOn: jobStart - 1_000,
			data: { applicationId: "app-1", applicationType: "application" },
		};
		expect(watchdog.findJobOf(row as never, [job as never])).not.toBeNull();
		// The old rule, by the registration time, would have called it a leftover of another deploy.
		expect(
			watchdog.findJobOf(
				{ ...(row as object), deployStartedAt: null } as never,
				[job as never],
			),
		).toBeNull();
	});

	it("does not list a live row at all", async () => {
		await register();
		expect(await watchdogData.listRunningDeployDeployments()).toHaveLength(0);
	});
});

describe.skipIf(!ready)("M3: the host cleanup guard", () => {
	it("does not count a live row as a deploy running on the host, and counts a taken-over one", async () => {
		const { deploymentId } = await register();
		expect(await guard.countActiveDeploymentsOnHost(null)).toBe(0);

		await claimModule.requestLiveBuildDeploy(reference(deploymentId));
		await claimModule.claimLiveGithubBuild(claimOf(deploymentId));
		expect(await guard.countActiveDeploymentsOnHost(null)).toBe(1);
	});
});

describe.skipIf(!ready)("M4: the stops that target the running build", () => {
	it("lets the user cancel a live row: it closes as cancelled and stays out of every deploy derivation", async () => {
		const { deploymentId } = await register();
		const outcome = await cancel.cancelBuildServerDeploymentById(deploymentId);
		expect(outcome).toMatchObject({ status: "cancelled" });
		const [row] = await rowsOfService();
		expect(row).toMatchObject({
			status: "cancelled",
			externalBuildOnly: true,
			buildRunStatus: "completed",
		});
		expect(row?.errorMessage).toContain(
			"GitHub Actions run itself is not stopped",
		);
		// Cancelling again finds nothing running.
		expect(await cancel.cancelBuildServerDeploymentById(deploymentId)).toEqual({
			status: "not-running",
		});
	});

	it("skips a live row in the service-level kill, and leaves it running", async () => {
		const { deploymentId } = await register();
		await (
			holder.db as never as {
				update: (t: unknown) => {
					set: (v: unknown) => { where: (w: unknown) => Promise<unknown> };
				};
			}
		)
			.update(deployments)
			.set({ buildServerId: "build-1" })
			.where(
				(await import("drizzle-orm")).eq(
					deployments.deploymentId,
					deploymentId,
				),
			);

		const result = await cancel.cancelBuildServerDeploymentsForService({
			type: "application",
			applicationId: "app-1",
		});
		expect(result.cancelled).toBe(0);
		expect(result.usesBuildServer).toBe(false);
		expect((await rowsOfService())[0]?.status).toBe("running");
	});
});
