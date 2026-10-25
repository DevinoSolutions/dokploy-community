import { beforeEach, describe, expect, it, vi } from "vitest";

// T-7960: a build-server compose deploy records the commit its fresh clone
// checked out, and a rebuild builds only when the checkout on disk still
// reports that commit.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
	updateDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	updateDeployment: mocks.updateDeployment,
}));

import { db } from "@dokploy/server/db";
import {
	assertRebuildCommitMatchesDeploy,
	findLastRecordedComposeCommit,
	recordDeployedCommit,
} from "@dokploy/server/services/compose-rebuild-pin";
import { COMMIT_READ_FAILED } from "@dokploy/server/utils/providers/pin-commit";

const findFirst = vi.mocked(db.query.deployments.findFirst);
const recorded = (pinnedCommit: string | null) =>
	findFirst.mockResolvedValue(
		(pinnedCommit === null ? undefined : { pinnedCommit }) as never,
	);

const rebuild = (servingCommitOutput: string | undefined) =>
	assertRebuildCommitMatchesDeploy({
		composeId: "compose-1",
		deploymentId: "dep-2",
		servingCommitOutput,
	});

beforeEach(() => {
	vi.clearAllMocks();
	findFirst.mockReset();
	findFirst.mockResolvedValue(undefined);
});

describe("deploy records the commit it checked out", () => {
	it("records the commit read right after the fetch", async () => {
		await expect(recordDeployedCommit("dep-1", `${SHA}\n`)).resolves.toBe(SHA);
		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-1", {
			pinnedCommit: SHA,
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
		await expect(recordDeployedCommit("dep-1", output)).resolves.toBeNull();
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("records nothing without a deployment row", async () => {
		await expect(recordDeployedCommit(undefined, SHA)).resolves.toBeNull();
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});
});

describe("the recorded commit", () => {
	it("is the compose's latest deployment row that has one", async () => {
		recorded(SHA);
		await expect(findLastRecordedComposeCommit("compose-1")).resolves.toBe(SHA);
		const [args] = findFirst.mock.calls[0] as [Record<string, unknown>];
		expect(args.columns).toEqual({ pinnedCommit: true });
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
	it("proceeds when the checkout is the recorded commit, and carries it forward", async () => {
		recorded(SHA);
		await expect(rebuild(`${SHA}\n`)).resolves.toBe(SHA);
		expect(mocks.updateDeployment).toHaveBeenCalledWith("dep-2", {
			pinnedCommit: SHA,
		});
	});

	it("refuses another commit, naming both", async () => {
		recorded(SHA);
		await expect(rebuild(`${OTHER}\n`)).rejects.toThrow(
			`The code on the serving host is commit ${OTHER}, not commit ${SHA} that the last deploy checked out.`,
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it("refuses when no deploy recorded a commit (deployed before this check)", async () => {
		await expect(rebuild(`${SHA}\n`)).rejects.toThrow(
			/No deploy of this compose recorded the commit it checked out.*Deploy it once/,
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});

	it.each([
		["a shell fragment", "$(reboot)"],
		["a short id", SHA.slice(0, 7)],
		["upper case", SHA.toUpperCase()],
		["a padded id", ` ${SHA}`],
	])(
		"refuses a recorded value that is %s, before reading the disk",
		async (_label, value) => {
			recorded(value);
			await expect(rebuild(`${SHA}\n`)).rejects.toThrow(
				"The commit recorded by the last deploy is not a full commit id",
			);
			expect(mocks.updateDeployment).not.toHaveBeenCalled();
		},
	);

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
		await expect(result).rejects.toThrow(
			"Could not read the commit checked out on the serving host",
		);
		await expect(result).rejects.toThrow(reason);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});
});
