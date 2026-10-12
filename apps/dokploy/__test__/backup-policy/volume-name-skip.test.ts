import { apiCreateMount, apiUpdateMount } from "@dokploy/server/db/schema";
import { logger } from "@dokploy/server/lib/logger";
import {
	buildDesiredBackupRows,
	buildDesiredVolumeRows,
} from "@dokploy/server/services/backup-policy";
import { findMountsByApplicationId } from "@dokploy/server/services/mount";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/mount", () => ({
	findMountsByApplicationId: vi.fn(),
}));

vi.mock("@dokploy/server/lib/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const policy = {
	backupPolicyId: "policy-1",
	schedule: "0 0 * * *",
	prefix: "daily",
	keepLatestCount: null,
	enabled: true,
	destinationId: "dest-1",
	// biome-ignore lint/suspicious/noExplicitAny: minimal policy fixture
} as any;

const service = {
	id: "app-1",
	name: "web",
	appName: "web-abc",
	environmentId: "env-1",
	serverId: null,
	projectName: "Shop",
};

const mount = (type: string, volumeName: string | null) => ({
	type,
	volumeName,
});

describe("backup policy volume sync", () => {
	it("skips volumes docker would reject and logs them", async () => {
		vi.mocked(findMountsByApplicationId).mockResolvedValue([
			mount("volume", "data"),
			mount("volume", "x$(touch pwned)"),
			mount("volume", "-leading"),
			mount("volume", "a b"),
			mount("volume", "app_data.v1-2"),
			mount("bind", null),
			// biome-ignore lint/suspicious/noExplicitAny: minimal mount fixtures
		] as any);

		const plans = await buildDesiredVolumeRows(policy, {
			dump: {},
			volume: { application: [service] },
		});

		expect(plans.map((plan) => plan.insert.volumeName)).toEqual([
			"data",
			"app_data.v1-2",
		]);
		expect(logger.warn).toHaveBeenCalledTimes(3);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ volumeName: "x$(touch pwned)" }),
			expect.stringContaining("invalid name"),
		);
	});
});

describe("mount volume name validation", () => {
	const base = {
		type: "volume",
		mountPath: "/data",
		serviceId: "app-1",
		serviceType: "application",
	} as const;

	it("accepts valid volume names and leaves bind and file mounts alone", () => {
		for (const volumeName of ["data", "app_data.v1-2", undefined, ""]) {
			expect(apiCreateMount.safeParse({ ...base, volumeName }).success).toBe(
				true,
			);
		}
		expect(
			apiCreateMount.safeParse({
				...base,
				type: "bind",
				hostPath: "/srv/data",
			}).success,
		).toBe(true);
		expect(
			apiUpdateMount.safeParse({ mountId: "m-1", volumeName: "data" }).success,
		).toBe(true);
	});

	it("rejects names that are not valid docker volume names", () => {
		for (const volumeName of ["x$(id)", "x`id`", "a b", "-lead", 'a"b']) {
			expect(apiCreateMount.safeParse({ ...base, volumeName }).success).toBe(
				false,
			);
			expect(
				apiUpdateMount.safeParse({ mountId: "m-1", volumeName }).success,
			).toBe(false);
		}
	});
});

describe("backup policy service names", () => {
	it("keeps coverage for services with unsafe names but does not store the name", async () => {
		vi.mocked(logger.warn).mockClear();
		vi.mocked(findMountsByApplicationId).mockResolvedValue([
			{ type: "volume", volumeName: "data" },
			// biome-ignore lint/suspicious/noExplicitAny: minimal mount fixture
		] as any);
		const services = [
			service,
			{ ...service, id: "app-2", name: "My \"App\"" },
			{ ...service, id: "app-3", name: "cost $(id)" },
			{ ...service, id: "app-4", name: "My App 2" },
		];

		const dumps = buildDesiredBackupRows(policy, {
			dump: { postgres: services },
			volume: {},
		});
		expect(dumps.map((plan) => plan.insert.serviceName)).toEqual([
			"web",
			null,
			null,
			"My App 2",
		]);

		const volumes = await buildDesiredVolumeRows(policy, {
			dump: {},
			volume: { application: services },
		});
		expect(volumes.map((plan) => plan.insert.serviceName)).toEqual([
			"web",
			null,
			null,
			"My App 2",
		]);
		expect(logger.warn).toHaveBeenCalledTimes(4);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ serviceName: "cost $(id)" }),
			expect.stringContaining("invalid name"),
		);
	});
});
