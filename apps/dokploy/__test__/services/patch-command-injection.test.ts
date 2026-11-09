import { exec } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateApplyPatchesCommand } from "@dokploy/server/services/patch";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const execAsync = promisify(exec);

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	paths: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: mocks.findComposeById,
}));

vi.mock("@dokploy/server/constants", () => ({
	paths: mocks.paths,
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { patch: { findMany: mocks.findMany } } },
}));

const baseDir = mkdtempSync(join(tmpdir(), "patch-poc-"));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findApplicationById.mockResolvedValue({ appName: "demo-app" });
	mocks.paths.mockReturnValue({
		APPLICATIONS_PATH: baseDir,
		COMPOSE_PATH: baseDir,
	});
});

afterAll(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

const OUTSIDE = /file path outside the service's code directory/;

const run = (id: string) =>
	generateApplyPatchesCommand({ id, type: "application", serverId: null });

describe("generateApplyPatchesCommand hardening", () => {
	it("neutralizes command substitution in a create patch filePath", async () => {
		const marker = join(baseDir, "PWNED_CREATE");
		mocks.findMany.mockResolvedValue([
			{
				enabled: true,
				type: "create",
				filePath: ` z$(touch ${marker})`,
				content: "x",
			},
		]);

		// The fork refuses such a path before any command is built (T-7878), stricter than
		// quoting it, so nothing runs and no marker file can appear.
		await expect(run("app1")).rejects.toThrow(OUTSIDE);
		await expect(
			execAsync(`test -e ${JSON.stringify(marker)}`),
		).rejects.toBeTruthy();
	});

	it("neutralizes command substitution in a delete patch filePath", async () => {
		const marker = join(baseDir, "PWNED_DELETE");
		mocks.findMany.mockResolvedValue([
			{
				enabled: true,
				type: "delete",
				filePath: ` z$(touch ${marker})`,
				content: "",
			},
		]);

		// The fork refuses such a path before any command is built (T-7878), stricter than
		// quoting it, so nothing runs and no marker file can appear.
		await expect(run("app2")).rejects.toThrow(OUTSIDE);
		await expect(
			execAsync(`test -e ${JSON.stringify(marker)}`),
		).rejects.toBeTruthy();
	});

	it("rejects a path that traverses outside the code directory", async () => {
		mocks.findMany.mockResolvedValue([
			{
				enabled: true,
				type: "create",
				filePath: "../../../../../../../../tmp/dokploy-escape",
				content: "x",
			},
		]);

		await expect(run("app3")).rejects.toThrow(OUTSIDE);
	});
});
