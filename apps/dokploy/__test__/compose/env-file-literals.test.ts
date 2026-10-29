import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCreateEnvFileCommand } from "@dokploy/server/utils/builders/compose";
import { afterEach, describe, expect, it } from "vitest";
import {
	boundedBash,
	boundedSh,
	boundedShellAvailable,
} from "./helpers/bounded-shell";

// Regression coverage for https://github.com/Dokploy/dokploy/issues/4694 —
// values must survive Docker Compose's own `.env` parsing, not just the copy
// from the staged file.
const appName = `env-file-literals-${process.pid}`;
const projectPath = join(process.cwd(), ".docker", "compose", appName);
const codePath = join(projectPath, "code");

afterEach(() => {
	try {
		execFileSync("docker", ["compose", "down", "--remove-orphans"], {
			cwd: codePath,
			stdio: "ignore",
			timeout: 60_000,
		});
	} catch {
		// Project may not have been created (e.g. an earlier assertion failed).
	}
	rmSync(projectPath, { force: true, recursive: true });
	// `docker compose down` alone may take its 60 s: past vitest's 10 s default.
}, 90_000);

const cases: Record<string, string> = {
	PASSWORD: "pa$$word",
	SPECIAL: '!"#$%&/()=?',
	NESTED_JSON: '{"nested":{"a":1}}',
	MAIL_PASSWORD: "abc#de",
	TRAILING_BACKSLASH: "trailing\\",
	QUOTE_INSIDE: 'she said "hi"',
	APOSTROPHE: "it's a test",
	UNICODE: "héllo wörld 日本語 🚀",
	MULTILINE_PEM: "-----BEGIN KEY-----\nabc123\n-----END KEY-----",
	APP_URL: "https://example.com",
	ASSET_URL: "https://example.com",
	DB_HOST: "localhost",
};

// How each value must be typed in the UI so the (unchanged) dotenv input
// parser resolves it to the raw string in `cases` above.
const inputEncoding: Record<string, string> = {
	PASSWORD: "pa$$word",
	SPECIAL: `'!"#$%&/()=?'`,
	NESTED_JSON: '{"nested":{"a":1}}',
	MAIL_PASSWORD: `"abc#de"`,
	TRAILING_BACKSLASH: "trailing\\",
	QUOTE_INSIDE: 'she said "hi"',
	APOSTROPHE: "it's a test",
	UNICODE: "héllo wörld 日本語 🚀",
	MULTILINE_PEM: '"-----BEGIN KEY-----\nabc123\n-----END KEY-----"',
	APP_URL: "https://example.com",
	ASSET_URL: '"${APP_URL}"',
	DB_HOST: '"${UNDEFINED_HOST:-localhost}"',
};

const hasDocker = () => {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 });
		return true;
	} catch {
		return false;
	}
};

// `bash` on Windows is usually the WSL launcher, which reads the Windows paths
// in the generated command as relative POSIX paths and writes mangled-name
// files into the repo. The command targets a POSIX host, so only run it there.
/** Like execFileSync: the output, or a throw when the command fails. */
const succeeded = (result: ReturnType<typeof boundedSh>) => {
	if (result.status !== 0) {
		throw new Error(
			`exited with ${result.status ?? result.signal}: ${result.stderr}`,
		);
	}
	return result.stdout;
};

describe.skipIf(
	process.platform === "win32" || !boundedShellAvailable || !hasDocker(),
)("getCreateEnvFileCommand", () => {
	it("writes special environment values that Docker Compose reads back literally", async () => {
		mkdirSync(codePath, { recursive: true });

		const serviceEnv = Object.entries(inputEncoding)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n");

		const command = await getCreateEnvFileCommand({
			appName,
			composePath: "docker-compose.yml",
			env: serviceEnv,
			randomize: false,
			suffix: "",
			serverId: null,
			environment: { project: { env: "" }, env: "" },
		} as Parameters<typeof getCreateEnvFileCommand>[0]);

		succeeded(
			boundedBash(["-c", command], { encoding: "utf8", timeout: 60_000 }),
		);

		const composeFile = `services:\n  test:\n    image: busybox\n    environment:\n${Object.keys(
			cases,
		)
			.map((key) => `      - ${key}=\${${key}}`)
			.join("\n")}\n`;
		writeFileSync(join(codePath, "docker-compose.yml"), composeFile);

		const dumpScript = `for k in ${Object.keys(cases).join(" ")}; do printf '%s\\0' "$k"; eval "printf '%s\\0' \\"\\$$k\\""; done`;

		// The docker CLI runs inside the bounded shell; the script reaches it as $0.
		const out = succeeded(
			boundedSh(
				["-c", 'exec docker compose run --rm -T test sh -c "$0"', dumpScript],
				{ cwd: codePath, encoding: "utf8", timeout: 50_000 },
			),
		);

		const parts = out.split("\0");
		const actual: Record<string, string> = {};
		for (let i = 0; i < parts.length - 1; i += 2) {
			actual[parts[i] as string] = parts[i + 1] as string;
		}

		for (const [key, value] of Object.entries(cases)) {
			expect(actual[key], key).toBe(value);
		}
	}, 60000);
});
