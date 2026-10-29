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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

const {
	getLastUpdateAttempt,
	getUpdateData,
	isUpdateVersionMismatch,
	readDokployUpdateAttempt,
	summarizeUpdateError,
	UPDATE_ATTEMPT_SETTLE_MS,
	writeDokployUpdateAttempt,
} = await import("@dokploy/server/services/settings");

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

const base = {
	fromVersion: "v0.30.8-community.36",
	target: "v0.30.8-community.37",
	image: "ghcr.io/devinosolutions/dokploy-community:v0.30.8-community.37",
	startedAt: minutesAgo(30),
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
		await writeDokployUpdateAttempt(attempt, file);

		await expect(readDokployUpdateAttempt(file)).resolves.toEqual(attempt);
	});

	it.each([true, false])("keeps pinned: %s", async (pinned) => {
		await writeDokployUpdateAttempt(
			{ ...base, pinned, status: "pulling" },
			file,
		);

		expect((await readDokployUpdateAttempt(file))?.pinned).toBe(pinned);
	});

	it("replaces the previous attempt and leaves no temp file", async () => {
		await writeDokployUpdateAttempt({ ...base, status: "pulling" }, file);
		await writeDokployUpdateAttempt({ ...base, status: "updating" }, file);

		expect((await readDokployUpdateAttempt(file))?.status).toBe("updating");
		expect(readdirSync(dir)).toEqual(["dokploy-update-last-attempt.json"]);
	});

	it.skipIf(process.platform === "win32")("is owner-only", async () => {
		await writeDokployUpdateAttempt({ ...base, status: "pulling" }, file);

		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("stores the error on one line, masked and capped", async () => {
		await writeDokployUpdateAttempt(
			{
				...base,
				status: "failed",
				finishedAt: minutesAgo(1),
				error: `toomanyrequests\nToken: ghp_abc123 ${"x".repeat(500)}`,
			},
			file,
		);

		const { error } = JSON.parse(readFileSync(file, "utf8"));
		expect(error).not.toContain("\n");
		expect(error).not.toContain("ghp_abc123");
		expect(error).toContain("Token=***");
		expect(error.length).toBeLessThanOrEqual(300);
	});

	it("never throws when the file can't be written", async () => {
		const blocked = join(dir, "blocker");
		writeFileSync(blocked, "");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			writeDokployUpdateAttempt(
				{ ...base, status: "pulling" },
				join(blocked, "attempt.json"),
			),
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
			JSON.stringify({ ...base, status: "failed", finishedAt: 5, error: {} }),
		);

		await expect(readDokployUpdateAttempt(file)).resolves.toEqual({
			...base,
			status: "failed",
		});
	});

	it("adds the version check to the stored attempt", async () => {
		await expect(
			getLastUpdateAttempt("v0.30.8-community.36", file),
		).resolves.toBeNull();

		await writeDokployUpdateAttempt(
			{ ...base, status: "submitted", finishedAt: minutesAgo(10) },
			file,
		);
		await expect(
			getLastUpdateAttempt("v0.30.8-community.36", file),
		).resolves.toMatchObject({ target: base.target, versionMismatch: true });
		await expect(
			getLastUpdateAttempt(base.target, file),
		).resolves.toMatchObject({ versionMismatch: false });
	});
});

describe("update version mismatch", () => {
	const submitted = {
		...base,
		status: "submitted" as const,
		finishedAt: minutesAgo(6),
	};

	it("is true for a submitted release tag, over five minutes old, not running", () => {
		expect(
			isUpdateVersionMismatch(submitted, "v0.30.8-community.36", NOW),
		).toBe(true);
	});

	it("is true for an unpinned update whose resolved tag is not running", () => {
		const unpinned = { ...submitted, pinned: false };

		expect(isUpdateVersionMismatch(unpinned, "v0.30.8-community.36", NOW)).toBe(
			true,
		);
		expect(isUpdateVersionMismatch(unpinned, base.target, NOW)).toBe(false);
	});

	it("is false when the server runs the target", () => {
		expect(isUpdateVersionMismatch(submitted, base.target, NOW)).toBe(false);
	});

	it("is false within five minutes of the submit, true just past it", () => {
		const at = (ms: number) => ({
			...submitted,
			finishedAt: new Date(NOW - ms).toISOString(),
		});
		expect(
			isUpdateVersionMismatch(
				at(UPDATE_ATTEMPT_SETTLE_MS),
				"v0.30.8-community.36",
				NOW,
			),
		).toBe(false);
		expect(
			isUpdateVersionMismatch(
				at(UPDATE_ATTEMPT_SETTLE_MS + 1),
				"v0.30.8-community.36",
				NOW,
			),
		).toBe(true);
	});

	it.each(["pulling", "updating", "failed"] as const)(
		"is false while the status is %s",
		(status) => {
			expect(
				isUpdateVersionMismatch(
					{ ...submitted, status },
					"v0.30.8-community.36",
					NOW,
				),
			).toBe(false);
		},
	);

	it.each(["latest", `sha256:${"ab12".repeat(16)}`])(
		"is false for the target %s, which is not a release tag",
		(target) => {
			expect(
				isUpdateVersionMismatch(
					{ ...submitted, target },
					"v0.30.8-community.36",
					NOW,
				),
			).toBe(false);
		},
	);

	it("is false without a usable finish time", () => {
		expect(
			isUpdateVersionMismatch(
				{ ...submitted, finishedAt: undefined },
				"v0.30.8-community.36",
				NOW,
			),
		).toBe(false);
		expect(
			isUpdateVersionMismatch(
				{ ...submitted, finishedAt: "yesterday-ish" },
				"v0.30.8-community.36",
				NOW,
			),
		).toBe(false);
	});
});

describe("summarizeUpdateError", () => {
	it("falls back to a message when the error has none", () => {
		expect(summarizeUpdateError(new Error(""))).toMatch(/without a message/);
		expect(summarizeUpdateError(undefined)).toMatch(/without a message/);
	});

	it("collapses whitespace and keeps a short message as it is", () => {
		expect(summarizeUpdateError(new Error("  a\n\tb  "))).toBe("a b");
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
		fetchMock.mockResolvedValue(release("v0.30.8-community.37"));

		await expect(getUpdateData("v0.30.8-community.36")).resolves.toEqual({
			latestVersion: "v0.30.8-community.37",
			updateAvailable: true,
		});
	});

	it("reports an up to date server without a failure flag", async () => {
		fetchMock.mockResolvedValue(release("v0.30.8-community.36"));

		const data = await getUpdateData("v0.30.8-community.36");

		expect(data).toEqual({
			latestVersion: "v0.30.8-community.36",
			updateAvailable: false,
		});
		expect(data.checkFailed).toBeUndefined();
	});

	it.each([
		["a non-OK response", { ok: false, status: 403 }, "GitHub answered 403"],
		["a release without a tag", release(""), "no tag"],
		["a tag that isn't a version", release("nightly"), "could not be parsed"],
	])("flags the check as failed on %s", async (_name, response, reason) => {
		fetchMock.mockResolvedValue(response);

		const data = await getUpdateData("v0.30.8-community.36");

		expect(data).toMatchObject({
			latestVersion: null,
			updateAvailable: false,
			checkFailed: true,
		});
		expect(data.reason).toContain(reason);
	});

	it("flags the check as failed when GitHub can't be reached", async () => {
		fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

		await expect(getUpdateData("v0.30.8-community.36")).resolves.toMatchObject({
			updateAvailable: false,
			checkFailed: true,
		});
	});

	it("flags the check as failed when the running version can't be parsed", async () => {
		fetchMock.mockResolvedValue(release("v0.30.8-community.37"));

		await expect(getUpdateData("not-a-version")).resolves.toMatchObject({
			updateAvailable: false,
			checkFailed: true,
		});
	});
});
