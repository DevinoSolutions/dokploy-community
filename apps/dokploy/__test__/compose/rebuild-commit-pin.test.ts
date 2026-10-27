import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7960: a build-server compose deploy that passed its checks records what it
// built (commit, build server, patch rows), and a rebuild builds only when the
// checkout on disk and those are still the same.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const PATCH = {
	patchId: "p1",
	type: "update",
	filePath: "docker-compose.yml",
	content: "services: {}\n",
	enabled: true,
};
const OFF = { ...PATCH, patchId: "p2", enabled: false };

const mocks = vi.hoisted(() => ({
	updateDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	updateDeployment: mocks.updateDeployment,
}));

import { db } from "@dokploy/server/db";
import {
	assertRebuildCommitMatchesDeploy,
	digestAppliedPatches,
	findLastRecordedComposeCommit,
	isRebuildRefusedError,
	RebuildRefusedError,
	recordDeployedCommit,
} from "@dokploy/server/services/compose-rebuild-pin";
import { COMMIT_READ_FAILED } from "@dokploy/server/utils/providers/pin-commit";

const findFirst = vi.mocked(db.query.deployments.findFirst);
const recorded = (
	pinnedCommit: string | null,
	extra: {
		pinnedBuildServerId?: string | null;
		pinnedPatchDigest?: string | null;
	} = {},
) =>
	findFirst.mockResolvedValue(
		(pinnedCommit === null
			? undefined
			: {
					pinnedCommit,
					pinnedBuildServerId: "build-1",
					pinnedPatchDigest: digestAppliedPatches([PATCH] as never),
					...extra,
				}) as never,
	);

const rebuild = (
	servingCommitOutput: string | undefined,
	{
		buildServerId = "build-1",
		patches = [PATCH],
	}: { buildServerId?: string | null; patches?: unknown[] } = {},
) =>
	assertRebuildCommitMatchesDeploy({
		composeId: "compose-1",
		servingCommitOutput,
		buildServerId,
		patches: patches as never,
	});

const expectRefused = async (
	result: Promise<unknown>,
	message: string | RegExp,
) => {
	const error = await result.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(isRebuildRefusedError(error)).toBe(true);
	expect(error).toBeInstanceOf(RebuildRefusedError);
	expect((error as Error).message).toMatch(message);
};

beforeEach(() => {
	vi.clearAllMocks();
	findFirst.mockReset();
	findFirst.mockResolvedValue(undefined);
});

describe("patch digest", () => {
	it("covers only the enabled rows, in any order", () => {
		const second = { ...PATCH, patchId: "p3", filePath: "a.txt" };
		expect(digestAppliedPatches([PATCH, second, OFF] as never)).toBe(
			digestAppliedPatches([second, PATCH] as never),
		);
		expect(digestAppliedPatches([OFF] as never)).toBe(
			digestAppliedPatches(undefined),
		);
		expect(digestAppliedPatches([PATCH] as never)).toMatch(/^[0-9a-f]{64}$/);
	});

	it.each([
		["the content", { content: "services: { x: {} }\n" }],
		["the path", { filePath: "other.yml" }],
		["the type", { type: "delete" }],
		["the row", { patchId: "p9" }],
	])("changes with %s", (_label, change) => {
		expect(digestAppliedPatches([{ ...PATCH, ...change }] as never)).not.toBe(
			digestAppliedPatches([PATCH] as never),
		);
	});
});

describe("deploy records what it built", () => {
	it("records the commit, the build server and the patch digest", async () => {
		await expect(
			recordDeployedCommit("dep-1", {
				servingCommitOutput: `${SHA}\n`,
				buildServerId: "build-1",
				patches: [PATCH, OFF] as never,
			}),
		).resolves.toBe(SHA);
		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-1", {
			pinnedCommit: SHA,
			pinnedBuildServerId: "build-1",
			pinnedPatchDigest: digestAppliedPatches([PATCH] as never),
		});
	});

	it.each([
		["an empty read", ""],
		["a read that could not run", COMMIT_READ_FAILED],
		["a short id", SHA.slice(0, 12)],
		["a SHA-256 id", "a".repeat(64)],
		["upper case", SHA.toUpperCase()],
		["a shell fragment", `${SHA}; rm -rf /`],
		["two lines", `${SHA}\n${OTHER}`],
	])("records nothing for %s", async (_label, output) => {
		await expect(
			recordDeployedCommit("dep-1", {
				servingCommitOutput: output,
				buildServerId: "build-1",
				patches: [],
			}),
		).resolves.toBeNull();
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("records nothing without a deployment row or a build server", async () => {
		await expect(
			recordDeployedCommit(undefined, {
				servingCommitOutput: SHA,
				buildServerId: "build-1",
				patches: [],
			}),
		).resolves.toBeNull();
		await expect(
			recordDeployedCommit("dep-1", {
				servingCommitOutput: SHA,
				buildServerId: null,
				patches: [],
			}),
		).resolves.toBeNull();
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});
});

describe("the recorded commit", () => {
	it("is the compose's latest deployment row that has one", async () => {
		recorded(SHA);
		await expect(
			findLastRecordedComposeCommit("compose-1"),
		).resolves.toMatchObject({ pinnedCommit: SHA });
		const [args] = findFirst.mock.calls[0] as [Record<string, unknown>];
		expect(args.columns).toEqual({
			pinnedCommit: true,
			pinnedBuildServerId: true,
			pinnedPatchDigest: true,
		});
		expect(args.where).toBeDefined();
		expect(args.orderBy).toHaveLength(1);
	});

	it("is null when no row has one", async () => {
		await expect(
			findLastRecordedComposeCommit("compose-1"),
		).resolves.toBeNull();
	});
});

describe("rebuild", () => {
	it("proceeds when everything matches, writing nothing: the rebuild records after its release (T-8260)", async () => {
		recorded(SHA);
		await expect(rebuild(`${SHA}\n`)).resolves.toBe(SHA);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("proceeds when only a disabled row changed", async () => {
		recorded(SHA);
		await expect(rebuild(`${SHA}\n`, { patches: [PATCH, OFF] })).resolves.toBe(
			SHA,
		);
	});

	it("refuses another commit, naming both", async () => {
		recorded(SHA);
		await expectRefused(
			rebuild(`${OTHER}\n`),
			`The code on the serving host is commit ${OTHER}, not commit ${SHA} that the last deploy checked out.`,
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("refuses when no deploy recorded a commit (deployed before this check)", async () => {
		await expectRefused(
			rebuild(`${SHA}\n`),
			/No deploy of this compose recorded the commit it checked out.*Deploy it once/,
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it.each([
		["another build server", { buildServerId: "build-2" }],
		["no build server", { buildServerId: null }],
	])("refuses %s than the deploy recorded", async (_label, options) => {
		recorded(SHA);
		await expectRefused(
			rebuild(`${SHA}\n`, options),
			/another build server than at its last deploy.*Deploy it once/,
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("refuses a record without a build server", async () => {
		recorded(SHA, { pinnedBuildServerId: null });
		await expectRefused(rebuild(`${SHA}\n`), /another build server/);
	});

	it.each([
		["a row deleted", []],
		["a row disabled", [{ ...PATCH, enabled: false }]],
		["a row edited", [{ ...PATCH, content: "services: { x: {} }\n" }]],
		["a row added", [PATCH, { ...PATCH, patchId: "p4" }]],
	])(
		"refuses patches that changed since the deploy: %s",
		async (_label, patches) => {
			recorded(SHA);
			await expectRefused(
				rebuild(`${SHA}\n`, { patches }),
				/patches changed since its last deploy.*Deploy it once/,
			);
			expect(mocks.updateDeployment).not.toHaveBeenCalled();
		},
	);

	it("refuses a record without a patch digest", async () => {
		recorded(SHA, { pinnedPatchDigest: null });
		await expectRefused(rebuild(`${SHA}\n`), /patches changed/);
	});

	it.each([
		["a shell fragment", "$(reboot)"],
		["a short id", SHA.slice(0, 7)],
		["upper case", SHA.toUpperCase()],
		["a padded id", ` ${SHA}`],
	])("refuses a recorded value that is %s", async (_label, value) => {
		recorded(value);
		await expectRefused(
			rebuild(`${SHA}\n`),
			"The commit recorded by the last deploy is not a full commit id",
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it.each([
		["an empty read", "", "not a git checkout of its own"],
		[
			"a read that could not run",
			COMMIT_READ_FAILED,
			"connection or command failure",
		],
		["a SHA-256 checkout", "b".repeat(64), "SHA-256"],
		["no read at all", undefined, "not a git checkout of its own"],
	])("refuses %s of the checkout", async (_label, output, reason) => {
		recorded(SHA);
		const result = rebuild(output);
		await expectRefused(
			result,
			"Could not read the commit checked out on the serving host",
		);
		await expect(result).rejects.toThrow(reason);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});
});
