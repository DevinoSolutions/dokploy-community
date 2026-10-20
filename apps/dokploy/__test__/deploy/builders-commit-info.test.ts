import { describe, expect, it, vi } from "vitest";

// The builders stage env files on the host that runs the build; these tests
// only read the generated command.
vi.mock("@dokploy/server/utils/docker/staging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/staging")
	>()),
	stageFiles: vi.fn(),
}));

import { getDockerCommand } from "@dokploy/server/utils/builders/docker-file";
import { getHerokuCommand } from "@dokploy/server/utils/builders/heroku";
import { getNixpacksCommand } from "@dokploy/server/utils/builders/nixpacks";
import { getPaketoCommand } from "@dokploy/server/utils/builders/paketo";
import { getRailpackCommand } from "@dokploy/server/utils/builders/railpack";
import {
	getCommitInfoBuildArgs,
	getCommitInfoEnvArgs,
	getGitCommitInfoCommands,
} from "@dokploy/server/utils/builders/utils";
import type { ApplicationNested } from "@dokploy/server/utils/builders";

const createMockApplication = (overrides = {}): ApplicationNested =>
	({
		appName: "test-app",
		buildType: "dockerfile" as const,
		env: null,
		buildArgs: null,
		buildSecrets: null,
		cleanCache: false,
		environment: {
			env: "",
			project: { env: "" },
		},
		...overrides,
	}) as unknown as ApplicationNested;

describe("Git Commit Info Helpers", () => {
	it("getGitCommitInfoCommands should return shell commands to extract commit info", () => {
		const commands = getGitCommitInfoCommands();
		expect(commands).toContain(
			"DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD",
		);
		expect(commands).toContain("DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD");
		expect(commands).toContain(
			"DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s",
		);
		expect(commands).toContain('|| echo "unknown"');
	});

	it("getCommitInfoBuildArgs should return --build-arg flags", () => {
		const args = getCommitInfoBuildArgs();
		expect(args).toContain(
			'--build-arg DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
		expect(args).toContain(
			'--build-arg DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(args).toContain(
			'--build-arg DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});

	it("getCommitInfoEnvArgs should return --env flags", () => {
		const args = getCommitInfoEnvArgs();
		expect(args).toContain('--env DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"');
		expect(args).toContain(
			'--env DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(args).toContain(
			'--env DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});
});

describe("Dockerfile builder - commit info injection", () => {
	it("should include git commit info extraction commands", async () => {
		const command = await getDockerCommand(createMockApplication());
		expect(command).toContain(
			"DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD",
		);
		expect(command).toContain("DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD");
		expect(command).toContain(
			"DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s",
		);
	});

	it("should pass commit info as --build-arg to docker build", async () => {
		const command = await getDockerCommand(createMockApplication());
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});

	it("should include commit info alongside user-defined build args", async () => {
		const command = await getDockerCommand(
			createMockApplication({ buildArgs: "MY_VAR=hello" }),
		);
		expect(command).toContain("--build-arg MY_VAR");
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
	});
});

describe("Nixpacks builder - commit info injection", () => {
	it("should include git commit info extraction commands", async () => {
		const command = await getNixpacksCommand(
			createMockApplication({ buildType: "nixpacks" }),
		);
		expect(command).toContain(
			"DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD",
		);
		expect(command).toContain("DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD");
		expect(command).toContain(
			"DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s",
		);
	});

	it("should pass commit info as --env to nixpacks build", async () => {
		const command = await getNixpacksCommand(
			createMockApplication({ buildType: "nixpacks" }),
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});
});

describe("Heroku builder - commit info injection", () => {
	it("should include git commit info extraction commands", async () => {
		const command = await getHerokuCommand(
			createMockApplication({ buildType: "heroku_buildpacks" }),
		);
		expect(command).toContain(
			"DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD",
		);
		expect(command).toContain("DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD");
		expect(command).toContain(
			"DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s",
		);
	});

	it("should pass commit info as --env to pack build", async () => {
		const command = await getHerokuCommand(
			createMockApplication({ buildType: "heroku_buildpacks" }),
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});
});

describe("Paketo builder - commit info injection", () => {
	it("should include git commit info extraction commands", async () => {
		const command = await getPaketoCommand(
			createMockApplication({ buildType: "paketo_buildpacks" }),
		);
		expect(command).toContain(
			"DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD",
		);
		expect(command).toContain("DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD");
		expect(command).toContain(
			"DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s",
		);
	});

	it("should pass commit info as --env to pack build", async () => {
		const command = await getPaketoCommand(
			createMockApplication({ buildType: "paketo_buildpacks" }),
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(command).toContain(
			'--env DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});
});

describe("Railpack builder - commit info injection", () => {
	it("should include git commit info extraction commands", async () => {
		const command = await getRailpackCommand(
			createMockApplication({ buildType: "railpack" }),
		);
		expect(command).toContain(
			"DOKPLOY_COMMIT_SHORT=$(git rev-parse --short HEAD",
		);
		expect(command).toContain("DOKPLOY_COMMIT_HASH=$(git rev-parse HEAD");
		expect(command).toContain(
			"DOKPLOY_COMMIT_MESSAGE=$(git log -1 --pretty=%s",
		);
	});

	it("should pass commit info as --build-arg to docker buildx", async () => {
		const command = await getRailpackCommand(
			createMockApplication({ buildType: "railpack" }),
		);
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_HASH="$DOKPLOY_COMMIT_HASH"',
		);
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_SHORT="$DOKPLOY_COMMIT_SHORT"',
		);
		expect(command).toContain(
			'--build-arg DOKPLOY_COMMIT_MESSAGE="$DOKPLOY_COMMIT_MESSAGE"',
		);
	});
});
