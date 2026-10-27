import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the restricted-compose audit does in the background (T-7455): it reads
 * the compose file of a fetched compose and the `-f` override files of a custom
 * command with a size cap, tags every log line with the deployment id, deletes
 * the findings of the organization older than 90 days when it records a batch,
 * writes nothing once its overall cap has passed, and does not run on Cloud.
 */

const state = vi.hoisted(() => ({ composeRoot: "" }));

const mocks = vi.hoisted(() => ({
	appendLogLine: vi.fn().mockResolvedValue(undefined),
	warn: vi.fn(),
	info: vi.fn(),
	getCommandOverrideFiles: vi.fn(),
	getComposePath: vi.fn(),
	cloud: { value: false },
}));

vi.mock("@dokploy/server/services/deployment-cancel", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment-cancel")
	>("@dokploy/server/services/deployment-cancel");
	return { ...actual, appendLogLine: mocks.appendLogLine };
});
vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: mocks.warn, info: mocks.info, error: vi.fn() },
}));
// The own-directory check of the files (T-7845) is the real one's business: here
// every file the command names is in the compose's own directory.
vi.mock("@dokploy/server/services/compose-volume-binding", () => ({
	getReadableCommandOverrideFiles: async (
		...args: unknown[]
	) => ({
		files: (mocks.getCommandOverrideFiles(...args) as string[]).slice(
			0,
			args[1] as number,
		),
		skipped: 0,
	}),
}));
vi.mock("@dokploy/server/utils/docker/domain", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/docker/domain")
	>("@dokploy/server/utils/docker/domain");
	return { ...actual, getComposePath: mocks.getComposePath };
});
vi.mock("@dokploy/server/constants", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/constants")
	>("@dokploy/server/constants");
	return {
		...actual,
		get IS_CLOUD() {
			return mocks.cloud.value;
		},
		// The compose files of the tests live in the code directory of a compose
		// under the temp directory: the audit reads only inside it (T-7857).
		paths: (isServer = false) => ({
			...actual.paths(isServer),
			COMPOSE_PATH: state.composeRoot,
		}),
	};
});

import { db } from "@dokploy/server/db";
import {
	AUDIT_TIMEOUT_MS,
	runComposePolicyAudit,
	setComposePolicyAudit,
	setComposePolicyExclusion,
} from "@dokploy/server/services/compose-policy-audit";
import { COMPOSE_POLICY_MAX_BYTES } from "@dokploy/server/utils/compose-policy/config";

const directory = mkdtempSync(join(tmpdir(), "t7455-"));
state.composeRoot = join(directory, "compose");
// The checkout of the entity below.
const codeDirectory = join(state.composeRoot, "app-xyz", "code");
mkdirSync(codeDirectory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const deployment = { deploymentId: "dep-1", logPath: "/var/log/dep-1.log" };

const entity = (overrides: Record<string, unknown> = {}) =>
	({
		composeId: "compose-1",
		appName: "app-xyz",
		composeType: "docker-compose",
		composePath: "./docker-compose.yml",
		composeFile: "services:\n  web:\n    image: nginx\n",
		sourceType: "raw",
		serverId: null,
		command: "",
		domains: [],
		environment: { project: { organizationId: "org-1" } },
		...overrides,
	}) as unknown as Parameters<typeof runComposePolicyAudit>[0];

const enable = () =>
	vi
		.mocked(db.query.organization.findFirst)
		.mockResolvedValue({ restrictedComposeAudit: true } as never);

const insertSpy = () => {
	const values = vi.fn().mockResolvedValue(undefined);
	vi.mocked(db.insert).mockImplementation((() => ({ values })) as never);
	return values;
};

const written = () => String(mocks.appendLogLine.mock.calls[0]?.[2] ?? "");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cloud.value = false;
	mocks.appendLogLine.mockResolvedValue(undefined);
	mocks.getCommandOverrideFiles.mockReturnValue([]);
	enable();
});

describe("the log lines", () => {
	it("every line carries the deployment id", async () => {
		insertSpy();
		await runComposePolicyAudit(
			entity({
				composeFile:
					"services:\n  web:\n    privileged: true\n    network_mode: host\n    volumes:\n      - /etc:/e\n",
			}),
			deployment,
		);

		const lines = written().split("\n");
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(line.startsWith("[restricted-compose audit]"), line).toBe(true);
			expect(line, line).toContain("deployment=dep-1");
		}
	});

	it("says '-' when the deploy has no id", async () => {
		insertSpy();
		await runComposePolicyAudit(entity(), { logPath: "/var/log/x.log" });

		expect(written()).toContain("deployment=-");
	});

	it("names its own failure when the log cannot be written (not a cancellation)", async () => {
		insertSpy();
		await runComposePolicyAudit(entity(), deployment);

		expect(mocks.appendLogLine.mock.calls[0]?.[3]).toBe(
			"Could not write the restricted-compose audit to the deployment log",
		);
	});
});

describe("retention", () => {
	it("deletes the organization's findings older than 90 days after it records a batch", async () => {
		const values = insertSpy();
		const where = vi.fn().mockResolvedValue(undefined);
		vi.mocked(db.delete).mockImplementation((() => ({ where })) as never);
		const before = Date.now();

		await runComposePolicyAudit(
			entity({
				composeFile: "services:\n  web:\n    privileged: true\n",
			}),
			deployment,
		);

		expect(values).toHaveBeenCalledTimes(1);
		expect(db.delete).toHaveBeenCalledTimes(1);
		expect(where).toHaveBeenCalledTimes(1);
		// What the delete is bound to: this organization, rows before the cutoff.
		const { sql, params } = new PgDialect().sqlToQuery(
			where.mock.calls[0]?.[0],
		);
		expect(sql).toContain('"organizationId" = $1');
		expect(sql).toContain('"createdAt" < $2');
		expect(params[0]).toBe("org-1");
		// A timestamp column maps the Date to its ISO text.
		const days = (before - Date.parse(String(params[1]))) / 86_400_000;
		expect(days).toBeGreaterThan(89.9);
		expect(days).toBeLessThan(90.1);
	});

	it("deletes nothing when there is nothing to record", async () => {
		insertSpy();
		vi.mocked(db.delete).mockClear();

		await runComposePolicyAudit(entity(), deployment);

		expect(db.delete).not.toHaveBeenCalled();
	});
});

describe("files it reads", () => {
	it("evaluates the compose file of a fetched compose from disk", async () => {
		const file = join(codeDirectory, "docker-compose.yml");
		writeFileSync(file, "services:\n  web:\n    privileged: true\n");
		mocks.getComposePath.mockReturnValue(file);
		const values = insertSpy();

		await runComposePolicyAudit(
			entity({ sourceType: "git", composeFile: "" }),
			deployment,
		);

		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows.map((row) => row.ruleId)).toEqual(["host-privilege"]);
	});

	it("a compose file that cannot be read is nothing to evaluate, not a failure", async () => {
		mocks.getComposePath.mockReturnValue(join(codeDirectory, "missing.yml"));
		const values = insertSpy();

		await runComposePolicyAudit(
			entity({ sourceType: "git", composeFile: "" }),
			deployment,
		);

		expect(mocks.warn).not.toHaveBeenCalled();
		expect(values).not.toHaveBeenCalled();
		expect(written()).toContain("no findings");
	});

	it("a file above the cap is one finding, and is read only up to the cap", async () => {
		const file = join(codeDirectory, "huge.yml");
		writeFileSync(
			file,
			`services: [unclosed\n# ${"x".repeat(COMPOSE_POLICY_MAX_BYTES * 2)}\n`,
		);
		mocks.getComposePath.mockReturnValue(file);
		const values = insertSpy();

		await runComposePolicyAudit(
			entity({ sourceType: "git", composeFile: "" }),
			deployment,
		);

		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows).toEqual([
			expect.objectContaining({
				ruleId: "compose-too-large",
				serviceName: "<compose>",
			}),
		]);
	});

	it("evaluates the -f override files of a custom command", async () => {
		const override = join(codeDirectory, "override.yml");
		writeFileSync(
			override,
			"services:\n  web:\n    volumes:\n      - /var/run/docker.sock:/s\n",
		);
		mocks.getCommandOverrideFiles.mockReturnValue([override]);
		const values = insertSpy();

		await runComposePolicyAudit(
			entity({
				command: "docker compose -f docker-compose.yml -f override.yml up -d",
			}),
			deployment,
		);

		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows.map((row) => row.ruleId).sort()).toEqual([
			"custom-command",
			"docker-socket-bind",
		]);
	});

	it("an override file above the cap is one finding, and one that is gone is skipped", async () => {
		const huge = join(codeDirectory, "huge-override.yml");
		writeFileSync(huge, `# ${"x".repeat(COMPOSE_POLICY_MAX_BYTES * 2)}\n`);
		mocks.getCommandOverrideFiles.mockReturnValue([
			huge,
			join(codeDirectory, "gone.yml"),
		]);
		const values = insertSpy();

		await runComposePolicyAudit(
			entity({ command: "docker compose -f a.yml -f huge-override.yml up" }),
			deployment,
		);

		const rows = values.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
		expect(rows.map((row) => row.ruleId).sort()).toEqual([
			"compose-too-large",
			"custom-command",
		]);
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("a command the volume guard refuses to parse just has no override files", async () => {
		mocks.getCommandOverrideFiles.mockImplementation(() => {
			throw new Error("Compose command refused: it names no compose file");
		});
		insertSpy();

		await runComposePolicyAudit(
			entity({ command: "docker compose up -d" }),
			deployment,
		);

		expect(mocks.warn).not.toHaveBeenCalled();
		expect(written()).toContain("evaluated: 1 finding(s)");
	});

	it("does not look for override files when there is no custom command", async () => {
		insertSpy();

		await runComposePolicyAudit(entity(), deployment);

		expect(mocks.getCommandOverrideFiles).not.toHaveBeenCalled();
	});
});

describe("the overall cap", () => {
	it("writes nothing once the cap has passed, even if a step finishes late", async () => {
		vi.useFakeTimers();
		try {
			const values = insertSpy();
			let release: (value: unknown) => void = () => {};
			vi.mocked(db.query.organization.findFirst).mockReturnValue(
				new Promise((resolve) => {
					release = resolve;
				}) as never,
			);

			const audit = runComposePolicyAudit(entity(), deployment);
			await vi.advanceTimersByTimeAsync(AUDIT_TIMEOUT_MS + 1);
			await audit;
			expect(mocks.warn).toHaveBeenCalledTimes(1);

			// The slow step comes back after the cap: the audit must stay silent.
			release({ restrictedComposeAudit: true });
			await vi.advanceTimersByTimeAsync(50);

			expect(mocks.appendLogLine).not.toHaveBeenCalled();
			expect(values).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Dokploy Cloud", () => {
	it("does not run at all", async () => {
		mocks.cloud.value = true;
		const values = insertSpy();

		await runComposePolicyAudit(entity(), deployment);

		expect(db.query.organization.findFirst).not.toHaveBeenCalled();
		expect(mocks.appendLogLine).not.toHaveBeenCalled();
		expect(values).not.toHaveBeenCalled();
	});
});

describe("changes of the settings leave a server-log line (no licence needed)", () => {
	it("the organization switch: who, which organization, on or off", async () => {
		await setComposePolicyAudit("org-1", true, { userId: "user-1" });
		await setComposePolicyAudit("org-1", false, { userId: "user-2" });

		expect(mocks.info).toHaveBeenCalledTimes(2);
		expect(mocks.info.mock.calls[0]?.[0]).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			auditEnabled: true,
		});
		expect(String(mocks.info.mock.calls[0]?.[1])).toContain("turned on");
		expect(mocks.info.mock.calls[1]?.[0]).toMatchObject({
			userId: "user-2",
			auditEnabled: false,
		});
		expect(String(mocks.info.mock.calls[1]?.[1])).toContain("turned off");
	});

	it("an exclusion: who, which organization, which compose, on or off", async () => {
		await setComposePolicyExclusion("org-1", "compose-9", true, {
			userId: "user-1",
		});
		await setComposePolicyExclusion("org-1", "compose-9", false, {
			userId: "user-1",
		});

		expect(mocks.info.mock.calls[0]?.[0]).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			composeId: "compose-9",
			excluded: true,
		});
		expect(mocks.info.mock.calls[1]?.[0]).toMatchObject({ excluded: false });
	});
});
