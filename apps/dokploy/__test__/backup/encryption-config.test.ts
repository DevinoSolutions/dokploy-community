import type { Destination } from "@dokploy/server/services/destination";
import { redactRcloneCredentials } from "@dokploy/server/utils/backups/redact";
import {
	buildRcloneCommand,
	getRclonePathAndFlags,
} from "@dokploy/server/utils/backups/utils";
import { describe, expect, it, vi } from "vitest";

// obscurePassword shells out to `rclone obscure`; mock it for determinism.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: (file: string, args: string[], cb: any) => {
			if (file === "rclone" && args[0] === "obscure") {
				cb(null, { stdout: "obscured_pass" });
			} else {
				cb(null, { stdout: "" });
			}
		},
	};
});

const createDestination = (
	overrides: Partial<Destination> = {},
): Destination => ({
	destinationId: "dest-1",
	name: "Encrypted bucket",
	provider: "aws",
	accessKey: "ACCESS_KEY",
	secretAccessKey: "SECRET_KEY",
	bucket: "my-bucket",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	additionalFlags: null,
	organizationId: "org-1",
	createdAt: new Date("2024-01-01T00:00:00Z"),
	encryptionEnabled: false,
	encryptionKey: null,
	encryptionPassword2: null,
	filenameEncryption: "off",
	directoryNameEncryption: false,
	...overrides,
});

describe("rclone crypt command composition", () => {
	it("builds a runnable, redactable encrypted upload command", async () => {
		const destination = createDestination({
			encryptionEnabled: true,
			encryptionKey: "primary-pass",
			encryptionPassword2: "salt-pass",
			filenameEncryption: "standard",
			directoryNameEncryption: true,
		});

		const { flags, path, envVars } = await getRclonePathAndFlags(
			destination,
			"daily/db.sql.gz",
		);

		const command = buildRcloneCommand(
			`rclone rcat ${flags.join(" ")} "${path}"`,
			envVars,
		);

		// Env vars are prepended; the rclone path is a plain :crypt: remote.
		expect(command.startsWith("RCLONE_CRYPT_REMOTE=':s3:my-bucket'")).toBe(true);
		expect(command).toContain("RCLONE_CRYPT_FILENAME_ENCRYPTION=standard");
		expect(command).toContain("RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION=true");
		expect(command).toContain("RCLONE_CRYPT_PASSWORD='obscured_pass'");
		expect(command).toContain("RCLONE_CRYPT_PASSWORD2='obscured_pass'");
		expect(command).toContain('":crypt:daily/db.sql.gz"');

		// The crypt passwords and s3 secret must be redacted before logging.
		const redacted = redactRcloneCredentials(command);
		expect(redacted).not.toContain("obscured_pass");
		expect(redacted).not.toContain("SECRET_KEY");
		expect(redacted).toContain("RCLONE_CRYPT_PASSWORD='[REDACTED]'");
		expect(redacted).toContain("RCLONE_CRYPT_PASSWORD2='[REDACTED]'");
		expect(redacted).toContain('--s3-secret-access-key="[REDACTED]"');
	});

	it("leaves plain (unencrypted) destinations without env vars", async () => {
		const destination = createDestination();
		const { path, envVars } = await getRclonePathAndFlags(
			destination,
			"daily/db.sql.gz",
		);

		expect(envVars).toBe("");
		expect(path).toBe(":s3:my-bucket/daily/db.sql.gz");
		expect(buildRcloneCommand(`rclone rcat "${path}"`, envVars)).toBe(
			`rclone rcat ":s3:my-bucket/daily/db.sql.gz"`,
		);
	});
});
