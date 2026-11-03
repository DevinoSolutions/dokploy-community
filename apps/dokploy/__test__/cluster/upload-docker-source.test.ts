import { quote } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A docker-source application deploys the image reference it was given
 * (getImageName returns dockerImage itself), so re-pushing that image to the
 * linked registry is dead weight, and with an @digest reference `docker tag`
 * fails the whole deploy ("refusing to create a tag with a digest reference").
 */

const DIGEST_IMAGE =
	"localhost:5000/registry.devino.ca/caly-mcp@sha256:36ff0000000000000000000000000000000000000000000000000000000036ff";
const SKIP_LINE =
	"docker-source application: the service pulls its own image reference, nothing to re-push";

const mocks = vi.hoisted(() => ({
	runDockerLogin: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	findAllDeploymentsByApplicationId: vi.fn(),
	createRollback: vi.fn(),
	buildRemoteDocker: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/dockerLogin", () => ({
	runDockerLogin: mocks.runDockerLogin,
}));
vi.mock("@dokploy/server/utils/providers/docker", () => ({
	buildRemoteDocker: mocks.buildRemoteDocker,
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	findAllDeploymentsByApplicationId: mocks.findAllDeploymentsByApplicationId,
}));
vi.mock("@dokploy/server/services/rollbacks", () => ({
	createRollback: mocks.createRollback,
}));
vi.mock("@dokploy/server/utils/aws/ecr", () => ({
	getECRAuthToken: vi.fn(),
}));

import { uploadImageRemoteCommand } from "@dokploy/server/utils/cluster/upload";

const registryRow = {
	registryId: "reg-1",
	registryName: "main",
	registryType: "cloud",
	registryUrl: "registry.example.com",
	username: "acme",
	password: "pw",
	imagePrefix: null,
	awsAccessKeyId: null,
	awsSecretAccessKey: null,
	awsRegion: null,
};

const baseApplication = {
	appName: "my-app",
	applicationId: "app-1",
	registry: { registryId: "reg-1" },
	buildRegistry: null,
	rollbackRegistry: null,
	rollbackActive: false,
	dockerImage: DIGEST_IMAGE,
};

const asApplication = (overrides: Record<string, unknown>) =>
	({ ...baseApplication, ...overrides }) as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.runDockerLogin.mockResolvedValue(undefined);
	mocks.findRegistryByIdWithCredentials.mockResolvedValue(registryRow);
	mocks.findAllDeploymentsByApplicationId.mockResolvedValue([
		{ deploymentId: "dep-1" },
	]);
	mocks.createRollback.mockResolvedValue({ image: "my-app:v1" });
	mocks.buildRemoteDocker.mockResolvedValue("echo PULL_MARKER");
});

describe("uploadImageRemoteCommand for docker-source applications", () => {
	it("does not tag or push when a deploy registry is linked, and says so", async () => {
		const script = await uploadImageRemoteCommand(
			asApplication({ sourceType: "docker" }),
			null,
		);

		expect(script).toContain(SKIP_LINE);
		expect(script).not.toContain("docker tag");
		expect(script).not.toContain("docker push");
		expect(script).not.toContain("dokploy_push_retry");
		expect(mocks.findRegistryByIdWithCredentials).not.toHaveBeenCalled();
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("does not tag or push for a build registry either", async () => {
		const script = await uploadImageRemoteCommand(
			asApplication({
				sourceType: "docker",
				registry: null,
				buildRegistry: { registryId: "reg-1" },
			}),
			"srv-1",
		);

		expect(script).toContain(SKIP_LINE);
		expect(script).not.toContain("docker tag");
		expect(script).not.toContain("docker push");
		expect(mocks.findRegistryByIdWithCredentials).not.toHaveBeenCalled();
		expect(mocks.runDockerLogin).not.toHaveBeenCalled();
	});

	it("pulls, then pushes the rollback image for a digest reference", async () => {
		const script = await uploadImageRemoteCommand(
			asApplication({
				sourceType: "docker",
				registry: null,
				rollbackRegistry: { registryId: "reg-1" },
				rollbackActive: true,
			}),
			null,
		);

		expect(mocks.buildRemoteDocker).toHaveBeenCalledTimes(1);
		expect(script).toContain("Enabled Rollback Registry");
		expect(script.indexOf("PULL_MARKER")).toBeGreaterThan(-1);
		expect(script.indexOf("PULL_MARKER")).toBeLessThan(
			script.indexOf("docker tag"),
		);
		expect(script).toContain(
			`docker tag ${quote([DIGEST_IMAGE])} ${quote(["registry.example.com/acme/my-app:v1"])}`,
		);
		expect(script).toContain("dokploy_push_retry");
	});

	it("pulls, then pushes the rollback image for a tag reference", async () => {
		const script = await uploadImageRemoteCommand(
			asApplication({
				sourceType: "docker",
				registry: null,
				dockerImage: "nginx:1.27",
				rollbackRegistry: { registryId: "reg-1" },
				rollbackActive: true,
			}),
			null,
		);

		expect(mocks.buildRemoteDocker).toHaveBeenCalledTimes(1);
		expect(script.indexOf("PULL_MARKER")).toBeLessThan(
			script.indexOf("docker tag"),
		);
		expect(script).toContain(
			`docker tag ${quote(["nginx:1.27"])} ${quote(["registry.example.com/acme/my-app:v1"])}`,
		);
		expect(script).toContain("dokploy_push_retry");
	});
});

describe("uploadImageRemoteCommand for other sources", () => {
	it("keeps tagging and pushing the built image to the linked registry", async () => {
		const script = await uploadImageRemoteCommand(
			asApplication({ sourceType: "git", dockerImage: null }),
			null,
		);

		expect(script).not.toContain(SKIP_LINE);
		expect(script).toContain("Enabled Registry Swarm");
		expect(script).toContain(
			`docker tag ${quote(["my-app:latest"])} ${quote(["registry.example.com/acme/my-app:latest"])}`,
		);
		expect(script).toContain("docker push");
		expect(mocks.runDockerLogin).toHaveBeenCalledTimes(1);
		expect(mocks.buildRemoteDocker).not.toHaveBeenCalled();
	});
});
