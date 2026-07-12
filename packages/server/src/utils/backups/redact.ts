/**
 * Redacts S3 credentials and rclone crypt passwords from rclone command strings.
 *
 * Used to prevent credential leakage in structured logs and error output.
 * Covers the deprecated flag form produced by `getS3Credentials()`:
 *   --s3-access-key-id="VALUE"  and  --s3-secret-access-key="VALUE"
 * and the connection-string / crypt form produced by `getRcloneS3Remote()`:
 *   access_key_id="VALUE", secret_access_key="VALUE",
 *   RCLONE_CRYPT_PASSWORD='VALUE'  and  RCLONE_CRYPT_PASSWORD2='VALUE'
 */
export const redactRcloneCredentials = (command: string): string => {
	return command
		.replace(/(--s3-access-key-id=)"[^"]*"/g, '$1"[REDACTED]"')
		.replace(/(--s3-secret-access-key=)"[^"]*"/g, '$1"[REDACTED]"')
		.replace(/(access_key_id=)"[^"]*"/g, '$1"[REDACTED]"')
		.replace(/(secret_access_key=)"[^"]*"/g, '$1"[REDACTED]"')
		.replace(/(RCLONE_CRYPT_PASSWORD2?=)'[^']*'/g, "$1'[REDACTED]'");
};
