import { inspect } from "node:util";
import {
	getRemoteBuildCancelTarget,
	wrapCancelableRemoteBuild,
} from "@dokploy/server/utils/builders/remote-build-cancel";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Node puts the whole script it ran in `error.message`. execAsyncCancelable
// runs the command wrapped by `wrapCancelableRemoteBuild`, which quotes it with
// each `'` escaped, so the plain command never appears in that message.

const mockExec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	exec: mockExec,
}));

import {
	ExecError,
	execAsyncCancelable,
	withoutCommand,
} from "@dokploy/server/utils/process/execAsync";

const SECRET = "s3cr3t-value";
const target = getRemoteBuildCancelTarget("deploy-1");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("execAsyncCancelable failure", () => {
	it.each([
		["a plain command", `deploy --token ${SECRET}`],
		["a command with single quotes", `deploy --token '${SECRET}' --name 'a b'`],
	])("does not leak the secret of %s", async (_name, command) => {
		mockExec.mockImplementation((script: string, callback: Function) => {
			// What Node does: the script that was run, then the command's output.
			callback(
				Object.assign(new Error(`Command failed: ${script}\n`), { code: 2 }),
				"",
				"",
			);
			return { kill: vi.fn() };
		});

		const error = await execAsyncCancelable(command, target).then(
			() => null,
			(e) => e,
		);

		expect(error).toBeInstanceOf(ExecError);
		expect(error.exitCode).toBe(2);
		expect(error.message).not.toContain(SECRET);
		expect(inspect(error)).not.toContain(SECRET);
	});
});

describe("withoutCommand", () => {
	it("strips the command and its single-quote-escaped form", () => {
		const command = `echo '${SECRET}'`;
		const wrapped = wrapCancelableRemoteBuild(command, target);

		expect(wrapped).not.toContain(command);
		expect(wrapped).toContain(SECRET);
		expect(withoutCommand(`Command failed: ${wrapped}`, command)).not.toContain(
			SECRET,
		);
		expect(withoutCommand(`Command failed: ${command}`, command)).toBe(
			"Command failed: [command omitted]",
		);
	});

	it("leaves the message alone for an empty command", () => {
		expect(withoutCommand("Command failed", "")).toBe("Command failed");
	});
});
