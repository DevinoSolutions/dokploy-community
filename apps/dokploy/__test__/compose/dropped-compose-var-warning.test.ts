import {
	getBuildComposeCommand,
	getDroppedDotenvNames,
} from "@dokploy/server/utils/builders/compose";
import { getDroppedDotenvNotice } from "@dokploy/server/utils/docker/env-file";
import { stageFiles } from "@dokploy/server/utils/docker/staging";
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

const count = (text: string) => text.match(/left out of \.env/g)?.length ?? 0;

describe("variables left out of the .env (T-10377)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("names the variable and the settings that are written", () => {
		const text = getDroppedDotenvNotice(["COMPOSE_ENV_FILE"]);
		expect(text).toMatch(
			/^Warning: ⚠️ COMPOSE_ENV_FILE was left out of \.env: /,
		);
		expect(text).toContain("COMPOSE_PROFILES");
		expect(text).not.toContain("COMPOSE_PREFIX");
		expect(text).toContain("Rename the variable");
		expect(text).not.toContain("\n");
	});

	it("lists several in one line and says nothing for none", () => {
		const text = getDroppedDotenvNotice(["COMPOSE_FILE", "COMPOSE_ENV_FILE"]);
		expect(text).toMatch(
			/^Warning: ⚠️ COMPOSE_FILE, COMPOSE_ENV_FILE were left out/,
		);
		expect(getDroppedDotenvNotice([])).toBe("");
	});

	it("gives names that are not COMPOSE_* their own reason", () => {
		const text = getDroppedDotenvNotice(["GOMAXPROCS"]);
		expect(text).toContain("GOMAXPROCS was left out of .env");
		expect(text).toContain("docker, compose or the shell read these names");
		expect(text).not.toContain("COMPOSE_* names");
		const both = getDroppedDotenvNotice(["COMPOSE_FILE", "HOME"]);
		expect(both).toContain("COMPOSE_* names");
		expect(both).toContain("HOME was left out");
		expect(both.match(/Warning/g)).toHaveLength(1);
	});

	it("caps a long list", () => {
		const names = Array.from({ length: 25 }, (_, i) => `COMPOSE_X${i}`);
		expect(getDroppedDotenvNotice(names)).toContain(
			"and 5 more were left out",
		);
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

	it("does not report Dokploy's own project name, and reads APP_NAME like the writer", () => {
		expect(
			getDroppedDotenvNames({
				...baseCompose,
				env: "COMPOSE_PROJECT_NAME=other\nURL=${{APP_NAME}}.example.com",
			}),
		).toEqual([]);
	});

	it("never throws: an Environment that cannot be prepared yields no names", () => {
		expect(
			getDroppedDotenvNames({
				...baseCompose,
				env: "COMPOSE_FILE=/x\nA=${{nothing.VAR}}",
			}),
		).toEqual([]);
	});

	it("does not list a COMPOSE_FILE= that sits inside a quoted multiline value", () => {
		expect(
			getDroppedDotenvNames({
				...baseCompose,
				env: 'A="x\nCOMPOSE_FILE=y"\nB=1',
			}),
		).toEqual([]);
	});

	it("lists exactly the names the written .env lacks", async () => {
		const env =
			"COMPOSE_FILE=/x\nCOMPOSE_PROFILES=web\nGOMAXPROCS=4\nHOME=/h\nOK=1\nDOCKER_HOST=h";
		await getBuildComposeCommand({ ...baseCompose, env });
		const staged = vi
			.mocked(stageFiles)
			.mock.calls.flatMap((call) => call[0].files)
			.find((file) => file.path.includes("stage-env"));
		const written = new Set(
			String(staged?.content)
				.split("\n")
				.map((line) => line.slice(0, line.indexOf("="))),
		);
		const inEnv = [
			"COMPOSE_FILE",
			"COMPOSE_PROFILES",
			"DOCKER_HOST",
			"GOMAXPROCS",
			"HOME",
			"OK",
		];
		const dropped = getDroppedDotenvNames({ ...baseCompose, env });
		expect(dropped).toEqual(inEnv.filter((name) => !written.has(name)));
		expect(dropped).toEqual(["COMPOSE_FILE", "GOMAXPROCS", "HOME"]);
	});

	it("puts one line in the deploy script, with no value in it", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			env: "COMPOSE_ENV_FILE=hunter2\nA=1",
		});
		expect(command).toContain("COMPOSE_ENV_FILE was left out of .env");
		expect(count(command)).toBe(1);
		expect(command).not.toContain("hunter2");
	});

	it("logs a stack's .env drops once, apart from its docker line", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			composeType: "stack",
			env: "COMPOSE_FILE=/x\nDOCKER_HOST=ssh://h\nA=1",
		});
		expect(count(command)).toBe(1);
		expect(command).toContain("COMPOSE_FILE was left out of .env");
		expect(command).toContain(
			"Not passed to docker, because docker and compose read them as their own settings: DOCKER_HOST",
		);
		expect(command).not.toContain("settings: COMPOSE_FILE");
	});

	it("does not report what Dokploy adds to a stack's Environment", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			composeType: "stack",
			randomize: true,
			suffix: "abc",
			createEnvFile: false,
			env: "A=1",
		});
		expect(command).not.toContain("Not passed to docker");
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

	it("does not fail the deploy script when the Environment cannot be prepared for the log", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			env: "URL=${{APP_NAME}}.example.com",
		});
		expect(command).not.toContain("left out of .env");
	});
});
