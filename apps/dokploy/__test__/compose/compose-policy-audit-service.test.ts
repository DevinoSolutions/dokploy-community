import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service side of the restricted-compose audit (T-7455): with the setting
 * off (the default) nothing is evaluated and nothing is written, an excluded
 * compose is skipped, and no failure of any step, however slow or broken, ever
 * reaches the deploy that called it.
 */

const mocks = vi.hoisted(() => ({
	appendLogLine: vi.fn().mockResolvedValue(undefined),
	warn: vi.fn(),
	evaluateComposePolicy: vi.fn(),
	actualEvaluate: undefined as unknown as (...args: unknown[]) => unknown,
}));

vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return { ...actual, appendLogLine: mocks.appendLogLine };
});
vi.mock("@dokploy/server/utils/compose-policy/evaluate", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/compose-policy/evaluate")
	>("@dokploy/server/utils/compose-policy/evaluate");
	mocks.actualEvaluate = actual.evaluateComposePolicy as never;
	mocks.evaluateComposePolicy.mockImplementation(actual.evaluateComposePolicy);
	return { ...actual, evaluateComposePolicy: mocks.evaluateComposePolicy };
});
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));

import { db } from "@dokploy/server/db";
import {
	AUDIT_TIMEOUT_MS,
	runComposePolicyAudit,
} from "@dokploy/server/services/compose-policy-audit";

const RAW = [
	"services:",
	"  web:",
	"    image: nginx",
	"    privileged: true",
	"    environment:",
	"      DB_PASSWORD: s3cr3t-db-password",
	"    volumes:",
	"      - /var/run/docker.sock:/var/run/docker.sock",
	"      - /home/alice/private:/data",
	"",
].join("\n");

const entity = (composeFile = RAW) =>
	({
		composeId: "compose-1",
		appName: "app-xyz",
		composeType: "docker-compose",
		composePath: "./docker-compose.yml",
		composeFile,
		sourceType: "raw",
		serverId: null,
		command: "",
		domains: [],
		environment: { project: { organizationId: "org-1" } },
	}) as unknown as Parameters<typeof runComposePolicyAudit>[0];

const deployment = { deploymentId: "dep-1", logPath: "/var/log/dep-1.log" };

const organizationRow = (row: unknown) =>
	vi.mocked(db.query.organization.findFirst).mockResolvedValue(row as never);

const insertedRows = () => {
	const values = vi.fn().mockResolvedValue(undefined);
	vi.mocked(db.insert).mockImplementation((() => ({ values })) as never);
	return values;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.evaluateComposePolicy.mockImplementation(mocks.actualEvaluate);
	mocks.appendLogLine.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("with the setting off (the default)", () => {
	it.each([
		["no organization row", undefined],
		["the column off", { restrictedComposeAudit: false }],
		["the column missing", {}],
	])("%s: nothing is evaluated and nothing is written", async (_name, row) => {
		organizationRow(row);
		const values = insertedRows();

		await runComposePolicyAudit(entity(), deployment);

		expect(mocks.evaluateComposePolicy).not.toHaveBeenCalled();
		expect(mocks.appendLogLine).not.toHaveBeenCalled();
		expect(db.insert).not.toHaveBeenCalled();
		expect(values).not.toHaveBeenCalled();
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("does not even look at the compose of an entity without an organization", async () => {
		organizationRow({ restrictedComposeAudit: true });
		const noOrganization = {
			...entity(),
			environment: { project: {} },
		} as unknown as Parameters<typeof runComposePolicyAudit>[0];

		await runComposePolicyAudit(noOrganization, deployment);

		expect(db.query.organization.findFirst).not.toHaveBeenCalled();
		expect(mocks.evaluateComposePolicy).not.toHaveBeenCalled();
	});
});

describe("an excluded compose", () => {
	it("is skipped: no evaluation, no log line, no row", async () => {
		organizationRow({
			restrictedComposeAudit: true,
			restrictedComposeAuditExclusions: [{ id: "compose-1" }],
		});
		const values = insertedRows();

		await runComposePolicyAudit(entity(), deployment);

		expect(mocks.evaluateComposePolicy).not.toHaveBeenCalled();
		expect(mocks.appendLogLine).not.toHaveBeenCalled();
		expect(values).not.toHaveBeenCalled();
	});

	it("only skips the compose on the list", async () => {
		organizationRow({
			restrictedComposeAudit: true,
			restrictedComposeAuditExclusions: [{ id: "another-compose" }],
		});
		const values = insertedRows();

		await runComposePolicyAudit(entity(), deployment);

		expect(mocks.evaluateComposePolicy).toHaveBeenCalledTimes(1);
		expect(values).toHaveBeenCalledTimes(1);
	});
});

describe("with the setting on", () => {
	beforeEach(() => {
		organizationRow({
			restrictedComposeAudit: true,
			restrictedComposeAuditExclusions: [],
		});
	});

	it("writes one log line per finding and one row per (service, rule)", async () => {
		const values = insertedRows();

		await runComposePolicyAudit(entity(), deployment);

		expect(mocks.appendLogLine).toHaveBeenCalledTimes(1);
		const [serverId, logPath, text] = mocks.appendLogLine.mock.calls[0] as [
			string | null,
			string,
			string,
		];
		expect(serverId).toBeNull();
		expect(logPath).toBe("/var/log/dep-1.log");
		expect(text).toContain(
			"[restricted-compose audit] would refuse: service=web rule=host-privilege",
		);
		expect(text).toContain(
			"[restricted-compose audit] would refuse: service=web rule=docker-socket-bind",
		);
		expect(text).toContain(
			"[restricted-compose audit] would refuse: service=web rule=foreign-host-bind",
		);

		expect(values).toHaveBeenCalledTimes(1);
		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows.map((row) => row.ruleId).sort()).toEqual([
			"docker-socket-bind",
			"foreign-host-bind",
			"host-privilege",
		]);
		for (const row of rows) {
			expect(row).toMatchObject({
				organizationId: "org-1",
				composeId: "compose-1",
				deploymentId: "dep-1",
				serviceName: "web",
			});
		}
	});

	it("never writes a secret, to the log or to the table", async () => {
		const values = insertedRows();

		await runComposePolicyAudit(entity(), deployment);

		const written = JSON.stringify([
			mocks.appendLogLine.mock.calls,
			values.mock.calls,
		]);
		for (const secret of ["s3cr3t-db-password", "DB_PASSWORD", "/home/alice"]) {
			expect(written, secret).not.toContain(secret);
		}
	});

	it("says so when there is nothing to report, and writes no row", async () => {
		const values = insertedRows();

		await runComposePolicyAudit(
			entity("services:\n  web:\n    image: nginx\n"),
			deployment,
		);

		expect(mocks.appendLogLine.mock.calls[0]?.[2]).toBe(
			"[restricted-compose audit] evaluated: no findings",
		);
		expect(values).not.toHaveBeenCalled();
	});

	it("records a file that does not parse as one finding, never as an error", async () => {
		const values = insertedRows();

		await runComposePolicyAudit(
			entity("services:\n  web: [unclosed\n"),
			deployment,
		);

		expect(mocks.warn).not.toHaveBeenCalled();
		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows).toEqual([
			expect.objectContaining({
				serviceName: "<compose>",
				ruleId: "unparseable-compose",
			}),
		]);
	});

	it("stores a null deployment id when the deploy has none", async () => {
		const values = insertedRows();

		await runComposePolicyAudit(entity(), { logPath: "/var/log/x.log" });

		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows.every((row) => row.deploymentId === null)).toBe(true);
	});
});

describe("a failure never reaches the deploy", () => {
	beforeEach(() => {
		organizationRow({ restrictedComposeAudit: true });
	});

	it("an evaluator that throws is one warning and nothing else", async () => {
		const values = insertedRows();
		mocks.evaluateComposePolicy.mockImplementation(() => {
			throw new Error("boom with a secret: hunter2");
		});

		await expect(
			runComposePolicyAudit(entity(), deployment),
		).resolves.toBeUndefined();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.appendLogLine).not.toHaveBeenCalled();
		expect(values).not.toHaveBeenCalled();
	});

	it("a database that fails on the setting is one warning", async () => {
		vi.mocked(db.query.organization.findFirst).mockRejectedValue(
			new Error("connection refused"),
		);

		await expect(
			runComposePolicyAudit(entity(), deployment),
		).resolves.toBeUndefined();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.evaluateComposePolicy).not.toHaveBeenCalled();
	});

	it("a failing insert is one warning", async () => {
		const values = vi.fn().mockRejectedValue(new Error("disk full"));
		vi.mocked(db.insert).mockImplementation((() => ({ values })) as never);

		await expect(
			runComposePolicyAudit(entity(), deployment),
		).resolves.toBeUndefined();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});

	it("a log write that throws is one warning", async () => {
		insertedRows();
		mocks.appendLogLine.mockRejectedValue(new Error("no space left"));

		await expect(
			runComposePolicyAudit(entity(), deployment),
		).resolves.toBeUndefined();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});

	it("a step that never finishes is given up on after the timeout", async () => {
		vi.useFakeTimers();
		vi.mocked(db.query.organization.findFirst).mockReturnValue(
			new Promise(() => {}) as never,
		);

		const audit = runComposePolicyAudit(entity(), deployment);
		await vi.advanceTimersByTimeAsync(AUDIT_TIMEOUT_MS + 1);

		await expect(audit).resolves.toBeUndefined();
		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(AUDIT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
	});

	it("keeps the warning short, whatever the error says", async () => {
		mocks.evaluateComposePolicy.mockImplementation(() => {
			throw new Error("x".repeat(5_000));
		});

		await runComposePolicyAudit(entity(), deployment);

		const [, message] = mocks.warn.mock.calls[0] as [unknown, string];
		expect(message.length).toBeLessThan(400);
	});
});
