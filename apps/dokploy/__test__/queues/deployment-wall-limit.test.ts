import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wall limit the progress marks of a deployment name (T-12495): the
 * watchdog's own limit, and nothing when the watchdog would not act on it.
 */

const mocks = vi.hoisted(() => ({
	isCloud: { value: false },
	deploymentsFindFirst: vi.fn(),
	getWebServerSettings: vi.fn(),
}));

vi.mock("@dokploy/server/constants", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/constants")
	>("@dokploy/server/constants");
	return {
		...actual,
		get IS_CLOUD() {
			return mocks.isCloud.value;
		},
	};
});
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { deployments: { findFirst: mocks.deploymentsFindFirst } },
	},
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));

import { getDeploymentWallLimitMinutes } from "@dokploy/server/services/deployment-cancel";

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.isCloud.value = false;
	mocks.deploymentsFindFirst.mockResolvedValue({
		applicationId: "app-1",
		composeId: null,
	});
	mocks.getWebServerSettings.mockResolvedValue({
		deploymentWatchdogEnabled: true,
		deploymentWatchdogIdleMinutes: 20,
		deploymentWatchdogMaxMinutes: 180,
		deploymentWatchdogExclusions: [],
	});
});

describe("getDeploymentWallLimitMinutes", () => {
	it("is the wall limit from the settings", async () => {
		expect(await getDeploymentWallLimitMinutes("dep-1")).toBe(180);
	});

	it("follows a changed setting", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogEnabled: true,
			deploymentWatchdogIdleMinutes: 20,
			deploymentWatchdogMaxMinutes: 240,
			deploymentWatchdogExclusions: [],
		});

		expect(await getDeploymentWallLimitMinutes("dep-1")).toBe(240);
	});

	it("is none when the watchdog is off", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogEnabled: false,
			deploymentWatchdogMaxMinutes: 180,
		});

		expect(await getDeploymentWallLimitMinutes("dep-1")).toBeNull();
	});

	it("is none for a service the watchdog never touches", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			deploymentWatchdogEnabled: true,
			deploymentWatchdogMaxMinutes: 180,
			deploymentWatchdogExclusions: [{ type: "application", id: "app-1" }],
		});

		expect(await getDeploymentWallLimitMinutes("dep-1")).toBeNull();
	});

	it("is none in cloud, where the watchdog does not run, without reading anything", async () => {
		mocks.isCloud.value = true;

		expect(await getDeploymentWallLimitMinutes("dep-1")).toBeNull();
		expect(mocks.getWebServerSettings).not.toHaveBeenCalled();
	});

	it("is none without a deployment id", async () => {
		expect(await getDeploymentWallLimitMinutes(undefined)).toBeNull();
		expect(mocks.getWebServerSettings).not.toHaveBeenCalled();
	});

	it("is none when the settings cannot be read, instead of failing the step", async () => {
		mocks.getWebServerSettings.mockRejectedValue(new Error("db down"));

		expect(await getDeploymentWallLimitMinutes("dep-1")).toBeNull();
	});
});
