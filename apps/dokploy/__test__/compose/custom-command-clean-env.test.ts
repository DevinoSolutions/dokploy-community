import {
	createCommand,
	getBuildComposeCommand,
	withCleanEnvironment,
} from "@dokploy/server/utils/builders/compose";
import { describe, expect, it, vi } from "vitest";

// T-7160 / T-7281: every docker command of a custom command chain runs under
// `env -i PATH HOME` (and, for a stack, the staged variables). Only the first
// used to, so a later `docker compose` saw the Dokploy process's environment.
vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
}));

const PREFIX = 'env -i PATH="$PATH" HOME="$HOME"';

const compose = (overrides: Record<string, unknown>) =>
	({
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
		...overrides,
	}) as unknown as Parameters<typeof getBuildComposeCommand>[0];

const CHAIN =
	"compose -p my-app -f docker-compose.yml config && docker compose -p my-app -f docker-compose.yml up -d && docker-compose -p my-app -f docker-compose.yml ps";

// The parts of a shell line that run a docker command.
const dockerParts = (line: string) =>
	line.split(" && ").filter((part) => /docker(?:-compose)?\b/.test(part));

describe("withCleanEnvironment", () => {
	it("puts the prefix before every command of a chain", () => {
		expect(withCleanEnvironment(CHAIN, "P", true)).toBe(
			"P docker compose -p my-app -f docker-compose.yml config && P docker compose -p my-app -f docker-compose.yml up -d && P docker-compose -p my-app -f docker-compose.yml ps",
		);
	});

	it("keeps a single command and a generated one as they were", () => {
		expect(withCleanEnvironment("compose up -d", "P", true)).toBe(
			"P docker compose up -d",
		);
		// A generated command can hold an && in a quoted path: not split.
		expect(withCleanEnvironment('compose -f "a && b" up', "P", false)).toBe(
			'P docker compose -f "a && b" up',
		);
	});
});

describe.each(["docker-compose", "stack"])("a %s with a chained command", (composeType) => {
	it("runs every docker command under the clean environment", async () => {
		const script = await getBuildComposeCommand(
			compose({
				composeType,
				command: CHAIN,
				env: composeType === "stack" ? "A=1" : "",
			}),
		);
		const lines = script
			.split("\n")
			.filter((line) => line.includes("-f docker-compose.yml config"))
			.filter((line) => !line.includes("Command: "));
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			const parts = dockerParts(line);
			expect(parts.length).toBeGreaterThanOrEqual(3);
			for (const part of parts) {
				expect(part).toContain(PREFIX);
			}
		}
	});
});

describe("the restore of a chained command", () => {
	it("runs every docker command of the chain under the clean environment", async () => {
		const script = await getBuildComposeCommand(
			compose({ command: CHAIN }),
			{},
		);
		// The restore line re-runs the chain (flags stripped) after the failure.
		const restore = script
			.split("\n")
			.filter((line) => line.includes("echo") && line.includes(" ps 2>&1"));
		expect(restore.length).toBeGreaterThan(0);
		for (const line of restore) {
			const parts = dockerParts(line).filter((part) =>
				/-f docker-compose.yml (config|up|ps)/.test(part),
			);
			expect(parts.length).toBe(3);
			for (const part of parts) {
				expect(part).toContain(PREFIX);
			}
		}
	});
});

describe("what a custom command may chain", () => {
	it("only allows && between docker compose commands", () => {
		const build = (command: string) =>
			createCommand(compose({ command }), undefined);
		expect(build(CHAIN)).toContain("&&");
		for (const command of [
			"compose up -d ; docker compose ps",
			"compose up -d || docker compose ps",
			"compose up -d\ndocker compose ps",
			"compose up -d & docker compose ps",
			"compose up -d && docker run -v /:/h alpine",
			"compose up -d | docker compose ps",
		]) {
			expect(() => build(command)).toThrow();
		}
	});
});
