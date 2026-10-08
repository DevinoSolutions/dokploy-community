import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A registry password in a command line is readable by every user on the host
 * (ps), locally and over SSH. Every place that logs docker in must therefore
 * keep the password out of the command it builds and send it on stdin, as its
 * own command ahead of the script that pushes or pulls.
 */

const PASSWORD = "hunter2-S3cret";
const ECR_TOKEN = "ecr-token-S3cret";
const OTHER_PASSWORD = "other-S3cret";
const CONFIG_1 = "/etc/dokploy/docker-config/reg-1";
const CONFIG_2 = "/etc/dokploy/docker-config/reg-2";
const isolatedLogin = (configDir: string, rest: string) =>
	`umask 077 && mkdir -p '${configDir}' && docker --config '${configDir}' login ${rest}`;

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	getECRAuthToken: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	findAllDeploymentsByApplicationId: vi.fn(),
}));
vi.mock("@dokploy/server/services/rollbacks", () => ({
	createRollback: vi.fn(),
}));
vi.mock("@dokploy/server/utils/aws/ecr", () => ({
	getECRAuthToken: mocks.getECRAuthToken,
}));
vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: vi.fn(),
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

import { getBuildPolicyPushCommand } from "@dokploy/server/services/build-policy/apply";
import { uploadImageRemoteCommand } from "@dokploy/server/utils/cluster/upload";
import { buildRemoteDocker } from "@dokploy/server/utils/providers/docker";

const registryRow = {
	registryId: "reg-1",
	registryName: "main",
	registryType: "cloud",
	registryUrl: "registry.example.com",
	username: "acme",
	password: PASSWORD,
	imagePrefix: null,
	awsAccessKeyId: null,
	awsSecretAccessKey: null,
	awsRegion: null,
};

/** Every command string handed to an exec, local or remote. */
const executedCommands = () =>
	[...mocks.execAsync.mock.calls, ...mocks.execAsyncRemote.mock.calls].map(
		(call) => (call[0] === "srv-1" ? call[1] : call[0]) as string,
	);

const expectNoSecretIn = (...texts: string[]) => {
	for (const text of texts) {
		expect(text).not.toContain(PASSWORD);
		expect(text).not.toContain(ECR_TOKEN);
		expect(text).not.toContain("printf");
	}
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.findRegistryByIdWithCredentials.mockResolvedValue(registryRow);
	mocks.getECRAuthToken.mockResolvedValue({
		username: "AWS",
		password: ECR_TOKEN,
		endpoint: "https://123.dkr.ecr.us-east-1.amazonaws.com",
	});
});

describe("uploadImageRemoteCommand", () => {
	const application = {
		appName: "my-app",
		sourceType: "git",
		applicationId: "app-1",
		registry: { registryId: "reg-1" },
		buildRegistry: null,
		rollbackRegistry: null,
		rollbackActive: false,
	} as never;

	it("logs in on the build server with the password on stdin, not in the script", async () => {
		const script = await uploadImageRemoteCommand(application, "srv-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			"docker login 'registry.example.com' -u 'acme' --password-stdin",
			undefined,
			{ stdin: PASSWORD },
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expectNoSecretIn(script, ...executedCommands());
		expect(script).not.toContain("docker login");
		expect(script).toContain("Registry Login Success");
		expect(script).toContain("docker push");
	});

	it("logs in on this host with the password on stdin when there is no server", async () => {
		const script = await uploadImageRemoteCommand(application, null);

		expect(mocks.execAsync).toHaveBeenCalledWith(
			"docker login 'registry.example.com' -u 'acme' --password-stdin",
			{ stdin: PASSWORD },
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expectNoSecretIn(script, ...executedCommands());
	});

	it("pushes two registries on one URL under their own account and config", async () => {
		mocks.findRegistryByIdWithCredentials.mockImplementation(
			async (id: string) =>
				id === "reg-2"
					? {
							...registryRow,
							registryId: "reg-2",
							registryName: "other",
							username: "someone-else",
							password: OTHER_PASSWORD,
						}
					: registryRow,
		);

		const script = await uploadImageRemoteCommand(
			{
				...(application as object),
				buildRegistry: { registryId: "reg-2" },
			} as never,
			"srv-1",
		);

		// The deploy registry stays in the default config; the build registry
		// gets its own, so neither login replaces the other.
		expect(mocks.execAsyncRemote).toHaveBeenNthCalledWith(
			1,
			"srv-1",
			"docker login 'registry.example.com' -u 'acme' --password-stdin",
			undefined,
			{ stdin: PASSWORD },
		);
		expect(mocks.execAsyncRemote).toHaveBeenNthCalledWith(
			2,
			"srv-1",
			`umask 077 && mkdir -p '${CONFIG_2}' && docker --config '${CONFIG_2}' login 'registry.example.com' -u 'someone-else' --password-stdin`,
			undefined,
			{ stdin: OTHER_PASSWORD },
		);
		expect(script).toMatch(/\ndocker push /);
		expect(script).toContain(`docker --config ${CONFIG_2} push `);
		expect(script).not.toContain(`docker --config ${CONFIG_1}`);
		expectNoSecretIn(script, ...executedCommands());
		expect(script).not.toContain(OTHER_PASSWORD);
	});

	it("reports a failed login with docker's output, never the password", async () => {
		mocks.execAsyncRemote.mockRejectedValue(
			Object.assign(new Error("Command failed"), {
				stderr: `unauthorized: bad credentials ${PASSWORD}`,
			}),
		);

		const failure = await uploadImageRemoteCommand(application, "srv-1").catch(
			(e: Error) => e,
		);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(
			/^Registry login failed for registry\.example\.com: /,
		);
		expect((failure as Error).message).not.toContain(PASSWORD);
	});

	it("sends the ECR token on stdin", async () => {
		mocks.findRegistryByIdWithCredentials.mockResolvedValue({
			...registryRow,
			registryType: "awsEcr",
			registryUrl: "123.dkr.ecr.us-east-1.amazonaws.com",
			awsAccessKeyId: "AKIA",
			awsSecretAccessKey: "secret",
			awsRegion: "us-east-1",
		});
		const script = await uploadImageRemoteCommand(application, "srv-1");

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			"docker login --username AWS --password-stdin '123.dkr.ecr.us-east-1.amazonaws.com'",
			undefined,
			{ stdin: ECR_TOKEN },
		);
		expectNoSecretIn(script, ...executedCommands());
	});

	it("fails the deploy before the script when the login is refused", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("unauthorized"));
		await expect(
			uploadImageRemoteCommand(application, "srv-1"),
		).rejects.toThrow("unauthorized");
	});
});

describe("buildRemoteDocker", () => {
	const base = { dockerImage: "nginx:1", registryUrl: null } as const;

	it("logs in with the application's own credentials on stdin", async () => {
		const script = await buildRemoteDocker(
			{
				...base,
				registryUrl: "registry.example.com",
				username: "acme",
				password: PASSWORD,
				registry: null,
			} as never,
			"srv-1",
		);

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			"docker login 'registry.example.com' -u 'acme' --password-stdin",
			undefined,
			{ stdin: PASSWORD },
		);
		expectNoSecretIn(script, ...executedCommands());
		expect(script).toContain("docker pull");
	});

	it("logs in with an attached registry's stored credentials on stdin", async () => {
		const script = await buildRemoteDocker(
			{
				...base,
				registry: { registryId: "reg-1", registryType: "cloud" },
			} as never,
			null,
		);

		expect(mocks.execAsync).toHaveBeenCalledWith(
			expect.stringMatching(
				/^umask 077 && mkdir -p '[^']*docker-config\/reg-1' && docker --config '[^']*docker-config\/reg-1' login 'registry\.example\.com' -u 'acme' --password-stdin$/,
			),
			{ stdin: PASSWORD },
		);
		expect(script).toMatch(/docker --config \S*docker-config\/reg-1 pull /);
		expectNoSecretIn(script, ...executedCommands());
	});

	it("logs in to ECR with the fresh token on stdin", async () => {
		const script = await buildRemoteDocker(
			{
				...base,
				registry: {
					registryId: "reg-1",
					registryType: "awsEcr",
					registryUrl: "123.dkr.ecr.us-east-1.amazonaws.com",
					awsAccessKeyId: "AKIA",
					awsSecretAccessKey: "secret",
					awsRegion: "us-east-1",
				},
			} as never,
			"srv-1",
		);

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			isolatedLogin(
				CONFIG_1,
				"--username AWS --password-stdin '123.dkr.ecr.us-east-1.amazonaws.com'",
			),
			undefined,
			{ stdin: ECR_TOKEN },
		);
		expect(script).toContain(`docker --config ${CONFIG_1} pull `);
		expectNoSecretIn(script, ...executedCommands());
	});
});

describe("getBuildPolicyPushCommand", () => {
	const plan = {
		enforced: true,
		buildServerId: "srv-1",
		registryId: "reg-1",
		repository: "registry.example.com/acme/my-app",
		settings: null,
	};

	it("logs in on the build host with the password on stdin, not in the script", async () => {
		const script = await getBuildPolicyPushCommand(plan, {
			appName: "my-app",
			serverId: "srv-1",
		});

		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"srv-1",
			isolatedLogin(
				CONFIG_1,
				"'registry.example.com' -u 'acme' --password-stdin",
			),
			undefined,
			{ stdin: PASSWORD },
		);
		expectNoSecretIn(script, ...executedCommands());
		expect(script).not.toContain("docker login");
		expect(script).toContain(`docker --config ${CONFIG_1} push `);
	});

	it("does nothing when the policy is not enforcing", async () => {
		const script = await getBuildPolicyPushCommand(
			{ ...plan, enforced: false },
			{ appName: "my-app", serverId: "srv-1" },
		);
		expect(script).toBe("");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});
