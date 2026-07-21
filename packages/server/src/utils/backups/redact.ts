/**
 * Redacts S3 credentials and rclone crypt passwords from rclone command strings.
 *
 * Used to prevent credential leakage in structured logs and error output.
 * The flag value may be double-quoted, single-quoted, or an unquoted token,
 * because `getS3Credentials()` escapes values with shell-quote (which leaves
 * simple values bare and single-quotes/backslash-escapes the rest):
 *   --s3-access-key-id=VALUE  /  ="VALUE"  /  ='VALUE'
 * and the crypt password env vars produced by `getRclonePathAndFlags()` /
 * `buildRcloneCommand()`:
 *   RCLONE_CRYPT_PASSWORD='VALUE'  and  RCLONE_CRYPT_PASSWORD2='VALUE'
 */
export const redactRcloneCredentials = (command: string): string => {
	const value = `("[^"]*"|'[^']*'|\\S+)`;
	return command
		.replace(new RegExp(`(--s3-access-key-id=)${value}`, "g"), '$1"[REDACTED]"')
		.replace(
			new RegExp(`(--s3-secret-access-key=)${value}`, "g"),
			'$1"[REDACTED]"',
		)
		.replace(/(RCLONE_CRYPT_PASSWORD2?=)'[^']*'/g, "$1'[REDACTED]'");
};
