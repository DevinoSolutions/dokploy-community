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

describe("getBuildComposeCommand createEnvFile toggle", () => {
	beforeEach(() => vi.clearAllMocks());

	it("createEnvFile: false never writes the .env file", async () => {
		const command = await getBuildComposeCommand({
			...baseCompose,
			createEnvFile: false,
		});

		expect(command).not.toContain("/.env");
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
		expect(stageFiles).toHaveBeenCalledTimes(1);
		const { files } = vi.mocked(stageFiles).mock.calls[0]![0];
		expect(files[0]!.content).toContain('FOO="bar"');
	});
});
