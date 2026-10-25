import { parse } from "shell-quote";
import { describe, expect, it, vi } from "vitest";

// The build path, Dockerfile, context, stage and builder versions are settings
// of the application: each reaches the build script as one quoted word, so a
// value with shell syntax in it stays a (wrong) path (T-8238).
vi.mock("@dokploy/server/utils/docker/staging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/staging")
	>()),
	stageFiles: vi.fn(),
}));

import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { getDockerCommand } from "@dokploy/server/utils/builders/docker-file";
import { getHerokuCommand } from "@dokploy/server/utils/builders/heroku";
import { getNixpacksCommand } from "@dokploy/server/utils/builders/nixpacks";
import { getPaketoCommand } from "@dokploy/server/utils/builders/paketo";
import { getRailpackCommand } from "@dokploy/server/utils/builders/railpack";
import {
	getBuildAppDirectory,
	getDockerContextPath,
} from "@dokploy/server/utils/filesystem/directory";

const PAYLOADS = [
	"x$(y z)",
	"x`y z`",
	"x; y",
	"x && y",
	"x | y",
	"x > y",
	"my app",
];

const application = (overrides: Partial<ApplicationNested>) =>
	({
		appName: "test-app",
		sourceType: "github",
		buildType: "nixpacks",
		buildPath: "/",
		dockerfile: "Dockerfile",
		dockerContextPath: null,
		dockerBuildStage: null,
		herokuVersion: "24",
		railpackVersion: "0.15.4",
		publishDirectory: null,
		serverId: null,
		buildServerId: null,
		env: null,
		buildArgs: null,
		buildSecrets: null,
		cleanCache: false,
		createEnvFile: false,
		environment: { env: "", project: { env: "" } },
		...overrides,
	}) as unknown as ApplicationNested;

// The words of the script line that runs `start` (not the one that echoes
// it), up to its `|| {`.
const commandWords = (script: string, start: string) => {
	const line = script
		.split("\n")
		.find(
			(candidate) => candidate.includes(start) && !candidate.includes("echo "),
		);
	if (!line) throw new Error(`no line runs ${start}`);
	const command = line
		.slice(line.indexOf(start))
		.replace(/\s*\|\|\s*\{\s*$/, "");
	return parse(command, (name) => `$${name}`);
};

const expectPlainWords = (words: ReturnType<typeof parse>) => {
	for (const word of words) {
		expect(typeof word, JSON.stringify(word)).toBe("string");
	}
};

describe.each(PAYLOADS)("a setting set to %j", (payload) => {
	it("stays one word of the nixpacks build", async () => {
		const app = application({ buildType: "nixpacks", buildPath: payload });
		const words = commandWords(await getNixpacksCommand(app), "nixpacks build");
		expectPlainWords(words);
		expect(words).toContain(getBuildAppDirectory(app));
	});

	it("stays one word of the heroku build, build path and version", async () => {
		const app = application({
			buildType: "heroku_buildpacks",
			buildPath: payload,
			herokuVersion: payload,
		});
		const words = commandWords(await getHerokuCommand(app), "pack build");
		expectPlainWords(words);
		expect(words).toContain(getBuildAppDirectory(app));
		expect(words).toContain(`heroku/builder:${payload}`);
	});

	it("stays one word of the paketo build", async () => {
		const app = application({
			buildType: "paketo_buildpacks",
			buildPath: payload,
		});
		const words = commandWords(await getPaketoCommand(app), "pack build");
		expectPlainWords(words);
		expect(words).toContain(getBuildAppDirectory(app));
	});

	it("stays one word of the railpack prepare and build, build path and version", async () => {
		const app = application({
			buildType: "railpack",
			buildPath: payload,
			railpackVersion: payload,
		});
		const script = await getRailpackCommand(app);
		const directory = getBuildAppDirectory(app);

		const prepare = commandWords(script, "railpack prepare");
		expectPlainWords(prepare);
		expect(prepare).toContain(directory);
		expect(prepare).toContain(`${directory}/railpack-plan.json`);

		const build = commandWords(script, "docker buildx build");
		expectPlainWords(build);
		expect(build).toContain(directory);
		expect(build).toContain(
			`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${payload}`,
		);

		const version = commandWords(script, "export RAILPACK_VERSION=");
		expect(version).toEqual(["export", `RAILPACK_VERSION=${payload}`]);
	});

	it("stays one word of the docker build: build path, Dockerfile, context and stage", async () => {
		const app = application({
			buildType: "dockerfile",
			buildPath: payload,
			dockerfile: `${payload}.Dockerfile`,
			dockerContextPath: payload,
			dockerBuildStage: payload,
		});
		const words = commandWords(await getDockerCommand(app), "docker build");
		expectPlainWords(words);
		expect(words).toContain(getBuildAppDirectory(app));
		expect(words).toContain(getDockerContextPath(app));
		expect(
			words.slice(words.indexOf("--target"), words.indexOf("--target") + 2),
		).toEqual(["--target", payload]);
	});
});

describe("plain settings", () => {
	// A Windows path has backslashes, which are quoted as well.
	it.skipIf(process.platform === "win32")(
		"leave the build commands as they were",
		async () => {
			const app = application({ buildType: "nixpacks", buildPath: "apps/web" });
			const script = await getNixpacksCommand(app);
			expect(script).toContain(
				`nixpacks build ${getBuildAppDirectory(app)} --name test-app`,
			);
		},
	);
});
