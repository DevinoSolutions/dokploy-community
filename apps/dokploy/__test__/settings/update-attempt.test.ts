import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyUpdateError,
	getUpdateAttemptOutcome,
	getUpdateAttemptPollMs,
	type IUpdateAttempt,
	UPDATE_ATTEMPT_SETTLE_MS,
	UPDATE_ATTEMPT_STALE_MS,
	UPDATE_ERROR_MESSAGES,
} from "@dokploy/server/utils/dokploy-update-attempt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

const {
	getLastUpdateAttempt,
	getUpdateData,
	readDokployUpdateAttempt,
	startDokployUpdateAttempt,
	transitionDokployUpdateAttempt,
} = await import("@dokploy/server/services/settings");

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

const OLD = "v0.30.8-community.36";
const NEW = "v0.30.8-community.37";

const base: IUpdateAttempt = {
	attemptId: "attempt-1",
	fromVersion: OLD,
	target: NEW,
	pinned: true,
	expectedVersion: NEW,
	image: `ghcr.io/devinosolutions/dokploy-community:${NEW}`,
	startedAt: minutesAgo(30),
	status: "pulling",
};

describe("update attempt file", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "update-attempt-"));
		file = join(dir, "dokploy-update-last-attempt.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips an attempt", async () => {
		const attempt = {
			...base,
			status: "submitted" as const,
			finishedAt: minutesAgo(29),
		};
		await startDokployUpdateAttempt(attempt, file);

		await expect(readDokployUpdateAttempt(file)).resolves.toEqual(attempt);
	});

	it.each([true, false])("keeps pinned: %s", async (pinned) => {
		await startDokployUpdateAttempt({ ...base, pinned }, file);

		expect((await readDokployUpdateAttempt(file))?.pinned).toBe(pinned);
	});

	it("replaces the previous attempt and leaves no temp file", async () => {
		await startDokployUpdateAttempt(base, file);
		await startDokployUpdateAttempt({ ...base, attemptId: "attempt-2" }, file);

		expect((await readDokployUpdateAttempt(file))?.attemptId).toBe("attempt-2");
		expect(readdirSync(dir)).toEqual(["dokploy-update-last-attempt.json"]);
	});

	it.skipIf(process.platform === "win32")("is owner-only", async () => {
		await startDokployUpdateAttempt(base, file);

		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("never throws when the file can't be written", async () => {
		const blocked = join(dir, "blocker");
		writeFileSync(blocked, "");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			startDokployUpdateAttempt(base, join(blocked, "attempt.json")),
		).resolves.toBeUndefined();

		error.mockRestore();
	});

	it("reads nothing from a missing, corrupt or malformed file", async () => {
		await expect(readDokployUpdateAttempt(file)).resolves.toBeNull();

		writeFileSync(file, "{not json");
		await expect(readDokployUpdateAttempt(file)).resolves.toBeNull();

		writeFileSync(file, JSON.stringify({ ...base, status: "exploded" }));
		await expect(readDokployUpdateAttempt(file)).resolves.toBeNull();

		writeFileSync(file, JSON.stringify({ status: "failed" }));
		await expect(readDokployUpdateAttempt(file)).resolves.toBeNull();
	});

	it("drops fields of the wrong type when reading", async () => {
		writeFileSync(
			file,
			JSON.stringify({ ...base, finishedAt: 5, pinned: "yes", errorCode: {} }),
		);

		const { pinned, finishedAt, errorCode, error, ...rest } = {
			...(await readDokployUpdateAttempt(file)),
		} as IUpdateAttempt;
		expect([pinned, finishedAt, errorCode, error]).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(rest.attemptId).toBe("attempt-1");
	});

	describe("secrets", () => {
		// What docker and registries really print, with credentials in it.
		const leaks = [
			'Error response from daemon: Head "https://ghcr.io/v2/devinosolutions/dokploy-community/manifests/v1": unauthorized: authentication required\nAuthorization: Bearer abc123',
			'Error response from daemon: Get "https://deploy:hunter2@registry.example.com/v2/": dial tcp: lookup registry.example.com: no such host',
			'Error response from daemon: Get "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:abcd?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAXX": net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
			"toomanyrequests: You have reached your pull rate limit. token=ghp_secret123",
			'failed to authorize: failed to fetch anonymous token: Get "https://auth.docker.io/token?scope=repository:x:pull&service=registry": EOF',
		];
		const secrets = [
			"abc123",
			"hunter2",
			"deadbeef",
			"AKIAXX",
			"ghp_secret123",
			"Bearer",
			"Authorization",
			"X-Amz-Signature",
			"auth.docker.io",
		];

		it.each(leaks)("never reaches the file or the query: %s", async (raw) => {
			for (const phase of ["pull", "update"] as const) {
				await startDokployUpdateAttempt(base, file);
				await transitionDokployUpdateAttempt(
					base.attemptId,
					{
						status: "failed",
						finishedAt: minutesAgo(1),
						errorCode: classifyUpdateError(new Error(raw), phase),
					},
					file,
				);

				const stored = readFileSync(file, "utf8");
				const queried = JSON.stringify(
					await getLastUpdateAttempt(OLD, file, NOW),
				);
				for (const secret of secrets) {
					expect(stored).not.toContain(secret);
					expect(queried).not.toContain(secret);
				}
			}
		});

		it("stores only the code, and the query shows its fixed message", async () => {
			await startDokployUpdateAttempt(base, file);
			await transitionDokployUpdateAttempt(
				base.attemptId,
				{
					status: "failed",
					finishedAt: minutesAgo(1),
					errorCode: "registry_unauthorized",
				},
				file,
			);

			expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty(
				"error",
			);
			await expect(getLastUpdateAttempt(OLD, file, NOW)).resolves.toMatchObject(
				{
					outcome: "failed",
					errorCode: "registry_unauthorized",
					error: UPDATE_ERROR_MESSAGES.registry_unauthorized,
				},
			);
		});

		it("ignores free text or an unknown code planted in the file", async () => {
			writeFileSync(
				file,
				JSON.stringify({
					...base,
					status: "failed",
					error: "Bearer abc123",
					errorCode: "Bearer abc123",
				}),
			);

			const attempt = await readDokployUpdateAttempt(file);
			expect(JSON.stringify(attempt)).not.toContain("abc123");
			expect(attempt).not.toHaveProperty("error");
		});
	});

	describe("transitions", () => {
		it("moves the attempt it belongs to", async () => {
			await startDokployUpdateAttempt(base, file);

			await expect(
				transitionDokployUpdateAttempt(
					base.attemptId,
					{ status: "updating" },
					file,
				),
			).resolves.toBe(true);
			expect((await readDokployUpdateAttempt(file))?.status).toBe("updating");
		});

		it("does not let a stale job overwrite a newer attempt", async () => {
			// A starts, then B replaces the record while A's job is still running.
			await startDokployUpdateAttempt(base, file);
			await startDokployUpdateAttempt(
				{ ...base, attemptId: "attempt-b", target: "v0.30.8-community.38" },
				file,
			);

			await expect(
				transitionDokployUpdateAttempt(
					base.attemptId,
					{ status: "failed", errorCode: "pull_failed" },
					file,
				),
			).resolves.toBe(false);

			const current = await readDokployUpdateAttempt(file);
			expect(current).toMatchObject({
				attemptId: "attempt-b",
				status: "pulling",
			});
			expect(current).not.toHaveProperty("errorCode");
		});

		it("writes nothing when no attempt is recorded", async () => {
			await expect(
				transitionDokployUpdateAttempt(
					base.attemptId,
					{ status: "updating" },
					file,
				),
			).resolves.toBe(false);
			expect(readdirSync(dir)).toEqual([]);
		});
	});

	describe("a process started by the swap", () => {
		// The job that wrote `updating` died with the old container; the new
		// process only has the file and its own version.
		const persistUpdating = (patch: Partial<IUpdateAttempt> = {}) =>
			startDokployUpdateAttempt(
				{ ...base, status: "updating", ...patch },
				file,
			);

		it("reports applied when it runs the expected version", async () => {
			await persistUpdating({ startedAt: minutesAgo(1) });

			await expect(getLastUpdateAttempt(NEW, file, NOW)).resolves.toMatchObject(
				{ status: "updating", outcome: "applied" },
			);
		});

		it("reports in progress while the old version still runs, then interrupted", async () => {
			await persistUpdating({ startedAt: minutesAgo(2) });
			await expect(getLastUpdateAttempt(OLD, file, NOW)).resolves.toMatchObject(
				{ outcome: "in_progress" },
			);

			await expect(
				getLastUpdateAttempt(OLD, file, NOW + 20 * 60_000),
			).resolves.toMatchObject({ outcome: "interrupted" });
		});

		it("leaves the stored file as it was", async () => {
			await persistUpdating();
			const before = readFileSync(file, "utf8");

			await getLastUpdateAttempt(NEW, file, NOW);

			expect(readFileSync(file, "utf8")).toBe(before);
		});

		it("returns null when nothing is recorded", async () => {
			await expect(getLastUpdateAttempt(OLD, file, NOW)).resolves.toBeNull();
		});
	});
});

describe("getUpdateAttemptOutcome", () => {
	const at = (patch: Partial<IUpdateAttempt>) => ({ ...base, ...patch });
	const outcome = (patch: Partial<IUpdateAttempt>, running = OLD) =>
		getUpdateAttemptOutcome(at(patch), running, NOW);

	it("is failed for a failed attempt, even when the version matches", () => {
		expect(outcome({ status: "failed" }, NEW)).toBe("failed");
	});

	it.each(["updating", "submitted"] as const)(
		"is applied when a %s attempt's expected version is running",
		(status) => {
			expect(outcome({ status, finishedAt: minutesAgo(1) }, NEW)).toBe(
				"applied",
			);
		},
	);

	it("does not call a pulling attempt applied: the swap has not started", () => {
		expect(outcome({ status: "pulling", startedAt: minutesAgo(1) }, NEW)).toBe(
			"in_progress",
		);
	});

	it.each(["pulling", "updating"] as const)(
		"is in progress for %s until the 15 minute cutoff, then interrupted",
		(status) => {
			const startedAt = (ms: number) => new Date(NOW - ms).toISOString();
			expect(
				outcome({ status, startedAt: startedAt(UPDATE_ATTEMPT_STALE_MS - 1) }),
			).toBe("in_progress");
			expect(
				outcome({ status, startedAt: startedAt(UPDATE_ATTEMPT_STALE_MS) }),
			).toBe("interrupted");
		},
	);

	describe("submitted", () => {
		const submitted = (finishedAgoMs: number) => ({
			status: "submitted" as const,
			finishedAt: new Date(NOW - finishedAgoMs).toISOString(),
		});

		it("is submitted within five minutes, mismatch just past it", () => {
			expect(outcome(submitted(UPDATE_ATTEMPT_SETTLE_MS))).toBe("submitted");
			expect(outcome(submitted(UPDATE_ATTEMPT_SETTLE_MS + 1))).toBe("mismatch");
		});

		it("is a mismatch for an unpinned update whose resolved tag is not running", () => {
			expect(outcome({ ...submitted(6 * 60_000), pinned: false })).toBe(
				"mismatch",
			);
			expect(outcome({ ...submitted(6 * 60_000), pinned: false }, NEW)).toBe(
				"applied",
			);
		});

		it("uses expectedVersion for a rollback, whose target is a digest", () => {
			const digest = `sha256:${"ab12".repeat(16)}`;
			const rollback = {
				...submitted(6 * 60_000),
				target: digest,
				expectedVersion: "v0.30.8-community.35",
			};

			expect(outcome(rollback, OLD)).toBe("mismatch");
			expect(outcome(rollback, "v0.30.8-community.35")).toBe("applied");
		});

		it("falls back to a release-tag target on a record without expectedVersion", () => {
			const { expectedVersion: _unused, ...legacy } = base;
			expect(
				getUpdateAttemptOutcome(
					{ ...legacy, ...submitted(6 * 60_000) },
					OLD,
					NOW,
				),
			).toBe("mismatch");
		});

		it.each([
			[
				"a digest target with no expectedVersion",
				`sha256:${"ab12".repeat(16)}`,
			],
			["latest", "latest"],
		])("never doubts %s", (_name, target) => {
			expect(
				outcome({
					...submitted(6 * 60_000),
					target,
					expectedVersion: undefined,
				}),
			).toBe("submitted");
		});

		it("is submitted without a usable finish time", () => {
			expect(outcome({ status: "submitted", finishedAt: undefined })).toBe(
				"submitted",
			);
			expect(outcome({ status: "submitted", finishedAt: "later" })).toBe(
				"submitted",
			);
		});
	});
});

describe("getUpdateAttemptPollMs", () => {
	it("polls fast while the outcome can still change, slowly otherwise", () => {
		expect(getUpdateAttemptPollMs("in_progress")).toBe(5_000);
		expect(getUpdateAttemptPollMs("submitted")).toBe(5_000);
		for (const outcome of [
			"applied",
			"failed",
			"interrupted",
			"mismatch",
		] as const) {
			expect(getUpdateAttemptPollMs(outcome)).toBe(30_000);
		}
		expect(getUpdateAttemptPollMs(undefined)).toBe(30_000);
	});
});

describe("classifyUpdateError", () => {
	it.each([
		["manifest unknown: manifest unknown", "pull", "manifest_not_found"],
		[
			"Head ...: unauthorized: authentication required",
			"pull",
			"registry_unauthorized",
		],
		[
			"denied: requested access to the resource is denied",
			"pull",
			"registry_unauthorized",
		],
		["toomanyrequests: rate limit", "pull", "registry_rate_limited"],
		["context deadline exceeded", "pull", "timeout"],
		["dial tcp: lookup ghcr.io: no such host", "pull", "registry_unreachable"],
		["something odd", "pull", "pull_failed"],
		["manifest unknown", "update", "service_update_failed"],
	] as const)("classifies %j (%s) as %s", (message, phase, code) => {
		expect(classifyUpdateError(new Error(message), phase)).toBe(code);
	});

	it("handles a non-Error value", () => {
		expect(classifyUpdateError(undefined, "pull")).toBe("pull_failed");
		expect(classifyUpdateError("timeout", "pull")).toBe("timeout");
	});
});

describe("getUpdateData", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const release = (tag_name: unknown) => ({
		ok: true,
		status: 200,
		json: async () => ({ tag_name }),
	});

	it("reports an available update", async () => {
		fetchMock.mockResolvedValue(release(NEW));

		await expect(getUpdateData(OLD)).resolves.toEqual({
			latestVersion: NEW,
			updateAvailable: true,
		});
	});

	it("reports an up to date server without a failure flag", async () => {
		fetchMock.mockResolvedValue(release(OLD));

		const data = await getUpdateData(OLD);

		expect(data).toEqual({ latestVersion: OLD, updateAvailable: false });
		expect(data.checkFailed).toBeUndefined();
	});

	it.each([
		["a non-OK response", { ok: false, status: 403 }, "GitHub answered 403"],
		["a release without a tag", release(""), "no tag"],
		["a tag that isn't a version", release("nightly"), "could not be parsed"],
	])("flags the check as failed on %s", async (_name, response, reason) => {
		fetchMock.mockResolvedValue(response);

		const data = await getUpdateData(OLD);

		expect(data).toMatchObject({
			latestVersion: null,
			updateAvailable: false,
			checkFailed: true,
		});
		expect(data.reason).toContain(reason);
	});

	it("flags the check as failed when GitHub can't be reached", async () => {
		fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

		await expect(getUpdateData(OLD)).resolves.toMatchObject({
			updateAvailable: false,
			checkFailed: true,
		});
	});

	it("flags the check as failed when the running version can't be parsed", async () => {
		fetchMock.mockResolvedValue(release(NEW));

		await expect(getUpdateData("not-a-version")).resolves.toMatchObject({
			updateAvailable: false,
			checkFailed: true,
		});
	});
});
