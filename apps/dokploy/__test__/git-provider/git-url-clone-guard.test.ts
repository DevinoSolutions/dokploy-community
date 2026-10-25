import { beforeEach, describe, expect, it, vi } from "vitest";

// A custom git source clones the URL its owner typed (T-8420). Only a remote
// repository is cloned: `file://`, local paths, transport helpers and values
// git would read as an option are refused before any command is built or run,
// and every clone that is built holds git to remote protocols (submodules
// included). Every clone path ends in cloneGitRepository, so the real function
// is used below and only the shell is mocked.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findSSHKeyById: vi.fn(),
	updateSSHKeyById: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	assertDeployReferencesInOrganization: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	writeFileRemote: vi.fn(),
}));
vi.mock("@dokploy/server/services/ssh-key", () => ({
	findSSHKeyById: mocks.findSSHKeyById,
	updateSSHKeyById: mocks.updateSSHKeyById,
}));
vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));
vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
}));
vi.mock("@dokploy/server/services/service-reference-scope", () => ({
	assertDeployReferencesInOrganization:
		mocks.assertDeployReferencesInOrganization,
}));

import { getComposeCloneCommand } from "@dokploy/server/services/compose-build-server";
import { ensurePatchRepo } from "@dokploy/server/services/patch-repo";
import { cloneCompose } from "@dokploy/server/utils/docker/domain";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import {
	assertGitUrlSaveable,
	assertSafeGitUrl,
	GIT_ALLOW_PROTOCOL_ENV,
	GIT_URL_REFUSED_MESSAGE,
	GitUrlRefusedError,
} from "@dokploy/server/utils/providers/git-url";

const REFUSED_URLS = [
	"file:///etc",
	"/srv/x",
	"../x",
	"ext::sh -c id",
	"-oProxyCommand=x:r",
	"git://h/r",
];

const ALLOW_PROTOCOL = "GIT_ALLOW_PROTOCOL=https:http:ssh";

const gitSource = (customGitUrl: string, extra: Record<string, unknown> = {}) =>
	({
		appName: "web",
		sourceType: "git",
		customGitUrl,
		customGitBranch: "main",
		customGitSSHKeyId: null,
		enableSubmodules: false,
		serverId: null,
		environment: { project: { organizationId: "org-1" } },
		...extra,
	}) as never;

const ranCommands = () => [
	...mocks.execAsync.mock.calls,
	...mocks.execAsyncRemote.mock.calls,
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.findSSHKeyById.mockResolvedValue({ privateKey: "KEY" });
	mocks.assertDeployReferencesInOrganization.mockResolvedValue(undefined);
});

describe("the shared URL rule", () => {
	it("uses the neutral message", () => {
		expect(GIT_URL_REFUSED_MESSAGE).toBe(
			"This git URL is not allowed; use an http(s), ssh, or user@host:path URL",
		);
		expect(() => assertSafeGitUrl("file:///etc")).toThrow(GitUrlRefusedError);
	});

	it("exports the protocol limit as one shell statement", () => {
		expect(GIT_ALLOW_PROTOCOL_ENV).toBe(`export ${ALLOW_PROTOCOL};`);
	});
});

describe("cloneGitRepository", () => {
	it.each(REFUSED_URLS)(
		"refuses %s before anything is looked up or run",
		async (url) => {
			await expect(
				cloneGitRepository({
					appName: "web",
					customGitUrl: url,
					customGitBranch: "main",
					customGitSSHKeyId: "key-1",
					serverId: null,
				}),
			).rejects.toThrow(GIT_URL_REFUSED_MESSAGE);

			expect(mocks.findSSHKeyById).not.toHaveBeenCalled();
			expect(mocks.updateSSHKeyById).not.toHaveBeenCalled();
			expect(ranCommands()).toEqual([]);
		},
	);

	it.each([
		["a local", null],
		["a remote", "srv-1"],
	])(
		"limits an https clone on %s host to remote protocols, before git runs",
		async (_label, serverId) => {
			const command = await cloneGitRepository({
				appName: "web",
				customGitUrl: "https://github.com/owner/repo.git",
				customGitBranch: "main",
				enableSubmodules: true,
				serverId,
			});

			expect(command).toContain(GIT_ALLOW_PROTOCOL_ENV);
			expect(command.indexOf(ALLOW_PROTOCOL)).toBeLessThan(
				command.indexOf("git clone"),
			);
			expect(command).toContain("--recurse-submodules");
		},
	);

	it("keeps an SSH-key clone working: the key command and the protocol limit", async () => {
		const command = await cloneGitRepository({
			appName: "web",
			customGitUrl: "git@github.com:owner/repo.git",
			customGitBranch: "main",
			customGitSSHKeyId: "key-1",
			serverId: null,
		});

		expect(command).toContain('export GIT_SSH_COMMAND="ssh -i /tmp/id_rsa');
		expect(command).toContain(ALLOW_PROTOCOL);
		expect(command.indexOf(ALLOW_PROTOCOL)).toBeLessThan(
			command.indexOf("git clone"),
		);
		expect(command).toContain("ssh-keyscan");
	});

	it("limits the pinned fetch of a build server copy too (same shell)", async () => {
		const command = await cloneGitRepository({
			appName: "web",
			customGitUrl: "ssh://git@host.example:2222/owner/repo.git",
			customGitBranch: "main",
			customGitSSHKeyId: "key-1",
			serverId: "build-1",
			type: "compose",
			pinCommit: "0123456789abcdef0123456789abcdef01234567",
		});

		expect(command.indexOf(ALLOW_PROTOCOL)).toBeLessThan(
			command.indexOf("0123456789abcdef0123456789abcdef01234567"),
		);
	});
});

describe("every clone path refuses a bad URL with no command run", () => {
	it.each(REFUSED_URLS)(
		"cloneCompose (source type fetch, services list, rolling preflight, collision rewrite): %s",
		async (url) => {
			await expect(
				cloneCompose(gitSource(url, { composeId: "c-1" })),
			).rejects.toThrow(GIT_URL_REFUSED_MESSAGE);
			expect(ranCommands()).toEqual([]);
		},
	);

	it.each(REFUSED_URLS)("patch repo of an application: %s", async (url) => {
		mocks.findApplicationById.mockResolvedValue(
			gitSource(url, { applicationId: "a-1" }),
		);
		await expect(
			ensurePatchRepo({ type: "application", id: "a-1" }),
		).rejects.toThrow(GIT_URL_REFUSED_MESSAGE);
		expect(ranCommands()).toEqual([]);
	});

	it.each(REFUSED_URLS)(
		"patch repo of a compose on a remote server: %s",
		async (url) => {
			mocks.findComposeById.mockResolvedValue(
				gitSource(url, { composeId: "c-1", serverId: "srv-1" }),
			);
			await expect(
				ensurePatchRepo({ type: "compose", id: "c-1" }),
			).rejects.toThrow(GIT_URL_REFUSED_MESSAGE);
			expect(ranCommands()).toEqual([]);
		},
	);

	it.each(REFUSED_URLS)("compose build server copy: %s", async (url) => {
		await expect(
			getComposeCloneCommand(
				gitSource(url, { composeId: "c-1", buildServerId: "build-1" }),
				{} as never,
				"0123456789abcdef0123456789abcdef01234567",
			),
		).rejects.toThrow(GIT_URL_REFUSED_MESSAGE);
		expect(ranCommands()).toEqual([]);
	});

	it("still builds the commands of valid https and ssh-key sources", async () => {
		await expect(
			cloneCompose(gitSource("https://github.com/o/r.git", { composeId: "c" })),
		).resolves.toContain(ALLOW_PROTOCOL);
		await expect(
			getComposeCloneCommand(
				gitSource("git@github.com:o/r.git", {
					composeId: "c",
					customGitSSHKeyId: "key-1",
				}),
				{} as never,
				null,
			),
		).resolves.toContain(ALLOW_PROTOCOL);

		mocks.findApplicationById.mockResolvedValue(
			gitSource("https://github.com/o/r.git", { applicationId: "a-1" }),
		);
		await ensurePatchRepo({ type: "application", id: "a-1" });
		expect(String(mocks.execAsync.mock.calls.at(-1)?.[0])).toContain(
			ALLOW_PROTOCOL,
		);
	});
});

describe("saving a custom git URL", () => {
	const refusedOnSave = (next: string | null | undefined, current?: string) => {
		try {
			assertGitUrlSaveable(next, current);
			return null;
		} catch (error) {
			return error as { code?: string; message?: string };
		}
	};

	it.each(REFUSED_URLS)("rejects a changed value: %s", (url) => {
		expect(refusedOnSave(url, "https://github.com/o/r.git")).toMatchObject({
			code: "BAD_REQUEST",
			message: GIT_URL_REFUSED_MESSAGE,
		});
		expect(refusedOnSave(url, undefined)).toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("lets an unchanged legacy value save, so the row stays editable", () => {
		expect(
			refusedOnSave("file:///srv/legacy", "file:///srv/legacy"),
		).toBeNull();
	});

	it("does not check a field that is absent, cleared or valid", () => {
		expect(refusedOnSave(undefined, "file:///srv/legacy")).toBeNull();
		expect(refusedOnSave(null, "file:///srv/legacy")).toBeNull();
		expect(refusedOnSave("", "file:///srv/legacy")).toBeNull();
		expect(
			refusedOnSave("git@github.com:o/r.git", "file:///srv/legacy"),
		).toBeNull();
	});

	it("still refuses a legacy value at deploy time with the same message", async () => {
		await expect(
			cloneGitRepository({
				appName: "web",
				customGitUrl: "file:///srv/legacy",
				customGitBranch: "main",
				serverId: null,
			}),
		).rejects.toThrow(GIT_URL_REFUSED_MESSAGE);
	});
});
