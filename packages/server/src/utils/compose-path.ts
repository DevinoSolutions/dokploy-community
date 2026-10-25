import { TRPCError } from "@trpc/server";
import { z } from "zod";

/**
 * Rules for the compose file path of a compose (`composePath`, T-8238), and
 * the part of them an application's build settings share
 * (`getCheckoutPathError`, T-8282). The compose path is a
 * relative path naming the compose file inside the repository checkout, such
 * as `./docker-compose.yml` or `deploy/compose.prod.yml`.
 *
 * Two levels. A path saved through the API must pass all of them. A path read
 * from the database at deploy time (a row saved before these rules) is only
 * refused for the first group, so an unusual stored path keeps deploying:
 *
 * - refused everywhere: empty, absolute (`/` or `~`), a `..` segment, a
 *   control character, or an unsupported character
 *   (`` ` $ ; & | < > ( ) ' " \ ``);
 * - also refused when saved: any character other than letters, numbers,
 *   spaces and `. _ - / @ + , = :`, a leading or trailing space, a leading
 *   `-`, a trailing `/`, or more than COMPOSE_PATH_MAX_LENGTH characters.
 *
 * Each returns the reason a path is refused, or `null` when it is fine.
 */
export const COMPOSE_PATH_MAX_LENGTH = 255;

// biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DISALLOWED_CHARACTER = /[`$;&|<>()'"\\]/;
const SAVED_CHARACTERS = /^[A-Za-z0-9._/ @+,=:-]+$/;

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
	if (DISALLOWED_CHARACTER.test(composePath)) {
		return "the compose path contains an unsupported character";
	}
	if (composePath.startsWith("/") || composePath.startsWith("~")) {
		return "the compose path must be relative to the repository root";
	}
	return getCheckoutPathError(composePath, "the compose path");
};

/**
 * The rules every path inside the checkout shares, the compose path above or
 * an application's build settings (build path, Dockerfile, Docker context,
 * publish directory, T-8282): a control character, a backslash or a `..`
 * segment is refused. `label` names the path in the reason. `parentSegments`
 * lets `..` through, for a caller that checks where the joined path resolves.
 */
export const getCheckoutPathError = (
	value: string,
	label: string,
	{ parentSegments = false }: { parentSegments?: boolean } = {},
): string | null => {
	if (CONTROL_CHARACTER.test(value)) {
		return `${label} contains a control character`;
	}
	if (value.includes("\\")) {
		return `${label} contains a backslash`;
	}
	if (!parentSegments && value.split("/").some((segment) => segment === "..")) {
		return `${label} leaves the repository`;
	}
	return null;
};

/**
 * The zod form of `getCheckoutPathError`, for the API inputs that take an
 * application's build settings. A leading `/` is the top of the repository,
 * so `/`, `/apps/web`, `./apps/web` and `apps/web` are all accepted.
 */
export const checkoutPathSchema = (
	label: string,
	options?: { parentSegments?: boolean },
) =>
	z.string().superRefine((value, ctx) => {
		const reason = getCheckoutPathError(value, label, options);
		if (reason) {
			ctx.addIssue({ code: "custom", message: `Invalid path: ${reason}` });
		}
	});

export const getComposePathError = (composePath: unknown): string | null => {
	const stored = getStoredComposePathError(composePath);
	if (stored) return stored;
	const path = composePath as string;
	if (path.length > COMPOSE_PATH_MAX_LENGTH) {
		return `the compose path is longer than ${COMPOSE_PATH_MAX_LENGTH} characters`;
	}
	if (!SAVED_CHARACTERS.test(path)) {
		return "the compose path can only contain letters, numbers, spaces and . _ - / @ + , = :";
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
 * Throws when a stored compose path is refused, before anything reads, writes
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
