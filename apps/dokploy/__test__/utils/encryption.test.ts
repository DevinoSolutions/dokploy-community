import type { Destination } from "@dokploy/server/services/destination";
import {
	GENERIC_RCLONE_PROVIDER,
	buildRcloneCommand,
	getRclonePathAndFlags,
	isDestinationEncrypted,
} from "@dokploy/server/utils/backups/utils";
import { describe, expect, test, vi } from "vitest";

// obscurePassword shells out to `rclone obscure`; mock it so the crypt password
// env vars are deterministic in tests (matches backups.test.ts).
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

const createMockDestination = (
	overrides: Partial<Destination> = {},
): Destination => ({
	destinationId: "test-dest-id",
	name: "Test Destination",
	provider: "aws",
	accessKey: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	bucket: "my-bucket",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	additionalFlags: null,
	organizationId: "org-123",
	createdAt: new Date(),
	encryptionEnabled: false,
	encryptionKey: null,
	encryptionPassword2: null,
	filenameEncryption: "off",
	directoryNameEncryption: false,
	...overrides,
});

describe("getRclonePathAndFlags — S3 without encryption", () => {
	test("returns plain s3 remote path and no env vars", async () => {
		const destination = createMockDestination();
		const { flags, path, envVars } = await getRclonePathAndFlags(
			destination,
			"daily/db.sql.gz",
		);

		expect(envVars).toBe("");
		expect(path).toBe(":s3:my-bucket/daily/db.sql.gz");
		expect(path).not.toContain(":crypt:");
		expect(flags.join(" ")).toContain(
			`--s3-access-key-id="${destination.accessKey}"`,
		);
	});

	test("does not encrypt when encryption disabled even with a key", async () => {
		const destination = createMockDestination({
			encryptionEnabled: false,
			encryptionKey: "some-key",
		});
		const { path, envVars } = await getRclonePathAndFlags(destination, "f.gz");

		expect(envVars).toBe("");
		expect(path).not.toContain(":crypt:");
	});

	test("does not encrypt when enabled but no key", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: null,
		});
		const { path, envVars } = await getRclonePathAndFlags(destination, "f.gz");

		expect(envVars).toBe("");
		expect(path).not.toContain(":crypt:");
		expect(isDestinationEncrypted(destination)).toBe(false);
	});
});

describe("getRclonePathAndFlags — S3 with crypt encryption", () => {
	test("returns a quote-free :crypt: path and RCLONE_CRYPT_* env vars", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "my-encryption-key",
		});
		const { flags, path, envVars } = await getRclonePathAndFlags(
			destination,
			"daily/db.sql.gz",
		);

		expect(isDestinationEncrypted(destination)).toBe(true);
		// Path is a plain on-the-fly crypt remote — no quoting to lose in the shell.
		expect(path).toBe(":crypt:daily/db.sql.gz");
		expect(path).not.toContain('"');
		// The wrapped remote and options travel via env vars.
		expect(envVars).toContain("RCLONE_CRYPT_REMOTE=':s3:my-bucket'");
		expect(envVars).toContain("RCLONE_CRYPT_FILENAME_ENCRYPTION=off");
		expect(envVars).toContain("RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION=false");
		// Password is obscured (mocked to obscured_pass) and single-quoted.
		expect(envVars).toContain("RCLONE_CRYPT_PASSWORD='obscured_pass'");
		// S3 credentials still travel as flags applied to the wrapped backend.
		expect(flags.join(" ")).toContain("--s3-access-key-id=");
	});

	test("includes password2 env var when a salt password is set", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "primary",
			encryptionPassword2: "salt",
		});
		const { envVars } = await getRclonePathAndFlags(destination, "f.gz");

		expect(envVars).toContain("RCLONE_CRYPT_PASSWORD='obscured_pass'");
		expect(envVars).toContain("RCLONE_CRYPT_PASSWORD2='obscured_pass'");
	});

	test("omits password2 when not set", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "primary",
		});
		const { envVars } = await getRclonePathAndFlags(destination, "f.gz");
		expect(envVars).not.toContain("RCLONE_CRYPT_PASSWORD2");
	});

	test("reflects standard filename encryption", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "k",
			filenameEncryption: "standard",
		});
		const { envVars } = await getRclonePathAndFlags(destination, "f.gz");
		expect(envVars).toContain("RCLONE_CRYPT_FILENAME_ENCRYPTION=standard");
	});

	test("reflects obfuscate filename encryption", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "k",
			filenameEncryption: "obfuscate",
		});
		const { envVars } = await getRclonePathAndFlags(destination, "f.gz");
		expect(envVars).toContain("RCLONE_CRYPT_FILENAME_ENCRYPTION=obfuscate");
	});

	test("reflects directory name encryption", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "k",
			directoryNameEncryption: true,
		});
		const { envVars } = await getRclonePathAndFlags(destination, "f.gz");
		expect(envVars).toContain("RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION=true");
	});

	test("falls back to safe defaults for null/invalid crypt options", async () => {
		const destination = createMockDestination({
			encryptionEnabled: true,
			encryptionKey: "k",
			filenameEncryption: null as unknown as string,
			directoryNameEncryption: null as unknown as boolean,
		});
		const { envVars } = await getRclonePathAndFlags(destination, "f.gz");
		expect(envVars).toContain("RCLONE_CRYPT_FILENAME_ENCRYPTION=off");
		expect(envVars).toContain("RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION=false");
	});
});

describe("getRclonePathAndFlags — generic rclone remote with crypt", () => {
	test("wraps the generic remote via RCLONE_CRYPT_REMOTE", async () => {
		const destination = createMockDestination({
			provider: GENERIC_RCLONE_PROVIDER,
			bucket: "myremote:backups",
			additionalFlags: ["--fast-list"],
			encryptionEnabled: true,
			encryptionKey: "k",
		});
		const { flags, path, envVars } = await getRclonePathAndFlags(
			destination,
			"db.sql.gz",
		);

		expect(path).toBe(":crypt:db.sql.gz");
		expect(envVars).toContain("RCLONE_CRYPT_REMOTE='myremote:backups'");
		// Generic remotes carry the user's own flags, not S3 credential flags.
		expect(flags).toEqual(["--fast-list"]);
	});
});

describe("getRclonePathAndFlags — SFTP/FTP ignores crypt (out of scope)", () => {
	test("sftp destination does not produce a crypt remote or env vars", async () => {
		const destination = createMockDestination({
			provider: "sftp",
			endpoint: "sftp.example.com",
			region: "22",
			accessKey: "user",
			bucket: "backups",
			encryptionEnabled: true,
			encryptionKey: "k",
		});
		const { path, envVars } = await getRclonePathAndFlags(
			destination,
			"db.sql.gz",
		);

		expect(path).not.toContain(":crypt:");
		expect(path.startsWith(":sftp,")).toBe(true);
		expect(envVars).toBe("");
	});
});

describe("buildRcloneCommand", () => {
	test("returns the command unchanged when there are no env vars", () => {
		expect(buildRcloneCommand("rclone lsf remote")).toBe("rclone lsf remote");
		expect(buildRcloneCommand("rclone lsf remote", "")).toBe(
			"rclone lsf remote",
		);
	});

	test("prepends env vars when provided", () => {
		expect(
			buildRcloneCommand("rclone lsf remote", "RCLONE_CRYPT_PASSWORD='secret'"),
		).toBe("RCLONE_CRYPT_PASSWORD='secret' rclone lsf remote");
	});
});
