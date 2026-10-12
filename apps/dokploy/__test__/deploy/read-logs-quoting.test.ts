import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * deployment.readLogs tails the deployment's log file, on this host or over
 * SSH. Rows written before log paths were quoted can hold a path with shell
 * syntax in it, and reading the log must not run it.
 */

const mocks = vi.hoisted(() => ({
	deployment: null as Record<string, unknown> | null,
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: new Proxy({}, { get: () => ({ findFirst: vi.fn() }) }) },
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@dokploy/server/services/deployment", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findDeploymentById: vi.fn(async () => mocks.deployment),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/services/server", async (importOriginal) => ({
	...(await importOriginal<object>()),
	findServerById: vi.fn(async (serverId: string) => ({
		serverId,
		organizationId: "org-1",
	})),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => ({
	...(await importOriginal<object>()),
	checkServicePermissionAndAccess: vi.fn(async () => {}),
}));

// The native binding is not needed to exercise the router.
vi.mock("bcrypt", () => ({ default: {}, hash: vi.fn(), compare: vi.fn() }));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const { createCallerFactory } = await import("@/server/api/trpc");

const caller = () =>
	createCallerFactory(deploymentRouter)({
		user: { id: "user-1", email: "owner@test.com", role: "owner" },
		session: { activeOrganizationId: "org-1" },
		req: {} as unknown,
		res: {} as unknown,
	} as never);

// Git Bash on Windows wants /c/Users/... instead of C:\Users\...
const toPosix = (value: string) =>
	value
		.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
		.split(String.fromCharCode(92))
		.join("/");

const root = mkdtempSync(path.join(tmpdir(), "dokploy-readlogs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A double quote cannot be part of a file name on Windows.
const hostile = [
	"a$(touch pwned)b.log",
	"a`touch pwned`b.log",
	"a;touch pwned;b.log",
	"a b.log",
	...(process.platform === "win32" ? [] : ['a"; touch pwned; echo ".log']),
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
});

describe("deployment.readLogs", () => {
	it.each(hostile)("reads a log named %j without evaluating it", async (name) => {
		const dir = path.join(root, "logs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, name), "line one\nline two\n");
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath: `${toPosix(dir)}/${name}`,
			serverId: null,
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		const command = mocks.execAsync.mock.calls[0]?.[0] as string;
		expect(command).toBeTypeOf("string");
		const stdout = execFileSync("bash", ["-c", command], {
			cwd: root,
			encoding: "utf8",
		});
		expect(stdout).toContain("line two");
		expect(existsSync(path.join(root, "pwned"))).toBe(false);
	}, 30_000);

	it("quotes the path in the command sent over SSH too", async () => {
		mocks.deployment = {
			deploymentId: "dep-1",
			applicationId: "app-1",
			logPath: "/etc/dokploy/logs/a$(id)b.log",
			serverId: "server-1",
		};

		await caller().readLogs({ deploymentId: "dep-1", tail: 10 });

		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		expect(command).not.toContain('"/etc/dokploy/logs/a$(id)b.log"');
		expect(command).toContain("tail -n 10 ");
		expect(command).toMatch(/a\\\$\\\(id\\\)b\.log|'[^']*a\$\(id\)b\.log'/);
	});
});
