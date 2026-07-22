import { redactSecrets } from "@dokploy/server/utils/process/redactSecrets";
import { describe, expect, it } from "vitest";

// All key material below is synthetic: these base64 strings decode to the
// literal text "synthetic-test-not-a-real-...-key" and are not real keys.

describe("redactSecrets", () => {
	it("redacts a PEM private key block written to /tmp/id_rsa", () => {
		const secret = "c3ludGhldGljLXRlc3Qtbm90LWEtcmVhbC1wcml2YXRlLWtleQ==";
		const command =
			`echo "-----BEGIN OPENSSH PRIVATE KEY-----\n${secret}\n-----END OPENSSH PRIVATE KEY-----" > /tmp/id_rsa;` +
			"chmod 600 /tmp/id_rsa;git clone --branch main --depth 1 git@example.com:org/repo /code";

		const redacted = redactSecrets(command);

		expect(redacted).not.toContain(secret);
		expect(redacted).toContain("[REDACTED PRIVATE KEY]");
		expect(redacted).toContain("chmod 600 /tmp/id_rsa");
		expect(redacted).toContain("git clone --branch main");
	});

	it("redacts a base64 key piped to base64 -d", () => {
		const secret = "c3ludGhldGljLXRlc3Qtbm90LWEtcmVhbC1jZXJ0LWtleQ==";
		const command = `echo "${secret}" | base64 -d > "/etc/dokploy/cert.key";`;

		const redacted = redactSecrets(command);

		expect(redacted).not.toContain(secret);
		expect(redacted).toContain('echo "[REDACTED]" | base64 -d');
	});

	it("leaves commands without secrets untouched", () => {
		const command =
			"git clone --branch main --depth 1 git@github.com:org/repo.git /tmp/code";

		expect(redactSecrets(command)).toBe(command);
	});

	// All credentials below are obviously fake.
	it("redacts rclone S3 credential flags in every quoting form", () => {
		const doubleQuoted = redactSecrets(
			'rclone rcat --s3-access-key-id="AKIAFAKEFAKEFAKE" :s3:b/f',
		);
		expect(doubleQuoted).not.toContain("AKIAFAKEFAKEFAKE");
		expect(doubleQuoted).toContain('--s3-access-key-id="[REDACTED]"');

		// Flag values are always rewritten to a double-quoted placeholder,
		// regardless of the original quoting, which stays valid shell.
		const singleQuoted = redactSecrets(
			"rclone rcat --s3-secret-access-key='secret123' :s3:b/f",
		);
		expect(singleQuoted).not.toContain("secret123");
		expect(singleQuoted).toContain('--s3-secret-access-key="[REDACTED]"');

		const bare = redactSecrets("rclone rcat --s3-session-token=sessFAKE :s3:b/f");
		expect(bare).not.toContain("sessFAKE");
		expect(bare).toContain('--s3-session-token="[REDACTED]"');
	});

	it("keeps non-credential S3 flags intact", () => {
		const command =
			'rclone rcat --s3-region="eu-west-1" --s3-endpoint="https://s3.example.com" :s3:b/f';
		expect(redactSecrets(command)).toBe(command);
	});

	it("redacts SFTP/FTP passwords (space and equals forms)", () => {
		const redacted = redactSecrets(
			"rclone --sftp-pass 'sftpFAKE' --ftp-pass=\"ftpFAKE\" remote:",
		);
		expect(redacted).not.toContain("sftpFAKE");
		expect(redacted).not.toContain("ftpFAKE");
	});

	it("redacts database password env assignments", () => {
		expect(redactSecrets("PGPASSWORD='pgFAKE' pg_dump db")).toContain(
			"PGPASSWORD='[REDACTED]'",
		);
		expect(redactSecrets("MYSQL_PWD=mysqlFAKE mysqldump db")).toContain(
			"MYSQL_PWD=[REDACTED]",
		);
		expect(
			redactSecrets("MONGO_INITDB_ROOT_PASSWORD='mongoFAKE' mongodump"),
		).not.toContain("mongoFAKE");
	});

	it("redacts rclone crypt and config password env vars", () => {
		const redacted = redactSecrets(
			"RCLONE_CRYPT_PASSWORD='cryptFAKE1' RCLONE_CRYPT_PASSWORD2='cryptFAKE2' RCLONE_CONFIG_MYS3_PASS='cfgFAKE' rclone lsf MYS3:",
		);
		expect(redacted).not.toContain("cryptFAKE1");
		expect(redacted).not.toContain("cryptFAKE2");
		expect(redacted).not.toContain("cfgFAKE");
		expect(redacted).toContain("RCLONE_CRYPT_PASSWORD='[REDACTED]'");
		expect(redacted).toContain("RCLONE_CRYPT_PASSWORD2='[REDACTED]'");
	});

	it("redacts Authorization headers", () => {
		const redacted = redactSecrets(
			'curl -H "Authorization: Bearer tokenFAKE" https://example.com',
		);
		expect(redacted).not.toContain("tokenFAKE");
		expect(redacted).toContain("Authorization: [REDACTED]");
	});

	it("scrubs a full generated backup command end to end", () => {
		const command =
			`PGPASSWORD='pgFAKEpass' pg_dump -U dokploy mydb | ` +
			`RCLONE_CRYPT_PASSWORD='cryptFAKE1' RCLONE_CRYPT_PASSWORD2='cryptFAKE2' ` +
			`rclone rcat --s3-access-key-id="AKIAFAKEFAKEFAKE" ` +
			`--s3-secret-access-key="secret123" --s3-session-token="sessFAKE" ` +
			`--s3-region="us-east-1" :s3:my-bucket/daily/db.sql.gz`;

		const redacted = redactSecrets(command);

		for (const secret of [
			"pgFAKEpass",
			"cryptFAKE1",
			"cryptFAKE2",
			"AKIAFAKEFAKEFAKE",
			"secret123",
			"sessFAKE",
		]) {
			expect(redacted).not.toContain(secret);
		}
		// Non-secret context is preserved for diagnosability.
		expect(redacted).toContain('--s3-region="us-east-1"');
		expect(redacted).toContain("pg_dump -U dokploy mydb");
	});
});
