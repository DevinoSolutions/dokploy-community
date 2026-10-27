import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeMigrationDelta,
	type MigrationJournalEntry,
	parseMigrationJournal,
} from "@dokploy/server/utils/dokploy-migration-delta";
import { isInstalledDokployImage } from "@dokploy/server/utils/dokploy-update-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnAsync: vi.fn(),
	execute: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {}, execute: mocks.execute },
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: mocks.spawnAsync,
}));

const {
	fetchTargetMigrationJournal,
	getUpdateMigrationDelta,
	readLastAppliedMigration,
	readRunningMigrationJournal,
} = await import("@dokploy/server/services/update-migration-delta");
const { readDokployRollbackPoint, recordDokployRollbackPoint } = await import(
	"@dokploy/server/services/settings"
);

const REPO = "ghcr.io/devinosolutions/dokploy-community";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"cd".repeat(32)}`;

const entry = (tag: string, when: number): MigrationJournalEntry => ({
	tag,
	when,
});
const RUNNING = [
	entry("0221_deployment_watchdog", 100),
	entry("0222_compose_policy_audit", 200),
];
const TARGET = [...RUNNING, entry("0224_deployment_pinned_commit", 300)];

const journal = (entries: MigrationJournalEntry[]) => ({
	entries: entries.map((e, idx) => ({
		idx,
		version: "7",
		...e,
		breakpoints: true,
	})),
});

describe("computeMigrationDelta", () => {
	it("lists the migrations the target adds to the running version", () => {
		expect(computeMigrationDelta({ running: RUNNING, target: TARGET })).toEqual(
			{
				applies: ["0224_deployment_pinned_commit"],
				staysApplied: [],
			},
		);
	});

	it("orders several by journal time, not by the order of the file", () => {
		const target = [entry("0226_b", 500), entry("0225_a", 400), ...RUNNING];
		expect(computeMigrationDelta({ running: RUNNING, target }).applies).toEqual(
			["0225_a", "0226_b"],
		);
	});

	it("finds nothing to apply for the same journal", () => {
		expect(computeMigrationDelta({ running: TARGET, target: TARGET })).toEqual({
			applies: [],
			staysApplied: [],
		});
	});

	it("lists what stays applied when the target is older", () => {
		expect(computeMigrationDelta({ running: TARGET, target: RUNNING })).toEqual(
			{
				applies: [],
				staysApplied: ["0224_deployment_pinned_commit"],
			},
		);
	});

	it("skips what the database is already past (after an image-only rollback)", () => {
		expect(
			computeMigrationDelta({
				running: RUNNING,
				target: TARGET,
				appliedUpTo: 300,
			}),
		).toEqual({ applies: [], staysApplied: [] });
	});

	it("applies what is newer than the database", () => {
		expect(
			computeMigrationDelta({
				running: RUNNING,
				target: TARGET,
				appliedUpTo: 200,
			}).applies,
		).toEqual(["0224_deployment_pinned_commit"]);
	});

	it("counts as staying applied only what the database has", () => {
		expect(
			computeMigrationDelta({
				running: TARGET,
				target: RUNNING,
				appliedUpTo: 200,
			}).staysApplied,
		).toEqual([]);
	});
});

describe("parseMigrationJournal", () => {
	it("reads the tag and time of every entry", () => {
		expect(parseMigrationJournal(journal(TARGET))).toEqual(TARGET);
	});

	it.each([
		["null", null],
		["no entries", { entries: [] }],
		["not a list", { entries: "x" }],
		["a tag that is not text", { entries: [{ tag: 1, when: 1 }] }],
		["a time that is not a number", { entries: [{ tag: "a", when: "1" }] }],
		["a null entry", { entries: [null] }],
	])("is not a journal with %s", (_name, raw) => {
		expect(parseMigrationJournal(raw)).toBeNull();
	});
});

describe("fetchTargetMigrationJournal", () => {
	const answer = (body: unknown, init: { ok?: boolean } = {}) =>
		vi.fn(async (_url: string, _init?: RequestInit) => ({
			ok: init.ok ?? true,
			text: async () =>
				typeof body === "string" ? body : JSON.stringify(body),
		}));
	const asFetch = (fn: ReturnType<typeof answer>) =>
		fn as unknown as typeof fetch;

	let error: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		error = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		error.mockRestore();
	});

	it("reads the journal at the release tag, read-only and with a timeout", async () => {
		const fetchImpl = answer(journal(TARGET));

		await expect(
			fetchTargetMigrationJournal("v0.30.8-community.35", asFetch(fetchImpl)),
		).resolves.toEqual(TARGET);

		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(
			"https://raw.githubusercontent.com/DevinoSolutions/dokploy-community/v0.30.8-community.35/apps/dokploy/drizzle/meta/_journal.json",
		);
		expect(init).toMatchObject({ method: "GET" });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		"latest",
		DIGEST,
		"main",
		"v0.30.8-community.35/../../x",
		"v0.30.8-community.35?x=1",
	])("never asks GitHub about %s, which is not a release tag", async (tag) => {
		const fetchImpl = answer(journal(TARGET));

		await expect(
			fetchTargetMigrationJournal(tag, asFetch(fetchImpl)),
		).resolves.toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("gives null for a missing tag", async () => {
		await expect(
			fetchTargetMigrationJournal(
				"v0.30.8-community.99",
				asFetch(answer("404: Not Found", { ok: false })),
			),
		).resolves.toBeNull();
	});

	it("gives null when GitHub can't be reached or times out", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("The operation was aborted due to timeout");
		}) as unknown as typeof fetch;

		await expect(
			fetchTargetMigrationJournal("v0.30.8-community.35", fetchImpl),
		).resolves.toBeNull();
	});

	it.each([
		["not JSON", "<html>rate limited</html>"],
		["not a journal", { hello: "world" }],
		["far too big", ` ${"x".repeat(2 * 1024 * 1024)}`],
	])("gives null when the answer is %s", async (_name, body) => {
		await expect(
			fetchTargetMigrationJournal(
				"v0.30.8-community.35",
				asFetch(answer(body)),
			),
		).resolves.toBeNull();
	});
});

describe("running side", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "t8014-journal-"));
		mocks.execute.mockReset();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads the journal the running image ships", async () => {
		mkdirSync(join(dir, "meta"));
		writeFileSync(
			join(dir, "meta", "_journal.json"),
			JSON.stringify(journal(RUNNING)),
		);

		await expect(readRunningMigrationJournal(dir)).resolves.toEqual(RUNNING);
	});

	it("gives null when there is no journal", async () => {
		await expect(readRunningMigrationJournal(dir)).resolves.toBeNull();
	});

	it("reads the last migration in the database (a bigint comes as text)", async () => {
		mocks.execute.mockResolvedValue([{ last: "1792895563500" }]);
		await expect(readLastAppliedMigration()).resolves.toBe(1792895563500);
	});

	it.each([
		["an empty table", [{ last: null }]],
		["no row", []],
	])("gives null for %s", async (_name, rows) => {
		mocks.execute.mockResolvedValue(rows);
		await expect(readLastAppliedMigration()).resolves.toBeNull();
	});

	it("gives null when the database can't be read", async () => {
		mocks.execute.mockRejectedValue(new Error("relation does not exist"));
		await expect(readLastAppliedMigration()).resolves.toBeNull();
	});
});

describe("getUpdateMigrationDelta", () => {
	const sources = (over: Record<string, unknown> = {}) => ({
		fetchTarget: vi.fn(async () => TARGET as MigrationJournalEntry[] | null),
		readRunning: vi.fn(async () => RUNNING as MigrationJournalEntry[] | null),
		readLastApplied: vi.fn(async () => 200 as number | null),
		...over,
	});

	it("says which migrations the target applies", async () => {
		await expect(
			getUpdateMigrationDelta(
				"v0.30.8-community.33",
				"v0.30.8-community.34",
				sources(),
			),
		).resolves.toEqual({
			status: "ok",
			runningVersion: "v0.30.8-community.33",
			targetVersion: "v0.30.8-community.34",
			applies: ["0224_deployment_pinned_commit"],
			staysApplied: [],
		});
	});

	it("falls back to the two journals when the database can't be read", async () => {
		const result = await getUpdateMigrationDelta(
			"v0.30.8-community.33",
			"v0.30.8-community.34",
			sources({ readLastApplied: vi.fn(async () => null) }),
		);
		expect(result).toMatchObject({
			status: "ok",
			applies: ["0224_deployment_pinned_commit"],
		});
	});

	it.each([
		["the target can't be resolved", { fetchTarget: vi.fn(async () => null) }],
		[
			"the running journal can't be read",
			{ readRunning: vi.fn(async () => null) },
		],
		[
			"a source throws",
			{
				fetchTarget: vi.fn(async () => {
					throw new Error("boom");
				}),
			},
		],
	])("is unavailable, not an error, when %s", async (_name, over) => {
		await expect(
			getUpdateMigrationDelta(
				"v0.30.8-community.33",
				"v0.30.8-community.34",
				sources(over),
			),
		).resolves.toEqual({ status: "unavailable" });
	});
});

describe("isInstalledDokployImage", () => {
	const TAG34 = `${REPO}:v0.30.8-community.34`;

	it.each([
		["a tag Docker resolved to a digest", `${TAG34}@${DIGEST}`, TAG34],
		["a bare tag", TAG34, TAG34],
		["a digest", `${REPO}@${DIGEST}`, `${REPO}@${DIGEST}`],
		[
			"a digest on a tagged spec",
			`${REPO}:v0.30.8-community.31@${DIGEST}`,
			`${REPO}@${DIGEST}`,
		],
	])("matches %s", (_name, current, installed) => {
		expect(isInstalledDokployImage(current, installed)).toBe(true);
	});

	it.each([
		["another tag", `${REPO}:v0.30.8-community.35@${DIGEST}`, TAG34],
		["another digest", `${REPO}@${OTHER_DIGEST}`, `${REPO}@${DIGEST}`],
		[
			"another repo",
			`ghcr.io/evil/dokploy-community:v0.30.8-community.34@${DIGEST}`,
			TAG34,
		],
		["an installed image with neither tag nor digest", TAG34, REPO],
		["an empty spec", "", TAG34],
	])("doesn't match %s", (_name, current, installed) => {
		expect(isInstalledDokployImage(current, installed)).toBe(false);
	});
});

describe("rollback record guard", () => {
	let dir: string;
	let file: string;
	const INSTALLED = `${REPO}:v0.30.8-community.34`;

	const spec = (image: string, state = "completed") => {
		mocks.spawnAsync.mockResolvedValue(Buffer.from(`${image} ${state}\n`));
	};
	const write = (point: Record<string, unknown>) =>
		writeFileSync(file, JSON.stringify(point));
	const point = {
		version: "v0.30.8-community.33",
		digest: DIGEST,
		installedImage: INSTALLED,
		recordedAt: "2026-10-27T10:00:00.000Z",
	};

	beforeEach(() => {
		mocks.spawnAsync.mockReset();
		dir = mkdtempSync(join(tmpdir(), "t8014-rollback-"));
		file = join(dir, "dokploy-update-rollback.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("stores the installed image and the time with the point", async () => {
		spec(`${REPO}:v0.30.8-community.33@${DIGEST}`);
		const before = Date.now();

		await recordDokployRollbackPoint("v0.30.8-community.33", {
			file,
			installedImage: INSTALLED,
		});

		const recorded = JSON.parse(readFileSync(file, "utf8"));
		expect(recorded).toMatchObject({
			version: "v0.30.8-community.33",
			digest: DIGEST,
			installedImage: INSTALLED,
		});
		expect(Date.parse(recorded.recordedAt)).toBeGreaterThanOrEqual(before);
	});

	it("offers the rollback, with its date, while the service runs the installed image", async () => {
		write(point);
		spec(`${INSTALLED}@${OTHER_DIGEST}`);

		await expect(
			readDokployRollbackPoint("v0.30.8-community.34", file),
		).resolves.toEqual(point);
	});

	it("offers nothing once the service runs another image", async () => {
		write(point);
		spec(`${REPO}:v0.30.8-community.35@${OTHER_DIGEST}`);

		await expect(
			readDokployRollbackPoint("v0.30.8-community.35", file),
		).resolves.toBeNull();
	});

	it("offers nothing when the service can't be inspected", async () => {
		write(point);
		mocks.spawnAsync.mockRejectedValue(new Error("Cannot connect to docker"));

		await expect(
			readDokployRollbackPoint("v0.30.8-community.34", file),
		).resolves.toBeNull();
	});

	it("still offers a point recorded without an installed image, without asking docker", async () => {
		write({ version: "v0.30.8-community.33", digest: DIGEST });

		await expect(
			readDokployRollbackPoint("v0.30.8-community.34", file),
		).resolves.toEqual({ version: "v0.30.8-community.33", digest: DIGEST });
		expect(mocks.spawnAsync).not.toHaveBeenCalled();
	});

	it("ignores a record date that is not a date", async () => {
		write({ ...point, recordedAt: "yesterday-ish" });
		spec(INSTALLED);

		const read = await readDokployRollbackPoint("v0.30.8-community.34", file);
		expect(read).not.toBeNull();
		expect(read).not.toHaveProperty("recordedAt");
	});

	describe("an update started while the previous one is still settling", () => {
		it.each(["updating", "paused", "rollback_started"])(
			"leaves no record while the service is %s",
			async (state) => {
				write(point);
				spec(`${INSTALLED}@${OTHER_DIGEST}`, state);

				await recordDokployRollbackPoint("v0.30.8-community.33", {
					file,
					installedImage: `${REPO}:v0.30.8-community.35`,
				});

				expect(existsSync(file)).toBe(false);
				await expect(
					readDokployRollbackPoint("v0.30.8-community.34", file),
				).resolves.toBeNull();
			},
		);

		it("replaces the record once the service has settled", async () => {
			write(point);
			spec(`${REPO}:v0.30.8-community.34@${OTHER_DIGEST}`, "completed");

			await recordDokployRollbackPoint("v0.30.8-community.34", {
				file,
				installedImage: `${REPO}:v0.30.8-community.35`,
			});

			expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
				version: "v0.30.8-community.34",
				digest: OTHER_DIGEST,
				installedImage: `${REPO}:v0.30.8-community.35`,
			});
		});
	});
});
