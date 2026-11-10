import { z } from "zod";

export const BACKUP_PATH_ERROR =
	"Must not contain control characters, newlines, backticks, $, double quotes or backslashes";

const SHELL_SPECIAL_CHARACTERS = '`$"\\';

/**
 * Backup prefixes and service names are interpolated into rclone and docker
 * command lines. Every sink shell-quotes them, so this check is a second layer:
 * it rejects control characters (newlines included) and the characters a shell
 * still interprets inside double quotes, and accepts every ordinary path such
 * as `daily/pg` or `my app/db 1`.
 */
export const isSafeBackupPath = (value: string) => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
		if (SHELL_SPECIAL_CHARACTERS.includes(character)) return false;
	}
	return true;
};

export const backupPathSchema = z
	.string()
	.refine(isSafeBackupPath, BACKUP_PATH_ERROR);

/**
 * A restorable volume backup is a relative `.tar` path below the destination
 * root. Rejects `..` segments and a leading slash, which would otherwise point
 * the download target outside the volume backups directory.
 */
export const isSafeRestoreFilePath = (value: string) =>
	value.endsWith(".tar") &&
	!value.startsWith("/") &&
	!value.split("/").includes("..");

/**
 * Whether a file picked for a restore lies below one of the destination
 * prefixes the service's own backups write to (`<prefix>/<file>`, the same
 * layout `normalizeS3Path` produces). A `..` segment or a leading slash is
 * never allowed, and a root prefix (empty after normalization) covers the whole
 * destination, as it does for the backups themselves.
 */
export const isBackupFileInPrefixes = (
	backupFile: string,
	prefixes: readonly string[],
) => {
	if (backupFile.startsWith("/") || backupFile.split("/").includes("..")) {
		return false;
	}
	return prefixes.some((prefix) => {
		const normalized = prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
		return normalized === "" || backupFile.startsWith(`${normalized}/`);
	});
};
