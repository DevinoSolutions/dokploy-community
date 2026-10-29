import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildComposeOverrideYaml,
	getBuiltImageRepoName,
	getBuiltImageTag,
	getComposeBuildCommand,
	getComposeBuildServiceCommand,
	getComposeBuildSettingsError,
	getComposeConfigJsonCommand,
	getTagAndPushCommand,
	getWriteFileCommand,
	parseBuiltServices,
	sanitizeImageRepoName,
} from "@dokploy/server/utils/builders/compose-remote-build";
import { quote } from "shell-quote";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { boundedBash, boundedShellAvailable } from "./helpers/bounded-shell";

vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
}));

const compose = {
	appName: "my-app",
	sourceType: "raw",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Parameters<typeof getComposeBuildCommand>[0];

describe("getComposeBuildSettingsError", () => {
	const buildServer = { serverType: "build" };

	it("accepts a compose without any build settings", () => {
		expect(getComposeBuildSettingsError({})).toBeNull();
		expect(
			getComposeBuildSettingsError({
				buildServerId: null,
				buildRegistryId: null,
			}),
		).toBeNull();
	});

	it("rejects a build server without a registry", () => {
		const message = getComposeBuildSettingsError({
			buildServerId: "srv",
			buildRegistryId: null,
			server: buildServer,
		});
		expect(message).toMatch(/must be set together/);
	});

	it("rejects a registry without a build server", () => {
		const message = getComposeBuildSettingsError({
			buildServerId: null,
			buildRegistryId: "reg",
			registry: {},
		});
		expect(message).toMatch(/must be set together/);
	});

	it("rejects a server whose type is not build", () => {
		const message = getComposeBuildSettingsError({
			buildServerId: "srv",
			buildRegistryId: "reg",
			server: { serverType: "deploy" },
			registry: {},
		});
		expect(message).toMatch(/not a build server/);
	});

	it("rejects a server or registry that does not exist", () => {
		expect(
			getComposeBuildSettingsError({
				buildServerId: "srv",
				buildRegistryId: "reg",
				server: null,
				registry: {},
			}),
		).toMatch(/build server was not found/);
		expect(
			getComposeBuildSettingsError({
				buildServerId: "srv",
				buildRegistryId: "reg",
				server: buildServer,
				registry: null,
			}),
		).toMatch(/registry was not found/);
	});

	it("rejects a custom command together with a build server", () => {
		const message = getComposeBuildSettingsError({
			buildServerId: "srv",
			buildRegistryId: "reg",
			command: "compose up -d",
			server: buildServer,
			registry: {},
		});
		expect(message).toMatch(/custom compose command/);
	});

	it("accepts a build server of type build with a registry", () => {
		expect(
			getComposeBuildSettingsError({
				buildServerId: "srv",
				buildRegistryId: "reg",
				server: buildServer,
				registry: {},
			}),
		).toBeNull();
	});
});

describe("parseBuiltServices", () => {
	it("returns only services with a build section", () => {
		const json = JSON.stringify({
			name: "my-app",
			services: {
				web: { build: { context: "." } },
				db: { image: "postgres:16" },
			},
		});
		expect(parseBuiltServices(json, "my-app")).toEqual([
			{ service: "web", localImage: "my-app-web" },
		]);
	});

	it("uses the explicit image name of a service that has image and build", () => {
		const json = JSON.stringify({
			name: "my-app",
			services: { api: { build: { context: "./api" }, image: "acme/api:dev" } },
		});
		expect(parseBuiltServices(json, "my-app")).toEqual([
			{ service: "api", localImage: "acme/api:dev" },
		]);
	});

	it("falls back to the app name when the config has no project name", () => {
		const json = JSON.stringify({ services: { web: { build: "." } } });
		expect(parseBuiltServices(json, "fallback")).toEqual([
			{ service: "web", localImage: "fallback-web" },
		]);
	});

	it("returns an empty list when nothing is built", () => {
		const json = JSON.stringify({
			name: "my-app",
			services: { db: { image: "postgres:16" } },
		});
		expect(parseBuiltServices(json, "my-app")).toEqual([]);
	});

	it("ignores notices printed before the JSON document", () => {
		const json = `WARN[0000] something is deprecated\n${JSON.stringify({
			name: "my-app",
			services: { web: { build: "." } },
		})}`;
		expect(parseBuiltServices(json, "my-app")).toHaveLength(1);
	});

	it("throws a readable error for output that is not JSON", () => {
		expect(() => parseBuiltServices("no config here", "x")).toThrow(
			/no JSON output/,
		);
		expect(() => parseBuiltServices("{ nope", "x")).toThrow(/Could not parse/);
	});
});

describe("image naming", () => {
	it("names the repository <appName>-<service>", () => {
		expect(getBuiltImageRepoName("my-app", "web")).toBe("my-app-web");
	});

	it("normalizes service names that are not valid repository names", () => {
		expect(sanitizeImageRepoName("My_App__Web")).toBe("my_app-web");
		expect(getBuiltImageRepoName("app", "Web Server")).toBe("app-web-server");
	});

	it("prefixes the deployment id so a leading dash cannot break the tag", () => {
		expect(getBuiltImageTag("-abc_DEF")).toBe("dpl--abc_DEF");
		expect(getBuiltImageTag("abc")).toBe("dpl-abc");
		expect(getBuiltImageTag("a".repeat(300)).length).toBeLessThanOrEqual(128);
	});
});

describe("buildComposeOverrideYaml", () => {
	const images = [
		{ service: "web", image: "reg.example.com/acme/my-app-web:dpl-1" },
		{ service: "worker", image: "reg.example.com/acme/my-app-worker:dpl-1" },
	];

	it("pins every built service to its pushed image for docker compose", () => {
		const parsed = parse(buildComposeOverrideYaml(images, "docker-compose"));
		expect(parsed.services.web).toEqual({
			image: "reg.example.com/acme/my-app-web:dpl-1",
			pull_policy: "missing",
		});
		expect(parsed.services.worker.image).toBe(
			"reg.example.com/acme/my-app-worker:dpl-1",
		);
	});

	it("carries the image alone for a swarm stack", () => {
		const parsed = parse(buildComposeOverrideYaml(images, "stack"));
		expect(parsed.services.web).toEqual({
			image: "reg.example.com/acme/my-app-web:dpl-1",
		});
	});
});

describe("getWriteFileCommand", () => {
	it("writes base64 content to a quoted path", () => {
		const command = getWriteFileCommand("/etc/dokploy/my app/x.yml", "a: 1\n");
		expect(command).toContain("mkdir -p");
		expect(command).toContain(Buffer.from("a: 1\n").toString("base64"));
		expect(command).toContain("base64 -d >");
		// The path contains a space, so it must be quoted or escaped.
		expect(command).not.toMatch(/> \/etc\/dokploy\/my app/);
	});
});

describe("build server commands", () => {
	it("config command prints the resolved compose configuration as JSON", () => {
		const command = getComposeConfigJsonCommand(compose, "/code");
		expect(command).toContain("cd /code");
		expect(command).toContain("docker compose -p my-app");
		expect(command.trim().endsWith("config --format json")).toBe(true);
		expect(command).toContain('env -i PATH="$PATH" HOME="$HOME"');
	});

	it("build command runs docker compose build and stops on failure", () => {
		const command = getComposeBuildCommand(compose, "/code");
		expect(command).toContain("set -e");
		expect(command).toContain("cd /code");
		expect(command).toMatch(/docker compose -p my-app .*-f .* build 2>&1/);
		expect(command).not.toContain(" up ");
	});

	it("passes the project directory when the compose has mounts", () => {
		const command = getComposeBuildCommand(compose, "/code", "/code");
		expect(command).toContain("--project-directory");
	});
});

describe("getTagAndPushCommand", () => {
	const images = [
		{
			service: "web",
			localImage: "my-app-web",
			ref: "reg.example.com/acme/my-app-web:dpl-1",
			latestRef: "reg.example.com/acme/my-app-web:latest",
		},
		{
			service: "api",
			localImage: "acme/api:dev",
			ref: "reg.example.com/acme/my-app-api:dpl-1",
			latestRef: "reg.example.com/acme/my-app-api:latest",
		},
	];
	const command = getTagAndPushCommand({
		images,
		registryLabel: "reg.example.com",
	});

	it("does not log in itself: the login runs beforehand, on stdin", () => {
		expect(command).not.toContain("docker login");
		expect(command).not.toContain("--password");
		expect(command).toContain("Registry Login Success");
	});

	it("tags and pushes both the deployment tag and :latest for every service", () => {
		for (const image of images) {
			expect(command).toContain(
				`docker tag ${quote([image.localImage])} ${quote([image.ref])}`,
			);
			expect(command).toContain(
				`docker tag ${quote([image.localImage])} ${quote([image.latestRef])}`,
			);
			expect(command).toContain(`docker push ${quote([image.ref])}`);
			expect(command).toContain(`docker push ${quote([image.latestRef])}`);
		}
		expect(command.match(/docker push /g)).toHaveLength(4);
	});

	it("fails when the build did not produce the expected image", () => {
		expect(command).toContain("docker image inspect my-app-web");
		expect(command).toContain("did not produce image");
	});

	it("prunes only dangling images and never volumes", () => {
		expect(command).toContain("docker image prune -f");
		expect(command).not.toMatch(/volume/i);
		expect(command).not.toMatch(/system prune/);
	});
});

describe("getTagAndPushCommand when an image vanished after the build", () => {
	const images = [
		{
			service: "web",
			localImage: "my-app-web",
			ref: "reg.example.com/acme/my-app-web:dpl-1",
			latestRef: "reg.example.com/acme/my-app-web:latest",
		},
	];
	const rebuildService = (service: string) =>
		getComposeBuildServiceCommand(compose, "/code", service);

	it("rebuilds only the missing service, then re-checks before tagging", () => {
		const command = getTagAndPushCommand({
			images,
			registryLabel: "reg.example.com",
			rebuildService,
		});
		const rebuild = command.indexOf("build web 2>&1");
		expect(rebuild).toBeGreaterThan(-1);
		expect(command.indexOf("docker image inspect my-app-web")).toBeLessThan(
			rebuild,
		);
		expect(
			command.lastIndexOf("docker image inspect my-app-web"),
		).toBeGreaterThan(rebuild);
		expect(rebuild).toBeLessThan(command.indexOf("docker tag my-app-web"));
		expect(command).toContain("did not produce image");
	});

	it("keeps the old fail-fast script when no rebuild is given", () => {
		const command = getTagAndPushCommand({
			images,
			registryLabel: "reg.example.com",
		});
		expect(command).not.toContain("rebuilding service");
		expect(command).toContain("did not produce image");
	});

	const bash =
		boundedShellAvailable &&
		boundedBash(["-c", "true"], { encoding: "utf8", timeout: 30_000 })
			.status === 0;

	// Runs the real script against a fake `docker`: inspect fails until the
	// compose build has run, so the script has to rebuild to get through.
	const runScript = (rebuildable: boolean, buildSucceeds = true) => {
		const dir = mkdtempSync(join(tmpdir(), "dokploy-push-"));
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const state = join(dir, "state");
		mkdirSync(state);
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				`echo "$@" >> '${state}/calls'`,
				'case "$1 $2" in',
				`  "image inspect") [ -f '${state}/built' ] ;;`,
				`  "compose -p") ${buildSucceeds ? `touch '${state}/built'` : "exit 1"} ;;`,
				"  *) exit 0 ;;",
				"esac",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const script = getTagAndPushCommand({
			images,
			registryLabel: "reg.example.com",
			rebuildService: rebuildable
				? (service) => getComposeBuildServiceCommand(compose, dir, service)
				: undefined,
		});
		const result = boundedBash(["-c", script], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
			encoding: "utf8",
			timeout: 60_000,
		});
		const calls = existsSync(join(state, "calls"))
			? readFileSync(join(state, "calls"), "utf8")
			: "";
		rmSync(dir, { recursive: true, force: true });
		return { ...result, calls };
	};

	it.skipIf(!bash)("runs: rebuilds, then tags and pushes", () => {
		const { status, stdout, calls } = runScript(true);
		expect(stdout).toContain("rebuilding service web from the layer cache");
		expect(stdout).toContain("web pushed");
		expect(status).toBe(0);
		expect(calls).toMatch(/compose -p my-app .* build web/);
		expect(calls).toContain(
			"tag my-app-web reg.example.com/acme/my-app-web:dpl-1",
		);
	});

	it.skipIf(!bash)("runs: still fails when the rebuild fails", () => {
		const { status, stdout, calls } = runScript(true, false);
		expect(status).not.toBe(0);
		expect(stdout).toContain("Rebuilding service web failed");
		expect(calls).not.toContain("push");
	});

	it.skipIf(!bash)("runs: without a rebuild the old error stands", () => {
		const { status, stdout } = runScript(false);
		expect(status).not.toBe(0);
		expect(stdout).toContain("The build did not produce image my-app-web");
	});
});
