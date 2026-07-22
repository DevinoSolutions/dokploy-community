// Dokploy embeds secrets directly into the shell commands it runs and into the
// generated backup scripts it streams: the SSH key written to /tmp/id_rsa when
// cloning over SSH, the base64 TLS key piped to `base64 -d` when provisioning
// certificates, and — for scheduled backups — rclone S3 access keys, SFTP/FTP
// passwords, database passwords (PGPASSWORD/MYSQL_PWD/MONGO*), rclone crypt
// passwords and Authorization headers. When such a command fails, Node embeds
// the entire command in the child_process error `message`, which is wrapped in
// an ExecError and can reach both logs AND crash reports (Sentry). These
// helpers strip that material before it can be persisted.
//
// Redaction here intentionally errs toward over-redaction: an error report that
// loses a benign token is preferable to one that leaks a live credential. The
// UNREDACTED stderr is still written to the per-backup local log file on the
// server (that path does not go through here) so operators keep full detail.

const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const BASE64_DECODE_PIPE = /echo "[A-Za-z0-9+/=]+"\s*\|\s*base64 -d/g;

// A flag/assignment value may be double-quoted, single-quoted, or a bare token —
// shell-quote leaves simple values bare and quotes the rest.
const QUOTED_OR_BARE = `("[^"]*"|'[^']*'|\\S+)`;

// Long-option flags whose value is a credential (rclone S3 / SFTP / FTP, plus a
// generic --password). Matched as `--flag=VALUE` or `--flag VALUE`.
const SECRET_FLAGS = [
	"s3-access-key-id",
	"s3-secret-access-key",
	"s3-session-token",
	"sftp-pass",
	"ftp-pass",
	"password",
];

// Env / inline assignment names (NAME=VALUE) whose value is a credential.
// Uppercase-anchored so it never matches lowercase rclone flags like
// `--s3-region`. Covers the explicit DB/rclone vars plus any *PASSWORD /
// *PASSWD / *SECRET / *TOKEN name.
const SECRET_ASSIGNMENT =
	"(?:PGPASSWORD|MYSQL_PWD|RCLONE_CONFIG_[A-Z0-9_]*_PASS|MONGO[A-Z0-9_]*(?:PASSWORD|PASS|PWD)|[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN)[0-9]*)";

/** Preserve the value's original quoting so the surrounding command stays valid. */
const quoteLike = (value: string): string => {
	if (value.startsWith('"')) return '"[REDACTED]"';
	if (value.startsWith("'")) return "'[REDACTED]'";
	return "[REDACTED]";
};

// Flag values are always rewritten to a double-quoted placeholder (valid shell
// regardless of the original form), matching the redactor's long-standing
// output for --s3-* flags.
const redactFlags = (value: string): string => {
	let out = value;
	for (const flag of SECRET_FLAGS) {
		out = out
			.replace(new RegExp(`(--${flag}=)${QUOTED_OR_BARE}`, "gi"), '$1"[REDACTED]"')
			.replace(
				new RegExp(`(--${flag}\\s+)${QUOTED_OR_BARE}`, "gi"),
				'$1"[REDACTED]"',
			);
	}
	return out;
};

const redactAssignments = (value: string): string =>
	value.replace(
		new RegExp(`\\b(${SECRET_ASSIGNMENT}=)${QUOTED_OR_BARE}`, "g"),
		(_m, name, v) => name + quoteLike(v),
	);

const redactAuthHeaders = (value: string): string =>
	value.replace(/(Authorization:\s*)([^"'\r\n]+)/gi, "$1[REDACTED]");

export const redactSecrets = (value: string): string =>
	redactAuthHeaders(
		redactAssignments(
			redactFlags(
				value
					.replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
					.replace(BASE64_DECODE_PIPE, 'echo "[REDACTED]" | base64 -d'),
			),
		),
	);

// Node's child_process errors repeat the failed command on `message`, `stack`
// and `cmd`, so redact those too when wrapping an original error.
export const redactErrorSecrets = <T extends Error>(error: T): T => {
	const candidate = error as T & { cmd?: string };
	candidate.message = redactSecrets(candidate.message);
	if (candidate.stack) {
		candidate.stack = redactSecrets(candidate.stack);
	}
	if (candidate.cmd) {
		candidate.cmd = redactSecrets(candidate.cmd);
	}
	return candidate;
};
