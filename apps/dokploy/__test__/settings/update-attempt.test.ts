import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
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
	claimDokployUpdateAttempt,
	getLastUpdateAttempt,
	getUpdateData,
	readDokployUpdateAttempt,
	transitionDokployUpdateAttempt,
} = await import("@dokploy/server/services/settings");

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

const OLD = "v0.30.8-community.36";
const NEW = "v0.30.8-community.37";

// Claims over whatever is recorded; the fixtures below are old enough that
// nothing they replace is still in progress.
const start = (attempt: IUpdateAttempt, file: string) =>
	claimDokployUpdateAttempt(attempt, { runningVersion: OLD, file });

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
		await start(attempt, file);

		await expect(readDokployUpdateAttempt(file)).resolves.toEqual(attempt);
	});

	it.each([true, false])("keeps pinned: %s", async (pinned) => {
		await start({ ...base, pinned }, file);

		expect((await readDokployUpdateAttempt(file))?.pinned).toBe(pinned);
	});

	it("replaces the previous attempt and leaves no temp file", async () => {
		await start(base, file);
		await start({ ...base, attemptId: "attempt-2" }, file);

		expect((await readDokployUpdateAttempt(file))?.attemptId).toBe("attempt-2");
		expect(readdirSync(dir)).toEqual(["dokploy-update-last-attempt.json"]);
	});

	it.skipIf(process.platform === "win32")("is owner-only", async () => {
		await start(base, file);

		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("never throws when the file can't be written", async () => {
		const blocked = join(dir, "blocker");
		writeFileSync(blocked, "");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(start(base, join(blocked, "attempt.json"))).resolves.toEqual({
			claimed: true,
			recorded: false,
		});

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
				await start(base, file);
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
			await start(base, file);
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
			await start(base, file);

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
			await start(base, file);
			await start(
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

	describe("claims", () => {
		const fresh = (attemptId: string, patch: Partial<IUpdateAttempt> = {}) => ({
			...base,
			attemptId,
			startedAt: new Date(NOW).toISOString(),
			...patch,
		});
		const claim = (
			attempt: IUpdateAttempt,
			options: { running?: string; force?: boolean; now?: number } = {},
		) =>
			claimDokployUpdateAttempt(attempt, {
				runningVersion: options.running ?? OLD,
				force: options.force,
				now: options.now ?? NOW,
				file,
			});

		it("claims when nothing is recorded, and leaves no lock behind", async () => {
			await expect(claim(fresh("a"))).resolves.toEqual({
				claimed: true,
				recorded: true,
			});

			expect(readdirSync(dir)).toEqual(["dokploy-update-last-attempt.json"]);
		});

		it("refuses while the recorded attempt is in progress, and keeps it", async () => {
			await claim(fresh("a"));

			await expect(claim(fresh("b"))).resolves.toEqual({
				claimed: false,
				reason: "in_progress",
			});
			expect((await readDokployUpdateAttempt(file))?.attemptId).toBe("a");
		});

		it.each([
			["failed", { status: "failed" as const }],
			["submitted", { status: "submitted" as const }],
			["interrupted (15 minutes old)", { startedAt: minutesAgo(15) }],
		])("claims over an attempt that is %s", async (_name, patch) => {
			await claim(fresh("a", patch));

			await expect(claim(fresh("b"))).resolves.toMatchObject({ claimed: true });
			expect((await readDokployUpdateAttempt(file))?.attemptId).toBe("b");
		});

		it("claims over an applied attempt: the swap is confirmed", async () => {
			await claim(fresh("a", { status: "updating" }));

			await expect(claim(fresh("b"), { running: NEW })).resolves.toMatchObject({
				claimed: true,
			});
		});

		it("claims over an in-progress attempt only when forced", async () => {
			await claim(fresh("a"));

			await expect(claim(fresh("b"), { force: true })).resolves.toMatchObject({
				claimed: true,
			});
			expect((await readDokployUpdateAttempt(file))?.attemptId).toBe("b");
		});

		it("lets exactly one of many truly overlapping claims win", async () => {
			// All eight are started before any of them has finished.
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) => claim(fresh(`attempt-${i}`))),
			);

			expect(results.filter((result) => result.claimed)).toHaveLength(1);
			expect(
				results.filter(
					(result) => !result.claimed && result.reason === "in_progress",
				),
			).toHaveLength(7);
			const winner = results.findIndex((result) => result.claimed);
			expect((await readDokployUpdateAttempt(file))?.attemptId).toBe(
				`attempt-${winner}`,
			);
		});

		it("lets exactly one claim win across two copies of the module (two containers)", async () => {
			// Each copy has its own in-process queue, so only the lock file
			// stands between them, as it does between two containers.
			vi.resetModules();
			const other = await import("@dokploy/server/services/settings");
			expect(other.claimDokployUpdateAttempt).not.toBe(
				claimDokployUpdateAttempt,
			);

			for (let round = 0; round < 10; round++) {
				const roundFile = join(dir, `round-${round}.json`);
				const results = await Promise.all(
					[claimDokployUpdateAttempt, other.claimDokployUpdateAttempt].flatMap(
						(claimIt, copy) =>
							[0, 1, 2].map((i) =>
								claimIt(fresh(`c${copy}-${i}`), {
									runningVersion: OLD,
									now: NOW,
									file: roundFile,
								}),
							),
					),
				);

				expect(results.filter((result) => result.claimed)).toHaveLength(1);
			}
		});

		it("reports busy while another process holds a fresh lock, writing nothing", async () => {
			writeFileSync(`${file}.lock`, "");

			await expect(claim(fresh("a"))).resolves.toEqual({
				claimed: false,
				reason: "busy",
			});
			await expect(readDokployUpdateAttempt(file)).resolves.toBeNull();
		});

		it("takes over a lock left by a crashed holder", async () => {
			writeFileSync(`${file}.lock`, "");
			const old = new Date(Date.now() - 60_000);
			utimesSync(`${file}.lock`, old, old);

			await expect(claim(fresh("a"))).resolves.toMatchObject({ claimed: true });
			expect(readdirSync(dir)).toEqual(["dokploy-update-last-attempt.json"]);
		});

		it("goes on unrecorded when the file can't be written", async () => {
			const blocked = join(dir, "blocker");
			writeFileSync(blocked, "");
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(
				claimDokployUpdateAttempt(fresh("a"), {
					runningVersion: OLD,
					file: join(blocked, "attempt.json"),
				}),
			).resolves.toEqual({ claimed: true, recorded: false });

			error.mockRestore();
		});

		it("takes the record from a pull that outlasted the cutoff: the old job loses it", async () => {
			// A's pull is still running 15 minutes in, so A reads interrupted.
			await claim(fresh("a"));
			const later = NOW + UPDATE_ATTEMPT_STALE_MS;

			await expect(
				claim(fresh("b", { startedAt: new Date(later).toISOString() }), {
					now: later,
				}),
			).resolves.toMatchObject({ claimed: true });

			// A's job, back from its pull, finds the record is no longer its own.
			await expect(
				transitionDokployUpdateAttempt("a", { status: "updating" }, file),
			).resolves.toBe(false);
			expect(await readDokployUpdateAttempt(file)).toMatchObject({
				attemptId: "b",
				status: "pulling",
			});
		});
	});

	describe("a process started by the swap", () => {
		// The job that wrote `updating` died with the old container; the new
		// process only has the file and its own version.
		const persistUpdating = (patch: Partial<IUpdateAttempt> = {}) =>
			start({ ...base, status: "updating", ...patch }, file);

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

	describe("a reinstall of the running version", () => {
		// The version string is the same before and after, so it proves nothing.
		const reinstall = (patch: Partial<IUpdateAttempt>) => ({
			fromVersion: NEW,
			expectedVersion: NEW,
			target: NEW,
			...patch,
		});

		it("is not applied while the job is still updating, and keeps blocking", () => {
			expect(
				outcome(
					reinstall({ status: "updating", startedAt: minutesAgo(1) }),
					NEW,
				),
			).toBe("in_progress");
		});

		it("reads interrupted, never applied, once the cutoff passes without a submit", () => {
			expect(
				outcome(
					reinstall({ status: "updating", startedAt: minutesAgo(16) }),
					NEW,
				),
			).toBe("interrupted");
		});

		it("is applied once the job itself reports submitted", () => {
			expect(
				outcome(
					reinstall({ status: "submitted", finishedAt: minutesAgo(1) }),
					NEW,
				),
			).toBe("applied");
		});

		it("still counts an update to another version as applied while updating", () => {
			expect(
				outcome({ status: "updating", startedAt: minutesAgo(1) }, NEW),
			).toBe("applied");
		});

		it("reaches the router guard as in_progress through getLastUpdateAttempt", async () => {
			const dir = mkdtempSync(join(tmpdir(), "update-attempt-"));
			const file = join(dir, "dokploy-update-last-attempt.json");
			await start(
				{
					...base,
					...reinstall({ status: "updating", startedAt: minutesAgo(1) }),
				},
				file,
			);

			await expect(getLastUpdateAttempt(NEW, file, NOW)).resolves.toMatchObject(
				{
					outcome: "in_progress",
				},
			);
			// And a second update is refused while it is.
			await expect(
				claimDokployUpdateAttempt(
					{ ...base, attemptId: "second" },
					{ runningVersion: NEW, now: NOW, file },
				),
			).resolves.toEqual({ claimed: false, reason: "in_progress" });
			rmSync(dir, { recursive: true, force: true });
		});
	});

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
		[
			"pull access denied for ghcr.io/x/y, repository does not exist or may require authorization",
			"pull",
			"registry_unauthorized",
		],
		["toomanyrequests: rate limit", "pull", "registry_rate_limited"],
		[
			'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/images/json": dial unix /var/run/docker.sock: connect: permission denied',
			"pull",
			"docker_unavailable",
		],
		[
			"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
			"pull",
			"docker_unavailable",
		],
		["mkdir /root/.docker: permission denied", "pull", "pull_failed"],
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
