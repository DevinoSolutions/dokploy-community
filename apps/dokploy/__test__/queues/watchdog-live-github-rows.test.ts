import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A deployment row that waits for its GitHub Actions run has nothing running on this instance: the stuck-deployment
 * watchdog (and the cancel of a running deploy that shares its list) must not see it, and a Dokploy restart must
 * not cancel it. Rows with a NULL origin or run state, which is every row written before, stay in both.
 */

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
	selectWheres: [] as unknown[],
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			deployments: { findMany: (args: unknown) => mocks.findMany(args) },
		},
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: (condition: unknown) => {
						mocks.selectWheres.push(condition);
						return Promise.resolve([]);
					},
				}),
			}),
		}),
		update: vi.fn(),
	},
}));
vi.mock("@dokploy/server/services/admin", () => ({ getDokployUrl: vi.fn() }));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(),
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: vi.fn(),
}));
vi.mock("@dokploy/server/services/preview-deployment", () => ({
	findPreviewDeploymentById: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-cancel", () => ({
	restoreServiceStatusIfUnchanged: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-log-host", () => ({
	resolveDeploymentLogHost: vi.fn(),
}));
vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	getDeploymentErrorMessage: vi.fn(),
}));
vi.mock("@dokploy/server/services/deployment-queue-journal", () => ({
	markInterruptedFromJournal: vi.fn(),
}));

const render = (node: unknown) =>
	new PgDialect().sqlToQuery(node as Parameters<PgDialect["sqlToQuery"]>[0]);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.selectWheres.length = 0;
});

describe("the watchdog's list of running deploys", () => {
	it("leaves out the rows that wait for their GitHub Actions run", {
		timeout: 60_000,
	}, async () => {
		const { listRunningDeployDeployments } = await import(
			"@dokploy/server/services/deployment-watchdog"
		);
		await listRunningDeployDeployments();

		const args = mocks.findMany.mock.calls[0]?.[0] as { where: unknown };
		const { sql, params } = render(args.where);
		// Running deploys of services...
		expect(params).toContain("running");
		// ...except a registered GitHub Actions row nothing took over yet.
		expect(sql).toContain('"externalBuildOnly" = $');
		expect(params).toContain(false);
	});
});

describe("the restart sweep", () => {
	it("does not cancel the rows that wait for their GitHub Actions run", {
		timeout: 60_000,
	}, async () => {
		const { initCancelDeployments } = await import(
			"@dokploy/server/utils/startup/cancel-deployments"
		);
		await initCancelDeployments();

		expect(mocks.selectWheres).toHaveLength(1);
		const { sql, params } = render(mocks.selectWheres[0]);
		expect(params).toContain("running");
		expect(sql).toContain('"externalBuildOnly" = $');
		expect(params).toContain(false);
	});
});
