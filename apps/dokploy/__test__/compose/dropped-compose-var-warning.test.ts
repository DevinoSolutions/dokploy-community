import {
	getBuildComposeCommand,
	getDroppedDotenvNames,
} from "@dokploy/server/utils/builders/compose";
import { getDroppedDotenvNotice } from "@dokploy/server/utils/docker/env-file";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
}));
// The env is staged on the host; this suite reads the script, not the file.
vi.mock("@dokploy/server/utils/docker/staging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/staging")
	>()),
	stageFiles: vi.fn().mockResolvedValue(undefined),
}));

const baseCompose = {
	appName: "dropped-var",
	sourceType: "raw",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	createEnvFile: true,
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Parameters<typeof getBuildComposeCommand>[0];

describe("COMPOSE_* variables left out of the .env (T-10377)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("names the variable and the settings that are written", () => {
		const text = getDroppedDotenvNotice(["COMPOSE_ENV_FILE"]);
		expect(text).toMatch(/^COMPOSE_ENV_FILE was left out of \.env: /);
		expect(text).toContain("COMPOSE_PROFILES");
		expect(text).toContain("Rename the variable");
		expect(text).not.toContain("\n");
	});

	it("lists several in one line and says nothing for none", () => {
		const text = getDroppedDotenvNotice(["COMPOSE_FILE", "COMPOSE_ENV_FILE"]);
		expect(text).toMatch(/^COMPOSE_FILE, COMPOSE_ENV_FILE were left out/);
		expect(getDroppedDotenvNotice([])).toBe("");
	});

	it("finds the dropped names from the Environment, sorted, without values", () => {
		const names = getDroppedDotenvNames({
			...baseCompose,
			env: "COMPOSE_FILE=/secret\nCOMPOSE_ENV_FILE=x\nCOMPOSE_PROFILES=web\nA=1",
		});
		expect(names).toEqual(["COMPOSE_ENV_FILE", "COMPOSE_FILE"]);
		expect(
			getDroppedDotenvNames({
				...baseCompose,
				env: "COMPOSE_FILE=/x",
				createEnvFile: false,
			}),
		).toEqual([]);
		expect(
			getDroppedDotenvNames({ ...baseCompose, env: "COMPOSE_PROFILES=web" }),
		).toEqual([]);
	});

	it("puts the line in the deploy script, with no value in it", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			env: "COMPOSE_ENV_FILE=hunter2\nA=1",
		});
		expect(command).toContain("COMPOSE_ENV_FILE was left out of .env");
		expect(command).not.toContain("hunter2");
	});

	it("adds no line when nothing is dropped or the .env is not written", async () => {
		const kept = await getBuildComposeCommand({
			...baseCompose,
			env: "COMPOSE_PROFILES=web\nA=1",
		});
		expect(kept).not.toContain("left out of .env");
		const off = await getBuildComposeCommand({
			...baseCompose,
			createEnvFile: false,
			env: "COMPOSE_ENV_FILE=x",
		});
		expect(off).not.toContain("left out of .env");
	});
});
