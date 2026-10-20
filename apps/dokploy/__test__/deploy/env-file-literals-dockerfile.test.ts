import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createEnvFileCommand,
	getAppEnvFileContent,
} from "@dokploy/server/utils/builders/utils";
import {
	getStagedFilePath,
	stageFiles,
} from "@dokploy/server/utils/docker/staging";
import { parse } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";

// Unlike compose's .env, this one is read by the app's own build tooling
// (generic dotenv, e.g. Next.js/Vite) — must stay unquoted, not Compose-escaped.
const appName = `env-file-literals-dockerfile-${process.pid}`;
const projectPath = join(process.cwd(), ".docker", "compose", appName);
const codePath = join(projectPath, "code");
const dockerFilePath = join(codePath, "Dockerfile");

afterEach(() => rmSync(projectPath, { force: true, recursive: true }));

const cases: Record<string, string> = {
	PASSWORD: "pa$$word",
	NESTED_JSON: '{"nested":{"a":1}}',
	QUOTE_INSIDE: 'she said "hi"',
	BACKSLASH: "back\\slash",
	UNICODE: "héllo wörld 日本語 🚀",
};

// `bash` on Windows is usually the WSL launcher, which reads the Windows paths
// in the generated command as relative POSIX paths and writes mangled-name
// files into the repo. The command targets a POSIX host, so only run it there.
describe.skipIf(process.platform === "win32")("createEnvFileCommand", () => {
	it("writes special environment values that a generic dotenv parser reads back literally", async () => {
		mkdirSync(codePath, { recursive: true });

		const serviceEnv = Object.entries(cases)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n");

		// The content is staged out of band and copied into place by the script.
		const staged = getStagedFilePath({
			directory: projectPath,
			kind: "app-env",
			deploymentId: "literals",
		});
		await stageFiles({
			directory: projectPath,
			files: [
				{ path: staged, content: getAppEnvFileContent(serviceEnv, "", "") },
			],
		});
		const command = createEnvFileCommand(dockerFilePath, staged);
		expect(command).not.toContain("pa$word");
		execFileSync("bash", ["-c", command]);
		expect(existsSync(staged)).toBe(false);

		const written = readFileSync(join(codePath, ".env"), "utf8");
		const parsed = parse(written);

		for (const [key, value] of Object.entries(cases)) {
			expect(parsed[key], key).toBe(value);
		}
	});
});
