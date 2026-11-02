import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T-12606: a builder or system prune on a busy build server holds BuildKit's
 * write lock for hours and freezes every build. The prune routes refuse to run
 * while builds are active on the server unless the caller forces it, prune by
 * age unless asked for `all`, and leave an audit row before they start.
 */

const mocks = vi.hoisted(() => ({
	countActiveDeploymentsOnHost: vi.fn(),
	findServerById: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	countActiveDeploymentsOnHost: mocks.countActiveDeploymentsOnHost,
	findServerById: mocks.findServerById,
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: mocks.audit }));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

import {
	builderPruneCommand,
	cleanupAll,
	cleanupBuilders,
} from "@dokploy/server/utils/docker/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import {
	assertBuilderPruneAllowed,
	auditBuilderPrune,
	builderPruneBlockedMessage,
	builderPruneInput,
	checkBuilderPrune,
	decideBuilderPrune,
	LOCAL_HOST_NAME,
} from "@/server/api/utils/builder-prune";

describe("decideBuilderPrune", () => {
	it("allows a prune on an idle server", () => {
		expect(decideBuilderPrune({ activeBuilds: 0, force: false })).toEqual({
			allowed: true,
			forced: false,
		});
	});

	it("blocks a prune while builds run", () => {
		expect(decideBuilderPrune({ activeBuilds: 3, force: false })).toEqual({
			allowed: false,
			forced: false,
		});
	});

	it("lets force through and marks it forced only when builds were running", () => {
		expect(decideBuilderPrune({ activeBuilds: 3, force: true })).toEqual({
			allowed: true,
			forced: true,
		});
		expect(decideBuilderPrune({ activeBuilds: 0, force: true })).toEqual({
			allowed: true,
			forced: false,
		});
	});
});

describe("the builder prune guard", () => {
	const warn = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("blocks with PRECONDITION_FAILED and the plain message", async () => {
		await expect(
			assertBuilderPruneAllowed(
				{ serverId: "srv-1", force: false },
				{
					countActive: async () => 2,
					resolveHostName: async () => "devino-third",
					warn,
				},
			),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message:
				"Builder cache cleanup is blocked while 2 build(s) run on devino-third. It would pause every build for the whole prune. Retry when the server is idle.",
		});
		expect(builderPruneBlockedMessage(2, "devino-third")).toContain(
			"2 build(s) run on devino-third",
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("passes force through, with a warning that names the server and count", async () => {
		const result = await assertBuilderPruneAllowed(
			{ serverId: "srv-1", force: true },
			{
				countActive: async () => 2,
				resolveHostName: async () => "devino-third",
				warn,
			},
		);
		expect(result).toMatchObject({
			allowed: true,
			forced: true,
			activeBuilds: 2,
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("forced on devino-third");
		expect(warn.mock.calls[0]?.[0]).toContain("2 build(s)");
	});

	it("runs on an idle server without a warning", async () => {
		const result = await assertBuilderPruneAllowed(
			{ force: false },
			{ countActive: async () => 0, warn },
		);
		expect(result).toMatchObject({ allowed: true, forced: false });
		expect(result.hostName).toBe(LOCAL_HOST_NAME);
		expect(warn).not.toHaveBeenCalled();
	});

	it("treats a failed build check as busy unless forced", async () => {
		const countActive = async () => {
			throw new Error("db down");
		};
		await expect(
			assertBuilderPruneAllowed(
				{ serverId: "srv-1", force: false },
				{ countActive, resolveHostName: async () => "devino-third", warn },
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		const forced = await checkBuilderPrune(
			{ serverId: "srv-1", force: true },
			{ countActive, resolveHostName: async () => "devino-third", warn },
		);
		expect(forced.allowed).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("counts builds through the deployment helper and names a remote server", async () => {
		mocks.countActiveDeploymentsOnHost.mockResolvedValue(1);
		mocks.findServerById.mockResolvedValue({ name: "devino-third" });
		const result = await checkBuilderPrune(
			{ serverId: "srv-1", force: false },
			{ warn },
		);
		expect(mocks.countActiveDeploymentsOnHost).toHaveBeenCalledWith("srv-1");
		expect(result).toMatchObject({
			allowed: false,
			activeBuilds: 1,
			hostName: "devino-third",
		});
	});

	it("defaults the route input to no force and no --all", () => {
		expect(builderPruneInput.parse({})).toEqual({ force: false, all: false });
		expect(
			builderPruneInput.parse({ serverId: "s", force: true, all: true }),
		).toEqual({ serverId: "s", force: true, all: true });
	});
});

describe("the builder prune command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(execAsync).mockResolvedValue({ stdout: "", stderr: "" });
		vi.mocked(execAsyncRemote).mockResolvedValue({ stdout: "", stderr: "" });
	});

	it("prunes by age by default", () => {
		const command = builderPruneCommand();
		expect(command).toContain(
			"docker builder prune --force --filter until=168h",
		);
		expect(command).not.toContain("--all");
	});

	it("keeps --all only when asked for", () => {
		const command = builderPruneCommand({ all: true });
		expect(command).toContain("docker builder prune --all --force");
		expect(command).not.toContain("until=");
	});

	it("sends the aged prune from cleanupBuilders, locally and remotely", async () => {
		await cleanupBuilders();
		await cleanupBuilders("srv-1", { all: true });
		const local = vi.mocked(execAsync).mock.calls[0]?.[0] as string;
		const remote = vi.mocked(execAsyncRemote).mock.calls[0]?.[1] as string;
		expect(local).toContain("--force --filter until=168h");
		expect(remote).toContain("docker builder prune --all --force");
	});

	it("leaves the builder and system prunes out of cleanupAll when skipped", async () => {
		await cleanupAll("srv-1", { skip: ["builders", "system"] });
		const ran = vi
			.mocked(execAsyncRemote)
			.mock.calls.map(
				(call) => (call[1] as string).match(/docker [a-z]+ prune/)?.[0],
			);
		expect(ran).toEqual(["docker container prune", "docker image prune"]);
	});

	it("runs the aged builder prune inside cleanupAll", async () => {
		await cleanupAll();
		const commands = vi
			.mocked(execAsync)
			.mock.calls.map((call) => call[0] as string);
		const builder = commands.find((c) => c.includes("docker builder prune"));
		expect(builder).toContain("--force --filter until=168h");
		expect(builder).not.toContain("--all");
	});
});

describe("the prune audit", () => {
	const ctx = {
		user: { id: "u1", email: "admin@example.com", role: "admin" },
		session: { activeOrganizationId: "org-1" },
	};

	it("records the server, the flags and the operation", async () => {
		const auditFn = vi.fn(async () => undefined);
		await auditBuilderPrune(
			ctx,
			{
				operation: "settings.cleanDockerBuilder",
				serverId: "srv-1",
				hostName: "devino-third",
				force: true,
				all: false,
				activeBuilds: 4,
			},
			auditFn,
		);
		expect(auditFn).toHaveBeenCalledWith(ctx, {
			action: "delete",
			resourceType: "server",
			resourceId: "srv-1",
			resourceName: "devino-third",
			metadata: {
				operation: "settings.cleanDockerBuilder",
				force: true,
				all: false,
				activeBuilds: 4,
			},
		});
	});

	it("names the Dokploy server when no serverId is given", async () => {
		const auditFn = vi.fn(async () => undefined);
		await auditBuilderPrune(
			ctx,
			{
				operation: "dockerDiskUsage.pruneBuildCache",
				hostName: LOCAL_HOST_NAME,
				force: false,
			},
			auditFn,
		);
		expect(auditFn).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				resourceId: "local",
				metadata: expect.objectContaining({ force: false, all: false }),
			}),
		);
	});

	it("goes through the shared audit helper by default", async () => {
		mocks.audit.mockResolvedValue(undefined);
		await auditBuilderPrune(ctx, {
			operation: "settings.cleanAll",
			hostName: LOCAL_HOST_NAME,
			force: false,
		});
		expect(mocks.audit).toHaveBeenCalledTimes(1);
	});
});
