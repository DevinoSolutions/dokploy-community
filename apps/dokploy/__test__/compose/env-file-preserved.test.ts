import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import { stageFiles } from "@dokploy/server/utils/docker/staging";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Compose now has a `createEnvFile` toggle (default true), mirroring the
// Application builder's flag: when disabled, Dokploy never writes `.env`,
// so a repo-tracked file survives untouched.
vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
}));
// The env content is staged on the host instead of embedded in the script;
// this suite only checks whether the script writes it.
vi.mock("@dokploy/server/utils/docker/staging", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/docker/staging")
	>()),
	stageFiles: vi.fn().mockResolvedValue(undefined),
}));

const baseCompose = {
	appName: "env-file-toggle",
	sourceType: "raw",
	command: "",
	composePath: "docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "FOO=bar",
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Parameters<typeof getBuildComposeCommand>[0];

// What writing the .env looks like in the script: a `touch` of it, or a
// redirect into it. The backup/restore snapshot only ever `cp`s it. Paths are
// normalized so the checks hold with Windows backslashes as well as on Linux.
const TOUCHES_ENV = /touch [^\n]*\.env/;
const REDIRECTS_INTO_ENV = />\s*['"]?[^\s;&|'"]*\.env\b/;
const posix = (command: string) => command.replaceAll("\\", "/");

describe("getBuildComposeCommand createEnvFile toggle", () => {
	beforeEach(() => vi.clearAllMocks());

	it("createEnvFile: false never writes the .env file", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			createEnvFile: false,
		});

		// (the transactional backup/restore snapshot names the .env path whatever
		// the toggle is; what must not appear is a staged or installed env)
		expect(command).not.toContain("dokploy-stage-env");
		expect(posix(command)).not.toMatch(TOUCHES_ENV);
		expect(posix(command)).not.toMatch(REDIRECTS_INTO_ENV);
		expect(command).not.toContain("base64");
		expect(stageFiles).not.toHaveBeenCalled();
	});

	it("createEnvFile: true (default) writes Dokploy's vars", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			createEnvFile: true,
		});

		// (path separators are normalized so the test also runs on Windows)
		expect(command.replaceAll("\\", "/")).toMatch(
			/cat \S+\.dokploy-stage-env-\S+ > \S+\/code\/\.env/,
		);
		expect(command).not.toContain("base64");
		// The same checks do catch a script that writes the env.
		expect(posix(command)).toMatch(TOUCHES_ENV);
		expect(posix(command)).toMatch(REDIRECTS_INTO_ENV);
		expect(stageFiles).toHaveBeenCalledTimes(1);
		const { files } = vi.mocked(stageFiles).mock.calls[0]![0];
		expect(files[0]!.content).toContain('FOO="bar"');
	});
});
