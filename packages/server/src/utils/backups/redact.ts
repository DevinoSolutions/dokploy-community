import { redactSecrets } from "../process/redactSecrets";

/**
 * Redacts credentials from rclone command strings before they reach structured
 * logs or error output.
 *
 * This is a thin alias over the shared {@link redactSecrets} redactor so the
 * logger path and the thrown-error path (ExecError, Sentry) share ONE source of
 * truth. `redactSecrets` covers S3 access/secret/session keys, SFTP/FTP
 * passwords, database passwords (PGPASSWORD/MYSQL_PWD/MONGO*),
 * RCLONE_CONFIG_*_PASS and RCLONE_CRYPT_PASSWORD* env vars, and Authorization
 * headers, in bare, single-quoted and double-quoted forms — the shapes
 * `getS3Credentials()` (shell-quote) and `buildRcloneCommand()` produce.
 */
export const redactRcloneCredentials = (command: string): string =>
	redactSecrets(command);
