import { inspect } from "node:util";
import { ExecError, execAsync } from "@dokploy/server/utils/process/execAsync";
import { describe, expect, it } from "vitest";

describe("execAsync failure", () => {
	it("does not leak secrets embedded in the command", async () => {
		const secret = "s3cr3t-value";
		// The secret is an argument node ignores, so the command line carries it
		// but nothing the command prints does.
		const error = await execAsync(`node -e "process.exit(3)" ${secret}`)
			.then(() => null)
			.catch((e) => e);

		expect(error).toBeInstanceOf(ExecError);
		expect(error.exitCode).toBe(3);
		expect(error.message).not.toContain(secret);
		expect(inspect(error)).not.toContain(secret);
	});

	it("keeps the command readable on the error but out of its enumerable keys", () => {
		const error = new ExecError("boom", {
			command: "docker ps",
			originalError: new Error("inner"),
		});

		expect(error.command).toBe("docker ps");
		expect(error.originalError?.message).toBe("inner");
		expect(Object.keys(error)).not.toContain("command");
		expect(Object.keys(error)).not.toContain("originalError");
		expect(JSON.stringify(error)).not.toContain("docker ps");
	});
});
