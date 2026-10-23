import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRows = vi.hoisted(() => new Map<unknown, { appName: string }>());
const mockExec = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
vi.mock("@dokploy/server/db", () => ({
	db: {
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: unknown) => ({
					limit: async () => {
						mockWhere(table, condition);
						const row = mockRows.get(table);
						return row ? [row] : [];
					},
				}),
			}),
		}),
	},
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mockExec,
	execAsyncRemote: mockExec,
}));

import {
	applications,
	compose,
	libsql,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	containerBelongsToService,
	isOtherServiceAppName,
} from "@/server/wss/container-ownership";

const labels = (l: Record<string, string>) => ({ stdout: JSON.stringify(l) });

beforeEach(() => {
	vi.clearAllMocks();
	mockRows.clear();
	mockRows.set(applications, { appName: "app-mine-abc123" });
});

describe("containerBelongsToService", () => {
	it("allows a container of the service", async () => {
		mockExec.mockResolvedValue(
			labels({ "com.docker.swarm.service.name": "app-mine-abc123" }),
		);
		expect(await containerBelongsToService("svc", "c1")).toBe(true);
	});

	it("denies a container of another service", async () => {
		mockExec.mockResolvedValue(
			labels({ "com.docker.swarm.service.name": "dokploy" }),
		);
		expect(await containerBelongsToService("svc", "c1")).toBe(false);
	});

	it("denies containers without labels or when docker fails", async () => {
		mockExec.mockResolvedValue({ stdout: "null" });
		expect(await containerBelongsToService("svc", "c1")).toBe(false);
		mockExec.mockRejectedValue(new Error("No such object"));
		expect(await containerBelongsToService("svc", "c1")).toBe(false);
	});

	it("resolves libsql services", async () => {
		mockRows.clear();
		mockRows.set(libsql, { appName: "libsql-abc" });
		mockExec.mockResolvedValue(
			labels({ "com.docker.swarm.service.name": "libsql-abc" }),
		);
		expect(await containerBelongsToService("svc", "c1")).toBe(true);
	});

	it("denies an unknown service", async () => {
		mockRows.clear();
		expect(await containerBelongsToService("nope", "c1")).toBe(false);
	});

	it("inspects the container as a container, never as another docker object", async () => {
		mockExec.mockResolvedValue(
			labels({ "com.docker.swarm.service.name": "app-mine-abc123" }),
		);
		await containerBelongsToService("svc", "c1");
		const command = mockExec.mock.calls[0]?.[0] as string;
		expect(command).toContain("docker inspect --type container ");
		expect(command.endsWith(" c1")).toBe(true);
	});

	it("inspects the container on the given server when there is one", async () => {
		mockExec.mockResolvedValue(
			labels({ "com.docker.compose.project": "app-mine-abc123" }),
		);
		expect(await containerBelongsToService("svc", "c1", "srv-1")).toBe(true);
		expect(mockExec.mock.calls[0]?.[0]).toBe("srv-1");
	});
});

describe("isOtherServiceAppName", () => {
	const dialect = new PgDialect();
	// The mocked db returns a row whatever the condition says, so the tests
	// render the condition the query was built with.
	const conditionFor = (table: unknown) => {
		const call = mockWhere.mock.calls.find(([t]) => t === table);
		expect(call).toBeDefined();
		const { sql, params } = dialect.sqlToQuery(call?.[1]);
		return { sql: sql.replace(/\s+/g, " "), params };
	};

	it("is true when another service owns that name", async () => {
		mockRows.set(applications, { appName: "app-victim-abc123" });
		expect(await isOtherServiceAppName("app-victim-abc123", "svc")).toBe(true);
	});

	it("is false when no other service matches", async () => {
		mockRows.clear();
		expect(await isOtherServiceAppName("custom-name", "svc")).toBe(false);
	});

	it("matches names that start with the other appName, excluding the caller's service", async () => {
		mockRows.clear();
		await isOtherServiceAppName("custom-name", "svc");
		expect(conditionFor(compose)).toEqual({
			sql: '("compose"."composeId" <> $1 and starts_with($2, "compose"."appName"))',
			params: ["svc", "custom-name"],
		});
	});

	it("ignores services whose appName is a prefix of the caller's own for a project-form name", async () => {
		mockRows.clear();
		await isOtherServiceAppName("compose-abc-web-1", "svc", "compose-abc");
		expect(conditionFor(compose)).toEqual({
			sql: '("compose"."composeId" <> $1 and starts_with($2, "compose"."appName") and not starts_with($3, "compose"."appName"))',
			params: ["svc", "compose-abc-web-1", "compose-abc"],
		});
	});

	it("also checks preview deployments, other than the caller's own", async () => {
		mockRows.clear();
		await isOtherServiceAppName("custom-name", "svc");
		expect(conditionFor(previewDeployments)).toEqual({
			sql: '(("preview_deployments"."previewDeploymentId" <> $1 and "preview_deployments"."applicationId" is distinct from $2 and "preview_deployments"."composeId" is distinct from $3) and starts_with($4, "preview_deployments"."appName"))',
			params: ["svc", "svc", "svc", "custom-name"],
		});
		mockRows.set(previewDeployments, { appName: "preview-other-abc123" });
		expect(await isOtherServiceAppName("preview-other-abc123", "svc")).toBe(
			true,
		);
	});
});
