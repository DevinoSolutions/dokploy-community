#!/usr/bin/env node
// Fails the security audit when a dated `pnpm audit` mute is missing,
// malformed, expired or too far out.
//
//   node scripts/check-audit-ignore-expiry.mjs [--today=YYYY-MM-DD]
//
// The mutes live in package.json `pnpm.auditConfig.ignoreGhsas`, and pnpm gives
// a mute no end date. JSON has no comments, so the date sits beside the list in
// the top-level `auditIgnoreExpiry` table, one entry per GHSA, in the same
// `expires=YYYY-MM-DD | reason` shape the DevinoSolutions/GetItDone audit guard
// reads from its pnpm-workspace.yaml comments:
//
//   "auditIgnoreExpiry": {
//     "GHSA-xxxx-xxxx-xxxx": "expires=2026-12-01 | why the mute is safe"
//   }
//
// A dated mute is a loan: the date must be after today (UTC; the expiry day
// itself is already expired) and at most MAX_AUDIT_IGNORE_DAYS out, so the
// audit job goes red, and stays red, once the date passes. A table entry for a
// GHSA that is no longer muted is refused too, so the two cannot drift apart,
// and so is a mute with no table entry: an undated mute is not allowed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_AUDIT_IGNORE_DAYS = 30;

const GHSA = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/i;
const EXPIRY = /^expires=(\d{4}-\d{2}-\d{2})\s*\|\s*(\S.*)$/;
const DAY_MS = 86_400_000;

/**
 * @param {unknown} pkg parsed root package.json
 * @param {string} today YYYY-MM-DD (UTC)
 * @returns {{ problems: string[] }}
 */
export function auditIgnoreProblems(pkg, today) {
	/** @type {string[]} */
	const problems = [];
	const root = /** @type {Record<string, any>} */ (pkg ?? {});
	/** @type {unknown} */
	const ignored = root.pnpm?.auditConfig?.ignoreGhsas ?? [];
	/** @type {unknown} */
	const table = root.auditIgnoreExpiry ?? {};
	if (!Array.isArray(ignored)) {
		return { problems: ["pnpm.auditConfig.ignoreGhsas must be an array"] };
	}
	if (typeof table !== "object" || table === null || Array.isArray(table)) {
		return {
			problems: ["auditIgnoreExpiry must be an object of GHSA -> expiry"],
		};
	}
	const dated = /** @type {Record<string, unknown>} */ (table);
	const todayMs = Date.parse(`${today}T00:00:00Z`);
	if (Number.isNaN(todayMs)) {
		return { problems: [`today (${today}) is not a date`] };
	}

	for (const ghsa of ignored) {
		if (typeof ghsa !== "string" || !GHSA.test(ghsa)) {
			problems.push(`ignoreGhsas holds ${JSON.stringify(ghsa)}, not a GHSA id`);
			continue;
		}
		if (!(ghsa in dated)) {
			problems.push(
				`${ghsa} is muted with no auditIgnoreExpiry entry: an undated mute is not allowed`,
			);
		}
	}

	for (const [ghsa, value] of Object.entries(dated)) {
		if (!ignored.includes(ghsa)) {
			problems.push(
				`auditIgnoreExpiry has ${ghsa}, which is not in pnpm.auditConfig.ignoreGhsas; delete the stale entry`,
			);
			continue;
		}
		const match = typeof value === "string" ? EXPIRY.exec(value.trim()) : null;
		if (!match) {
			problems.push(
				`${ghsa}: expected "expires=YYYY-MM-DD | reason", got ${JSON.stringify(value)}`,
			);
			continue;
		}
		const date = /** @type {string} */ (match[1]);
		const expiresMs = Date.parse(`${date}T00:00:00Z`);
		if (
			Number.isNaN(expiresMs) ||
			new Date(expiresMs).toISOString().slice(0, 10) !== date
		) {
			problems.push(`${ghsa}: ${date} is not a real date`);
			continue;
		}
		const days = Math.round((expiresMs - todayMs) / DAY_MS);
		if (days <= 0) {
			problems.push(
				`${ghsa}: the mute expired on ${date}; re-review the advisory, then set a new expiry or delete the mute`,
			);
		} else if (days > MAX_AUDIT_IGNORE_DAYS) {
			problems.push(
				`${ghsa}: ${date} is ${days} days away; the maximum is ${MAX_AUDIT_IGNORE_DAYS}`,
			);
		}
	}
	return { problems };
}

const isMain =
	typeof process.argv[1] === "string" &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
	const arg = process.argv.find((a) => a.startsWith("--today="));
	const today = arg
		? arg.slice("--today=".length)
		: new Date().toISOString().slice(0, 10);
	const pkgPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"package.json",
	);
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	const { problems } = auditIgnoreProblems(pkg, today);
	for (const problem of problems) console.log(`::error::${problem}`);
	if (problems.length > 0) {
		console.log(
			`audit ignore expiry: ${problems.length} problem(s) as of ${today}`,
		);
		process.exit(1);
	}
	const count = Object.keys(pkg.auditIgnoreExpiry ?? {}).length;
	console.log(
		`audit ignore expiry: ${count} dated mute(s) valid as of ${today}`,
	);
}
