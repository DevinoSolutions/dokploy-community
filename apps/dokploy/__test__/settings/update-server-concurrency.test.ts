import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageInfo from "../../package.json";

/**
 * Two update requests that overlap, through the real router and the real
 * attempt file: only the Docker, GitHub and background-job edges are mocked,
 * so the concurrency guard itself is what decides.
 */

const state = vi.hoisted(() => ({
	file: "",
	// What the process running the guard reads about its own image.
	readRunning: undefined as
		| undefined
		| (() => Promise<{ digest?: string; processId?: string } | undefined>),
}));

const mocks = vi.hoisted(() => ({
	getDockerResourceType: vi.fn(),
	getUpdateData: vi.fn(),
	readDokployRollbackPoint: vi.fn(),
	readPulledImageDigest: vi.fn(),
	recordDokployRollbackPoint: vi.fn(),
	runBackgroundJob: vi.fn(),
	spawnAsync: vi.fn(),
	audit: vi.fn(async (_ctx: unknown, _event: unknown) => undefined),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

vi.mock("@dokploy/server", async () => {
	const real = await import("@dokploy/server/services/settings");
	return {
		IS_CLOUD: false,
		isRootOrganization: async () => true,
		UPDATE_PROCESS_ID: real.UPDATE_PROCESS_ID,
		getDockerResourceType: mocks.getDockerResourceType,
		getUpdateData: mocks.getUpdateData,
		readDokployRollbackPoint: mocks.readDokployRollbackPoint,
		readPulledImageDigest: mocks.readPulledImageDigest,
		recordDokployRollbackPoint: mocks.recordDokployRollbackPoint,
		runBackgroundJob: mocks.runBackgroundJob,
		spawnAsync: mocks.spawnAsync,
		// The real guard, pointed at a temp file.
		getLastUpdateAttempt: (...args: [string]) =>
			real.getLastUpdateAttempt(
				args[0],
				state.file,
				undefined,
				state.readRunning,
			),
		claimDokployUpdateAttempt: (
			...args: Parameters<typeof real.claimDokployUpdateAttempt>
		) =>
			real.claimDokployUpdateAttempt(args[0], {
				...args[1],
				file: state.file,
				readRunning: state.readRunning,
			}),
		transitionDokployUpdateAttempt: (
			...args: Parameters<typeof real.transitionDokployUpdateAttempt>
		) => real.transitionDokployUpdateAttempt(args[0], args[1], state.file),
	};
});

vi.mock("@dokploy/server/lib/auth", () => ({
	validateRequest: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: mocks.audit,
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

const { settingsRouter } = await import("@/server/api/routers/settings");
const { readDokployUpdateAttempt, UPDATE_PROCESS_ID } = await import(
	"@dokploy/server/services/settings"
);

const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "user-1", email: "admin@example.com", role: "owner" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

const LATEST = "v0.30.9-community.1";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

let dir: string;
let jobs: Promise<unknown>[];
let failures: unknown[];
let spawns: string[][];

const serviceUpdates = () =>
	spawns.filter(([, subcommand, action]) => {
		return subcommand === "service" && action === "update";
	});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "update-concurrency-"));
	state.file = join(dir, "dokploy-update-last-attempt.json");
	state.readRunning = undefined;
	jobs = [];
	failures = [];
	spawns = [];
	vi.clearAllMocks();
	mocks.runBackgroundJob.mockImplementation(
		(_label: string, job: () => unknown) => {
			const run = Promise.resolve()
				.then(job)
				.catch((error) => {
					failures.push(error);
				});
			jobs.push(run);
			return run;
		},
	);
	mocks.spawnAsync.mockReset();
	mocks.spawnAsync.mockImplementation(
		async (command: string, args: string[]) => {
			spawns.push([command, ...args]);
			return Buffer.from("");
		},
	);
	mocks.readPulledImageDigest.mockReset();
	mocks.readPulledImageDigest.mockResolvedValue(undefined);
	mocks.recordDokployRollbackPoint.mockReset();
	mocks.recordDokployRollbackPoint.mockResolvedValue(undefined);
	mocks.readDokployRollbackPoint.mockResolvedValue(null);
	mocks.getDockerResourceType.mockResolvedValue("service");
	mocks.getUpdateData.mockReset();
	mocks.getUpdateData.mockResolvedValue({
		latestVersion: LATEST,
		updateAvailable: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

describe("two overlapping updateServer requests", () => {
	it.each([
		["the GitHub call", "github"],
		["the docker manifest inspect", "manifest"],
	] as const)(
		"run one service update when both are held at %s",
		async (_name, where) => {
			const gate = deferred();
			if (where === "github") {
				mocks.getUpdateData.mockImplementation(async () => {
					await gate.promise;
					return { latestVersion: LATEST, updateAvailable: true };
				});
			} else {
				mocks.spawnAsync.mockImplementation(
					async (command: string, args: string[]) => {
						spawns.push([command, ...args]);
						if (args[0] === "manifest") {
							await gate.promise;
						}
						return Buffer.from("");
					},
				);
			}
			const request = () =>
				caller.updateServer(
					where === "manifest" ? { target: "v0.30.8-community.32" } : undefined,
				);

			// Both pass the early read, then stall in the slow call.
			const first = request();
			const second = request();
			await vi.waitFor(() =>
				expect(
					where === "github"
						? mocks.getUpdateData.mock.calls.length
						: spawns.filter(([, subcommand]) => subcommand === "manifest")
								.length,
				).toBe(2),
			);
			gate.resolve();
			const results = await Promise.allSettled([first, second]);
			await Promise.all(jobs);

			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const refused = results.find((result) => result.status === "rejected");
			expect((refused as PromiseRejectedResult).reason).toMatchObject({
				code: "CONFLICT",
			});
			expect(serviceUpdates()).toHaveLength(1);
			expect(
				spawns.filter(([, subcommand]) => subcommand === "pull"),
			).toHaveLength(1);
			expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledOnce();
			expect(mocks.audit).toHaveBeenCalledOnce();
			expect(failures).toEqual([]);
			expect(await readDokployUpdateAttempt(state.file)).toMatchObject({
				status: "submitted",
			});
		},
	);

	it("refuse the second one outright once the first has been claimed", async () => {
		const pull = deferred();
		mocks.spawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				spawns.push([command, ...args]);
				if (args[0] === "pull") {
					await pull.promise;
				}
				return Buffer.from("");
			},
		);

		await expect(caller.updateServer()).resolves.toBe(true);
		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "CONFLICT",
		});
		pull.resolve();
		await Promise.all(jobs);

		expect(serviceUpdates()).toHaveLength(1);
	});
});

describe("a pull that outlasts the 15 minute cutoff", () => {
	it("lets a new update start, and the old job then stops before the swap", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
		const slowPull = deferred();
		let pulls = 0;
		mocks.spawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				spawns.push([command, ...args]);
				if (args[0] === "pull" && ++pulls === 1) {
					await slowPull.promise;
				}
				return Buffer.from("");
			},
		);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await caller.updateServer();
		await vi.waitFor(() => expect(pulls).toBe(1));
		const first = await readDokployUpdateAttempt(state.file);
		expect(first?.status).toBe("pulling");

		// Still inside the window: refused.
		vi.setSystemTime(new Date("2026-10-29T12:14:59.000Z"));
		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "CONFLICT",
		});

		// Past it, the first attempt reads interrupted and a second may start.
		vi.setSystemTime(new Date("2026-10-29T12:15:00.000Z"));
		await expect(caller.updateServer()).resolves.toBe(true);
		const second = await readDokployUpdateAttempt(state.file);
		expect(second?.attemptId).not.toBe(first?.attemptId);
		await jobs[1];
		expect(serviceUpdates()).toHaveLength(1);

		// The first pull finally ends: its attempt is no longer the record.
		slowPull.resolve();
		await jobs[0];

		expect(serviceUpdates()).toHaveLength(1);
		expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledOnce();
		expect(await readDokployUpdateAttempt(state.file)).toMatchObject({
			attemptId: second?.attemptId,
			status: "submitted",
		});
		expect(failures).toEqual([]);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining(`attempt ${first?.attemptId} is no longer`),
		);
		error.mockRestore();
	});
});

describe("a reinstall of the running version", () => {
	// With stop-first the job dies in the swap and never writes `submitted`,
	// so the swapped-in container has to settle the record by its image.
	const DIGEST = `sha256:${"cd34".repeat(16)}`;

	it("blocks a new update until the swapped-in container runs the pulled image", async () => {
		const swap = deferred();
		mocks.readPulledImageDigest.mockResolvedValue(DIGEST);
		mocks.spawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				spawns.push([command, ...args]);
				if (args[0] === "service") {
					// The old container is stopped here and the job never returns.
					await swap.promise;
				}
				return Buffer.from("");
			},
		);
		const reinstall = () =>
			caller.updateServer({ target: packageInfo.version });

		await expect(reinstall()).resolves.toBe(true);
		await vi.waitFor(() => expect(serviceUpdates()).toHaveLength(1));
		expect(await readDokployUpdateAttempt(state.file)).toMatchObject({
			status: "updating",
			imageDigest: DIGEST,
			updatingBy: UPDATE_PROCESS_ID,
		});

		// The old container still runs the image: same digest, same process.
		state.readRunning = async () => ({
			digest: DIGEST,
			processId: UPDATE_PROCESS_ID,
		});
		await expect(reinstall()).rejects.toMatchObject({ code: "CONFLICT" });

		// A different image is running: not this attempt's.
		state.readRunning = async () => ({
			digest: `sha256:${"ef56".repeat(16)}`,
			processId: "swapped-in",
		});
		await expect(reinstall()).rejects.toMatchObject({ code: "CONFLICT" });

		// The digest can't be read: as before, the attempt stays in progress.
		state.readRunning = async () => undefined;
		await expect(reinstall()).rejects.toMatchObject({ code: "CONFLICT" });

		// The swapped-in container: the pulled image, another process.
		state.readRunning = async () => ({
			digest: DIGEST,
			processId: "swapped-in",
		});
		await expect(reinstall()).resolves.toBe(true);

		swap.resolve();
		await Promise.all(jobs);
		expect(failures).toEqual([]);
	});
});
