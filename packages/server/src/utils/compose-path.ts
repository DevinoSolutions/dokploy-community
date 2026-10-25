import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * Rules for the compose file path of a compose (`composePath`, T-8238): a
 * relative path naming the compose file inside the repository checkout, such
 * as `./docker-compose.yml` or `deploy/compose.prod.yml`.
 *
 * Two levels. A path saved through the API must pass all of them. A path read
 * from the database at deploy time (a row saved before these rules) is only
 * refused when it is unsafe, so an unusual but harmless path keeps deploying:
 *
 * - unsafe, refused everywhere: empty, absolute (`/` or `~`), a `..` segment,
 *   a control character, or one of `` ` $ ; & | < > ( ) ' " \ ``;
 * - also refused when saved: any character other than letters, numbers,
 *   spaces, `.`, `_`, `-` and `/`, a leading or trailing space, a leading
 *   `-`, a trailing `/`, or more than COMPOSE_PATH_MAX_LENGTH characters.
 *
 * Each returns the reason a path is refused, or `null` when it is fine.
 */
export const COMPOSE_PATH_MAX_LENGTH = 255;

// biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SHELL_CHARACTER = /[`$;&|<>()'"\\]/;
const SAVED_CHARACTERS = /^[A-Za-z0-9._/ -]+$/;

export const getStoredComposePathError = (
	composePath: unknown,
): string | null => {
	if (typeof composePath !== "string" || composePath.trim().length === 0) {
		return "the compose path is empty";
	}
	if (composePath.length > 4096) {
		return "the compose path is too long";
	}
	if (CONTROL_CHARACTER.test(composePath)) {
		return "the compose path contains a control character";
	}
	if (SHELL_CHARACTER.test(composePath)) {
		return "the compose path contains a character that is not allowed in it";
	}
	if (composePath.startsWith("/") || composePath.startsWith("~")) {
		return "the compose path must be relative to the repository root";
	}
	if (composePath.split("/").some((segment) => segment === "..")) {
		return "the compose path leaves the repository";
	}
	return null;
};

export const getComposePathError = (composePath: unknown): string | null => {
	const stored = getStoredComposePathError(composePath);
	if (stored) return stored;
	const path = composePath as string;
	if (path.length > COMPOSE_PATH_MAX_LENGTH) {
		return `the compose path is longer than ${COMPOSE_PATH_MAX_LENGTH} characters`;
	}
	if (!SAVED_CHARACTERS.test(path)) {
		return "the compose path can only contain letters, numbers, spaces, dots, underscores, hyphens and slashes";
	}
	if (path.trim() !== path) {
		return "the compose path starts or ends with a space";
	}
	if (path.startsWith("-")) {
		return "the compose path cannot start with a hyphen";
	}
	if (path.endsWith("/")) {
		return "the compose path must name a file, not a directory";
	}
	return null;
};

/**
 * Throws when a stored compose path is unsafe, before anything reads, writes
 * or runs a file from it. The message is the one the deployment log shows.
 */
export const assertSafeComposePath = (composePath: unknown) => {
	const reason = getStoredComposePathError(composePath);
	if (reason) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Compose refused: ${reason}. Set the compose path in the compose's settings to a relative path inside the repository, such as ./docker-compose.yml, and deploy again.`,
		});
	}
};

/** The zod form of the rules, for every API input that takes a compose path. */
export const composePathSchema = z
	.string()
	.min(1)
	.superRefine((value, ctx) => {
		const reason = getComposePathError(value);
		if (reason) {
			ctx.addIssue({
				code: "custom",
				message: `Invalid compose path: ${reason}`,
			});
		}
	});
