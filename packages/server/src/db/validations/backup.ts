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
