import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { describe, expect, it } from "vitest";
import { execErrorContext } from "../../server/sentry";

/**
 * An ExecError that reaches Sentry through the process-level handlers used to
 * arrive as a bare "Remote command failed with exit code 1" with no command,
 * server or output attached (DOKPLOY-COMMUNITY-2Z: 224 events, undiagnosable).
 * captureError now attaches the identifying fields, all scrubbed.
 */

describe("execErrorContext", () => {
	it("returns nothing for non-ExecError values", () => {
		expect(execErrorContext(new Error("x"))).toBeUndefined();
		expect(execErrorContext("x")).toBeUndefined();
		expect(execErrorContext(undefined)).toBeUndefined();
	});

	it("attaches the scrubbed command, exit code, server and output tails", () => {
		const command =
			'rclone rcat --s3-access-key-id="AKIAFAKEFAKEFAKE" --s3-secret-access-key="secret123" :s3:bucket/db.sql.gz';
		const error = new ExecError("Remote command failed with exit code 1", {
			command,
			stdout: "",
			stderr: `upload failed: ${command}\n${"x".repeat(2000)}`,
			exitCode: 1,
			serverId: "srv_123",
		});

		const context = execErrorContext(error);
		expect(context).toBeDefined();
		expect(context?.exitCode).toBe(1);
		expect(context?.serverId).toBe("srv_123");
		expect(context?.command).toContain("rclone rcat");
		expect(context?.stderrTail.length).toBeLessThanOrEqual(520);
		for (const leak of ["AKIAFAKEFAKEFAKE", "secret123"]) {
			expect(JSON.stringify(context)).not.toContain(leak);
		}
	});

	it("recognises an ExecError by name when the class identity differs", () => {
		const foreign = Object.assign(new Error("Remote command failed"), {
			name: "ExecError",
			command: "docker ps",
			exitCode: 2,
			serverId: null,
		});
		expect(execErrorContext(foreign)?.exitCode).toBe(2);
		expect(execErrorContext(foreign)?.command).toBe("docker ps");
	});
});
