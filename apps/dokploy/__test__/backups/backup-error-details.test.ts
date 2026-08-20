import {
	buildBackupErrorMessage,
	MAX_BACKUP_LOG_TAIL,
} from "@dokploy/server/utils/backups/log-tail";
import {
	ExecError,
	truncateOutputTail,
} from "@dokploy/server/utils/process/ExecError";
import { describe, expect, it } from "vitest";

// Volume backups redirect stdout AND stderr into the deployment log, so the
// thrown ExecError carries no output at all — tar failures reached Sentry and
// the notification with an empty message. buildBackupErrorMessage folds the
// recovered output back into the message.

describe("truncateOutputTail", () => {
	it("keeps short output untouched", () => {
		expect(truncateOutputTail("  tar: permission denied \n")).toBe(
			"tar: permission denied",
		);
	});

	it("keeps the END of long output", () => {
		const long = `${"a".repeat(5000)}THE-ACTUAL-ERROR`;
		const tail = truncateOutputTail(long, 100);
		expect(tail).toContain("THE-ACTUAL-ERROR");
		expect(tail.startsWith("...(truncated)...")).toBe(true);
		expect(tail.length).toBe("...(truncated)...".length + 100);
	});

	it("defaults to a 2000 character budget", () => {
		expect(MAX_BACKUP_LOG_TAIL).toBe(2000);
		expect(truncateOutputTail("b".repeat(3000)).length).toBe(
			"...(truncated)...".length + 2000,
		);
	});
});

describe("buildBackupErrorMessage", () => {
	const execError = (stderr?: string) =>
		new ExecError("Remote command failed with exit code 2", {
			command: "tar cvf /backup/x.tar .",
			stderr,
		});

	it("appends the log tail when the error carries no output", () => {
		const message = buildBackupErrorMessage(
			execError(),
			"tar: /volume_data: Cannot open: No such file or directory",
		);
		expect(message).toContain("Remote command failed with exit code 2");
		expect(message).toContain("Cannot open: No such file or directory");
	});

	it("prefers the error's own stderr over the log tail", () => {
		const message = buildBackupErrorMessage(
			execError("tar: unexpected EOF"),
			"some older log content",
		);
		expect(message).toContain("tar: unexpected EOF");
		expect(message).not.toContain("some older log content");
	});

	it("never returns an empty message", () => {
		expect(buildBackupErrorMessage(new Error(""), "")).toBe(
			"Backup failed without an error message",
		);
	});

	it("does not duplicate output already present in the message", () => {
		const error = new Error("Command failed: tar\ntar: unexpected EOF");
		expect(buildBackupErrorMessage(error, "tar: unexpected EOF")).toBe(
			"Command failed: tar\ntar: unexpected EOF",
		);
	});

	it("redacts credentials recovered from the log", () => {
		const message = buildBackupErrorMessage(
			execError(),
			"rclone: --s3-secret-access-key=supersecret failed",
		);
		expect(message).not.toContain("supersecret");
	});

	it("truncates a huge log tail", () => {
		const message = buildBackupErrorMessage(execError(), "z".repeat(10000));
		expect(message.length).toBeLessThan(2200);
		expect(message).toContain("...(truncated)...");
	});

	it("handles non-Error throwables", () => {
		expect(buildBackupErrorMessage("boom", "")).toBe("boom");
	});
});
