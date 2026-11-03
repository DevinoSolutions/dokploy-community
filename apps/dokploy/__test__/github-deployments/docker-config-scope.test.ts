import { quote } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ghcr.io login of a service that follows GitHub Deployments lives in a
 * docker config dir of its own and is used by that service's pull / up only.
 * Nothing here may touch the host's default docker config.
 */

const mocks = vi.hoisted(() => ({
	loadGhcrCredentials: vi.fn(),
	runDockerLogin: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
}));

vi.mock("@dokploy/server/services/github-deployments/store", () => ({
	loadGhcrCredentials: mocks.loadGhcrCredentials,
}));
vi.mock("@dokploy/server/utils/process/dockerLogin", () => ({
	runDockerLogin: mocks.runDockerLogin,
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));
vi.mock("@dokploy/server/utils/aws/ecr", () => ({ getECRAuthToken: vi.fn() }));

import { getSafeRegistryLoginCommand } from "@dokploy/server/db/schema";
import { getGhcrConfigDirRemovalCommandForPath } from "@dokploy/server/services/github-deployments/registry-auth";
import { getCleanEnvPrefix as cleanPrefix } from "@dokploy/server/utils/builders/compose";
import { getRollingReplaceScript } from "@dokploy/server/utils/builders/compose-rolling";
import {
	getNeutralisedCliEnv,
	NEUTRALISED_CLI_ENV,
} from "@dokploy/server/utils/docker/env-file";
import { buildRemoteDocker } from "@dokploy/server/utils/providers/docker";

const IMAGE = "ghcr.io/devinosolutions/sendly-web@sha256:abc";
const credentials = {
	watchId: "w_1-Abc",
	owner: "DevinoSolutions",
	registryUrl: "ghcr.io",
	username: "amin",
	password: "gho_secret",
};
const application = (overrides: Record<string, unknown> = {}) =>
	({
		applicationId: "app-1",
		dockerImage: IMAGE,
		registryUrl: null,
		username: null,
		password: null,
		registry: null,
		...overrides,
	}) as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadGhcrCredentials.mockResolvedValue(credentials);
	mocks.runDockerLogin.mockResolvedValue(undefined);
});

describe("application pull", () => {
	it("logs in to the watch's config dir and pulls with --config pointing at it", async () => {
		const command = await buildRemoteDocker(application(), null);
		const dir = mocks.runDockerLogin.mock.calls[0]?.[0].configDir as string;
		expect(dir).toMatch(/\/docker-config\/ghcr-w_1-Abc$/);
		expect(command).toContain(
			`docker --config ${quote([dir])} pull ${quote([IMAGE])}`,
		);
	});

	it("deletes the watch's dir once the pull has ended: after a pull that worked and before the exit of one that failed", async () => {
		const command = await buildRemoteDocker(application(), null);
		const dir = mocks.runDockerLogin.mock.calls[0]?.[0].configDir as string;
		const rm = `${getGhcrConfigDirRemovalCommandForPath(dir)};`;
		expect(command.split(rm)).toHaveLength(3);
		const pull = command.indexOf(" pull ");
		const failedBranch = command.indexOf("Pulling image failed");
		const exit = command.indexOf("exit 1");
		// failure branch: removal sits between the message and the exit.
		expect(command.indexOf(rm, failedBranch)).toBeGreaterThan(failedBranch);
		expect(command.indexOf(rm, failedBranch)).toBeLessThan(exit);
		// success path: a second removal after the whole pull command.
		expect(command.lastIndexOf(rm)).toBeGreaterThan(exit);
		expect(command.lastIndexOf(rm)).toBeGreaterThan(pull);
		expect(command.lastIndexOf(rm)).toBeLessThan(
			command.indexOf("Pulling image completed"),
		);
	});

	it("deletes nothing when no GitHub login was made", async () => {
		mocks.loadGhcrCredentials.mockResolvedValue(null);
		const command = await buildRemoteDocker(application(), null);
		expect(command).not.toContain("rm -rf");
	});

	it("the login command itself names --config: nothing is written to the default config", async () => {
		await buildRemoteDocker(application(), "server-1");
		const data = mocks.runDockerLogin.mock.calls[0]?.[0];
		const { command, stdin } = getSafeRegistryLoginCommand(data);
		expect(command).toContain(
			`docker --config '${data.configDir}' login 'ghcr.io'`,
		);
		expect(command).not.toMatch(/(^|&& )docker login/);
		// The token travels on stdin, never in the command line.
		expect(command).not.toContain("gho_secret");
		expect(stdin).toBe("gho_secret");
	});

	it("pulls with the plain docker command when there is no watch, and logs in nowhere", async () => {
		mocks.loadGhcrCredentials.mockResolvedValue(null);
		const command = await buildRemoteDocker(application(), null);
		expect(command).toContain(`docker pull ${quote([IMAGE])}`);
		expect(command).not.toContain("--config");
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("does not offer the login to another owner's ghcr.io image", async () => {
		const command = await buildRemoteDocker(
			application({ dockerImage: "ghcr.io/someone-else/app@sha256:abc" }),
			null,
		);
		expect(command).not.toContain("--config");
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("reads no credential for an image that is not on ghcr.io", async () => {
		await buildRemoteDocker(application({ dockerImage: "nginx:1" }), null);
		expect(mocks.loadGhcrCredentials).not.toHaveBeenCalled();
	});
});

describe("compose up", () => {
	const DIR = "/etc/dokploy/docker-config/ghcr-w_1-Abc";

	it("leaves DOCKER_CONFIG empty (the default config) unless a dir is given", () => {
		expect(getNeutralisedCliEnv()).toBe(NEUTRALISED_CLI_ENV);
		expect(cleanPrefix()).toContain(" DOCKER_CONFIG= ");
	});

	it("points only DOCKER_CONFIG at the dir and keeps every other setting neutralised", () => {
		const env = getNeutralisedCliEnv(DIR);
		expect(env).toContain(`DOCKER_CONFIG=${DIR}`);
		expect(env).toContain("DOCKER_HOST= ");
		expect(env).toContain("LD_PRELOAD=");
		expect(env.replace(`DOCKER_CONFIG=${DIR}`, "DOCKER_CONFIG=")).toBe(
			NEUTRALISED_CLI_ENV,
		);
		const prefix = cleanPrefix(undefined, DIR);
		expect(prefix).toContain(`DOCKER_CONFIG=${DIR}`);
		expect(prefix).not.toContain(" DOCKER_CONFIG= ");
		expect(prefix).toContain('HOME="$HOME"');
	});

	it("quotes a dir that needs it", () => {
		expect(getNeutralisedCliEnv("/a b/c")).toContain("DOCKER_CONFIG='/a b/c'");
	});

	it("the rolling replace pulls and ups with the same dir", () => {
		const options = {
			appName: "app",
			invocation: "compose -p app -f docker-compose.yml",
			services: ["web"],
			remoteBuild: false,
			pullAlways: true,
			healthTimeoutSeconds: 60,
			drainSeconds: 0,
		};
		const plain = getRollingReplaceScript(options).definitions;
		expect(plain).not.toContain(`DOCKER_CONFIG=${DIR}`);
		expect(plain).toContain("DOCKER_CONFIG= ");
		const scoped = getRollingReplaceScript({
			...options,
			dockerConfigDir: DIR,
		}).definitions;
		expect(scoped.split(`DOCKER_CONFIG=${DIR}`)).toHaveLength(3);
		expect(scoped).not.toContain(" DOCKER_CONFIG= ");
	});
});
