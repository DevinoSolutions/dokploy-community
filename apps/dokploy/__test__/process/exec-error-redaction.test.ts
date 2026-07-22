import { ExecError } from "@dokploy/server/utils/process/ExecError";
import { describe, expect, it } from "vitest";

// Reproduces the leak path behind the scheduled-backup failure reports: a
// generated backup command fails, Node embeds the ENTIRE command (with live
// rclone/S3 flags) in the child_process error message, and that message is
// wrapped into an ExecError which then reaches logs and Sentry. ExecError must
// scrub every field it carries. All credentials below are obviously fake.

describe("ExecError credential scrubbing", () => {
	const command =
		`RCLONE_CRYPT_PASSWORD='cryptFAKE' rclone rcat ` +
		`--s3-access-key-id="AKIAFAKEFAKEFAKE" ` +
		`--s3-secret-access-key="secret123" :s3:bucket/db.sql.gz`;

	const originalError = new Error(`Command failed: ${command}`);

	const error = new ExecError(`Command execution failed: ${command}`, {
		command,
		stdout: "",
		stderr: `rclone: failed to upload with ${command}`,
		exitCode: 1,
		originalError,
	});

	const leaks = ["cryptFAKE", "AKIAFAKEFAKEFAKE", "secret123"];

	it("scrubs the message", () => {
		for (const leak of leaks) {
			expect(error.message).not.toContain(leak);
		}
		expect(error.message).toContain("[REDACTED]");
	});

	it("scrubs the stored command and stderr", () => {
		for (const leak of leaks) {
			expect(error.command).not.toContain(leak);
			expect(error.stderr ?? "").not.toContain(leak);
		}
	});

	it("scrubs the wrapped original error message", () => {
		for (const leak of leaks) {
			expect(error.originalError?.message ?? "").not.toContain(leak);
		}
	});

	it("scrubs getDetailedMessage() output", () => {
		const detailed = error.getDetailedMessage();
		for (const leak of leaks) {
			expect(detailed).not.toContain(leak);
		}
	});
});
