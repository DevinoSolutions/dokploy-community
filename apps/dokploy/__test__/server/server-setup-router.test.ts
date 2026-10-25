import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// server.setup and server.setupWithLogs (T-7981): a failed setup reaches the
// caller as a user-facing error, and every attempt is audited.
vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(() => Promise.resolve()),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	return {
		...actual,
		checkPermission: vi.fn(async () => {}),
	};
});

vi.mock("@dokploy/server", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server")>();
	return {
		...actual,
		findServerById: vi.fn(async () => ({
			serverId: "srv-1",
			name: "worker",
			organizationId: "org-1",
		})),
		serverSetup: vi.fn(async () => {}),
	};
});

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { audit } = await import("@/server/api/utils/audit");
const { ServerSetupError, serverSetup } = await import("@dokploy/server");

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

const auditedOutcomes = () =>
	vi.mocked(audit).mock.calls.map(([, event]) => ({
		resourceId: event.resourceId,
		resourceName: event.resourceName,
		metadata: event.metadata,
	}));

/** Mimics serverSetup: it reports its own failure line, then rethrows. */
const failSetupWith = (error: Error) =>
	vi.mocked(serverSetup).mockImplementation(async (_serverId, onData) => {
		onData?.(`\nSetup Server: ❌ ${error.message}\n`);
		throw error;
	});

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
	vi.mocked(audit).mockClear();
	vi.mocked(serverSetup).mockReset();
	vi.mocked(serverSetup).mockImplementation(async () => {});
	consoleError.mockClear();
});

describe("server.setup", () => {
	it("audits a successful setup", async () => {
		await caller.server.setup({ serverId: "srv-1" });

		expect(auditedOutcomes()).toEqual([
			{
				resourceId: "srv-1",
				resourceName: "worker",
				metadata: { outcome: "success" },
			},
		]);
	});

	it("fails with PRECONDITION_FAILED and audits the failure", async () => {
		const setupError = new ServerSetupError(
			'Setup failed at step "6. Setting up Network" (exit code 1)',
		);
		failSetupWith(setupError);

		const error = await caller.server.setup({ serverId: "srv-1" }).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
		expect((error as TRPCError).message).toBe(setupError.message);
		expect((error as TRPCError).cause).toBe(setupError);
		expect(auditedOutcomes()).toEqual([
			{
				resourceId: "srv-1",
				resourceName: "worker",
				metadata: { outcome: "failure", reason: setupError.message },
			},
		]);
	});

	it("leaves an unexpected error as an internal error, and still audits it", async () => {
		vi.mocked(serverSetup).mockRejectedValue(new Error("db down"));

		const error = await caller.server.setup({ serverId: "srv-1" }).then(
			() => null,
			(e: unknown) => e,
		);

		expect((error as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
		expect(auditedOutcomes()[0]?.metadata).toEqual({
			outcome: "failure",
			reason: "db down",
		});
	});
});

describe("server.setupWithLogs", () => {
	const collect = async () => {
		const observable = (await caller.server.setupWithLogs({
			serverId: "srv-1",
		})) as unknown as {
			subscribe: (observer: { next: (log: string) => void }) => {
				unsubscribe: () => void;
			};
		};
		const logs: string[] = [];
		const subscription = observable.subscribe({
			next: (log) => logs.push(log),
		});
		// Let serverSetup settle and the audit run.
		await vi.waitFor(() => expect(audit).toHaveBeenCalled());
		subscription.unsubscribe();
		return logs;
	};

	it("audits a successful setup", async () => {
		vi.mocked(serverSetup).mockImplementation(async (_serverId, onData) => {
			onData?.("\nSetup Server: ✅\n");
		});

		const logs = await collect();

		expect(logs).toEqual(["\nSetup Server: ✅\n"]);
		expect(auditedOutcomes()).toEqual([
			{
				resourceId: "srv-1",
				resourceName: "worker",
				metadata: { outcome: "success" },
			},
		]);
	});

	it("reports a failure once and audits it", async () => {
		failSetupWith(new ServerSetupError("Setup failed (exit code 1)"));

		const logs = await collect();

		expect(logs.filter((log) => log.includes("❌"))).toEqual([
			"\nSetup Server: ❌ Setup failed (exit code 1)\n",
		]);
		expect(auditedOutcomes()).toEqual([
			{
				resourceId: "srv-1",
				resourceName: "worker",
				metadata: {
					outcome: "failure",
					reason: "Setup failed (exit code 1)",
				},
			},
		]);
	});
});
