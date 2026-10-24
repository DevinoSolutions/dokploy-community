import { isAbsolute, join, posix, relative } from "node:path";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { z } from "zod";

/**
 * Rules for the file path of a patch (T-7878): a plain relative path naming a
 * file inside the repository checkout.
 *
 * - relative: no leading `/` or `~`;
 * - no `.`, `..` or empty segment; the posix-normalized form is the path;
 * - no `.git` segment, compared case-insensitively and ignoring trailing dots
 *   and spaces, and no `git~1`;
 * - no backslash and no control character.
 *
 * Returns the reason a path is refused, or `null` when it is fine.
 */
export const getPatchPathError = (filePath: unknown): string | null => {
	if (typeof filePath !== "string" || filePath.length === 0) {
		return "the file path is empty";
	}
	if (filePath.length > 4096) {
		return "the file path is too long";
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
	if (/[\u0000-\u001f\u007f]/.test(filePath)) {
		return "the file path contains a control character";
	}
	if (filePath.includes("\\")) {
		return "the file path contains a backslash";
	}
	if (filePath.startsWith("/") || filePath.startsWith("~")) {
		return "the file path must be relative to the repository root";
	}
	const segments = filePath.split("/");
	if (segments.some((segment) => segment === "")) {
		return "the file path has an empty segment";
	}
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return "the file path leaves the repository";
	}
	if (
		segments.some((segment) => {
			const name = segment.toLowerCase().replace(/[. ]+$/, "");
			return name === ".git" || name === "git~1";
		})
	) {
		return "the file path is inside the repository's .git directory";
	}
	if (posix.normalize(filePath) !== filePath) {
		return "the file path is not in its normal form";
	}
	return null;
};

export const isSafePatchPath = (filePath: unknown): filePath is string =>
	getPatchPathError(filePath) === null;

/** Throws a BAD_REQUEST the UI can show when `filePath` is refused. */
export const assertSafePatchPath = (filePath: unknown) => {
	const reason = getPatchPathError(filePath);
	if (reason) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Invalid patch file path: ${reason}. A patch can only name a file inside the service's repository.`,
		});
	}
};

/** The zod form of the rules, for every API input that takes a patch path. */
export const patchFilePathSchema = z
	.string()
	.min(1)
	.superRefine((value, ctx) => {
		const reason = getPatchPathError(value);
		if (reason) {
			ctx.addIssue({
				code: "custom",
				message: `Invalid patch file path: ${reason}`,
			});
		}
	});

/**
 * `<base>/<filePath>` for a path that passed the rules, after checking that
 * the joined path still lies under `base`. Throws otherwise.
 */
export const resolvePatchPath = (base: string, filePath: string) => {
	assertSafePatchPath(filePath);
	const fullPath = join(base, filePath);
	const rel = relative(base, fullPath);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith("../") ||
		rel.startsWith("..\\") ||
		isAbsolute(rel)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Invalid patch file path: it does not stay inside the service's repository.",
		});
	}
	return fullPath;
};

/**
 * Shell test that is true when any directory between `base` and the file, or
 * (with `includeFile`) the file itself, is a symbolic link.
 */
export const getPatchPathHasLinkTest = (
	base: string,
	filePath: string,
	{ includeFile }: { includeFile: boolean },
) => {
	const segments = filePath.split("/");
	const count = includeFile ? segments.length : segments.length - 1;
	const tests: string[] = [];
	for (let i = 1; i <= count; i++) {
		tests.push(`[ -L ${quote([join(base, ...segments.slice(0, i))])} ]`);
	}
	return tests.length > 0 ? tests.join(" || ") : "false";
};
