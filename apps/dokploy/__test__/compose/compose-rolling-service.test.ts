import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service layer behind the settings card: the per-service report (what is
 * eligible and why not) and the save-time check that refuses a setting that
 * cannot work on the compose as it is now.
 */

const domain = vi.hoisted(() => ({
	addDomainToCompose: vi.fn(),
	cloneCompose: vi.fn().mockResolvedValue("true;"),
}));
vi.mock("@dokploy/server/utils/docker/domain", () => domain);

const exec = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	...exec,
}));

import {
	assertComposeRollingSettings,
	getComposeRollingReport,
} from "@dokploy/server/services/compose-rolling";

const healthcheck = {
	test: ["CMD", "true"],
	interval: "10s",
	timeout: "5s",
	retries: 3,
};

const composeRow = (overrides: Record<string, unknown> = {}) => ({
	composeId: "compose-1",
	appName: "stack",
	composeType: "docker-compose",
	command: "",
	serverId: null as string | null,
	domains: [],
	...overrides,
});

const useCompose = async (row: ReturnType<typeof composeRow>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(row as never);
};

const SPEC = {
	services: {
		web: { image: "x", healthcheck },
		api: { image: "y", ports: ["8080:80"], healthcheck },
		db: { image: "postgres:16" },
	},
};

beforeEach(async () => {
	vi.clearAllMocks();
	domain.addDomainToCompose.mockResolvedValue(SPEC);
	await useCompose(composeRow());
});

describe("getComposeRollingReport", () => {
	it("lists every service with its blockers", async () => {
		const report = await getComposeRollingReport("compose-1");
		if (!report.available) throw new Error("expected a report");
		const byName = Object.fromEntries(report.services.map((s) => [s.name, s]));
		expect(byName.web?.eligible).toBe(true);
		expect(byName.api?.eligible).toBe(false);
		expect(byName.api?.blockers.map((b) => b.code)).toEqual([
			"published-ports",
		]);
		expect(byName.db?.blockers.map((b) => b.code).sort()).toEqual([
			"no-healthcheck",
			"stateful-image",
		]);
		expect(report.stackWarnings).toEqual([]);
	});

	it("a healthcheck that cannot settle in the longest wait is reported", async () => {
		domain.addDomainToCompose.mockResolvedValue({
			services: {
				web: {
					image: "x",
					healthcheck: { test: ["CMD", "true"], interval: "5m", retries: 3 },
				},
			},
		});
		const report = await getComposeRollingReport("compose-1");
		if (!report.available) throw new Error("expected a report");
		expect(
			report.services
				.find((s) => s.name === "web")
				?.blockers.map((b) => b.code),
		).toEqual(["health-timeout-too-short"]);
	});

	it("reads from the cache by default and only clones on fetch", async () => {
		await getComposeRollingReport("compose-1");
		expect(domain.cloneCompose).not.toHaveBeenCalled();
		await getComposeRollingReport("compose-1", { type: "fetch" });
		expect(domain.cloneCompose).toHaveBeenCalledTimes(1);
		expect(exec.execAsync).toHaveBeenCalledWith("true;");
	});

	it("a stack gets the preflight warnings and every service is blocked", async () => {
		await useCompose(composeRow({ composeType: "stack" }));
		const report = await getComposeRollingReport("compose-1");
		if (!report.available) throw new Error("expected a report");
		expect(report.stackWarnings.map((w) => w.service)).toContain("web");
		expect(
			report.services.every((s) => s.blockers.some((b) => b.code === "stack")),
		).toBe(true);
	});

	it.each([
		["a compose file that is not there", null],
		["a spec without services", {}],
	])("%s: not available, with a reason", async (_name, spec) => {
		domain.addDomainToCompose.mockResolvedValue(spec);
		const report = await getComposeRollingReport("compose-1");
		expect(report.available).toBe(false);
		if (!report.available) expect(report.reason).toMatch(/not available/);
	});

	it("a spec that cannot be rendered carries the reason", async () => {
		domain.addDomainToCompose.mockRejectedValue(
			new Error("Domain x is broken"),
		);
		const report = await getComposeRollingReport("compose-1");
		expect(report).toEqual({ available: false, reason: "Domain x is broken" });
	});
});

describe("assertComposeRollingSettings (save time)", () => {
	const settings = (patch: Record<string, unknown> = {}) => ({
		enabled: true,
		services: ["web"],
		healthTimeoutSeconds: 120,
		drainSeconds: 5,
		...patch,
	});

	it("accepts an eligible selection", async () => {
		await expect(
			assertComposeRollingSettings("compose-1", settings()),
		).resolves.toBeUndefined();
	});

	it("a disabled setting is never checked", async () => {
		await expect(
			assertComposeRollingSettings(
				"compose-1",
				settings({ enabled: false, services: ["api"] }),
			),
		).resolves.toBeUndefined();
		expect(domain.addDomainToCompose).not.toHaveBeenCalled();
	});

	it("refuses an ineligible service and names the reason", async () => {
		await expect(
			assertComposeRollingSettings(
				"compose-1",
				settings({ services: ["web", "api"] }),
			),
		).rejects.toThrow(/api: .*host port is published/);
	});

	it("accepts a timeout shorter than the healthcheck settles: the wait is raised at deploy time", async () => {
		await expect(
			assertComposeRollingSettings(
				"compose-1",
				settings({ healthTimeoutSeconds: 30 }),
			),
		).resolves.toBeUndefined();
	});

	it("refuses a service that is not in the compose", async () => {
		await expect(
			assertComposeRollingSettings(
				"compose-1",
				settings({ services: ["nope"] }),
			),
		).rejects.toThrow(/no service "nope"/);
	});

	it("refuses when no service is selected", async () => {
		await expect(
			assertComposeRollingSettings("compose-1", settings({ services: [] })),
		).rejects.toThrow(/at least one service/);
	});

	it("checks against the type and command that are being saved, not the stored ones", async () => {
		await expect(
			assertComposeRollingSettings("compose-1", settings(), {
				composeType: "stack",
			}),
		).rejects.toThrow(/Only Docker Compose/);
		await expect(
			assertComposeRollingSettings("compose-1", settings(), {
				command: "compose up -d",
			}),
		).rejects.toThrow(/custom compose command/);
	});

	it("asks to load the services first when the compose file is not on disk yet", async () => {
		domain.addDomainToCompose.mockResolvedValue(null);
		await expect(
			assertComposeRollingSettings("compose-1", settings()),
		).rejects.toThrow(/Load the services first/);
	});
});
