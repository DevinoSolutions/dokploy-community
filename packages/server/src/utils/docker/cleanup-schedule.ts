import { z } from "zod";

/**
 * The nightly Docker cleanup schedule: a 5-field cron expression that is always
 * read in UTC, whatever the container's TZ is. This module is deliberately pure
 * (no db, no node-schedule) because the db schema imports it for input
 * validation, and the UI may too.
 */

export const DOCKER_CLEANUP_TIMEZONE = "Etc/UTC";

// Moves cleanup off the 23:50 slot the old fixed schedule used, which collided
// with late-night builds.
export const DEFAULT_DOCKER_CLEANUP_CRON = "0 4 * * *";

type FieldSpec = { name: string; min: number; max: number };

const FIELDS: FieldSpec[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	// 0 and 7 both mean Sunday.
	{ name: "day of week", min: 0, max: 7 },
];

const INTEGER = /^\d+$/;

/** The values one field allows, or an error message. */
const expandField = (
	raw: string,
	{ name, min, max }: FieldSpec,
): { values: Set<number> } | { error: string } => {
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const [range = "", step, ...extra] = part.split("/");
		if (extra.length > 0 || part === "") {
			return { error: `Invalid ${name} field "${raw}"` };
		}
		let stepValue = 1;
		if (step !== undefined) {
			if (!INTEGER.test(step) || Number(step) < 1) {
				return { error: `Invalid step in ${name} field "${raw}"` };
			}
			stepValue = Number(step);
		}
		let from: number;
		let to: number;
		if (range === "*") {
			from = min;
			to = max;
		} else {
			const [start = "", end, ...more] = range.split("-");
			if (more.length > 0 || !INTEGER.test(start)) {
				return {
					error: `Invalid ${name} field "${raw}" (use numbers, ranges, lists and steps)`,
				};
			}
			from = Number(start);
			if (end === undefined) {
				if (step !== undefined) {
					return { error: `Invalid ${name} field "${raw}"` };
				}
				to = from;
			} else {
				if (!INTEGER.test(end)) {
					return { error: `Invalid ${name} field "${raw}"` };
				}
				to = Number(end);
			}
		}
		if (from < min || to > max || from > to) {
			return { error: `${name} must be between ${min} and ${max}` };
		}
		for (let value = from; value <= to; value += stepValue) {
			values.add(value);
		}
	}
	return { values };
};

// Longest each month can be; February counts 29 because a leap year has it.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export type ParsedDockerCleanupCron =
	| { ok: true; expression: string }
	| { ok: false; message: string };

/**
 * Checks a cleanup schedule: exactly 5 cron fields (numbers, `*`, ranges, lists
 * and steps), and no more often than once an hour, so a fat-fingered `* * * * *`
 * cannot prune the host every minute. The expression comes back with its
 * whitespace collapsed.
 */
export const parseDockerCleanupCron = (
	input: string,
): ParsedDockerCleanupCron => {
	const fields = input.trim().split(/\s+/);
	if (fields.length !== 5 || fields[0] === "") {
		return {
			ok: false,
			message:
				"Use a 5-field cron expression: minute hour day-of-month month day-of-week (UTC), for example 0 4 * * *",
		};
	}
	const expandedFields: Array<Set<number>> = [];
	for (const [index, field] of fields.entries()) {
		const spec = FIELDS[index] as FieldSpec;
		const expanded = expandField(field, spec);
		if ("error" in expanded) {
			return { ok: false, message: expanded.error };
		}
		expandedFields.push(expanded.values);
		if (index === 0 && expanded.values.size > 1) {
			return {
				ok: false,
				message:
					"Docker cleanup can run at most once an hour: the minute field must be a single value",
			};
		}
	}
	// A day that no listed month has (31 February, 31 April) never fires:
	// node-schedule then returns no job at all and the host is never cleaned.
	// With a day-of-week the schedule can still fire on that weekday, so only a
	// day-of-month-only schedule is checked.
	const [, , days, months] = expandedFields as [
		Set<number>,
		Set<number>,
		Set<number>,
		Set<number>,
		Set<number>,
	];
	if (
		fields[4] === "*" &&
		![...months].some((month) =>
			[...days].some((day) => day <= (DAYS_IN_MONTH[month - 1] as number)),
		)
	) {
		return {
			ok: false,
			message: `Day ${fields[2]} never occurs in month ${fields[3]}, so the cleanup would never run`,
		};
	}
	return { ok: true, expression: fields.join(" ") };
};

/** Zod input for a cleanup schedule. Parses to the whitespace-collapsed expression. */
export const dockerCleanupCronSchema = z
	.string()
	.max(100)
	.transform((value, ctx) => {
		const parsed = parseDockerCleanupCron(value);
		if (!parsed.ok) {
			ctx.addIssue({ code: "custom", message: parsed.message });
			return z.NEVER;
		}
		return parsed.expression;
	});

/**
 * The node-schedule spec for a cleanup cron. The tz is explicit so the job does
 * not depend on the container's TZ. Falls back to the default when the stored
 * value is unreadable, so a bad row cannot leave a host without cleanup.
 */
export const dockerCleanupRule = (cron: string | null | undefined) => {
	const parsed = parseDockerCleanupCron(cron ?? "");
	return {
		rule: parsed.ok ? parsed.expression : DEFAULT_DOCKER_CLEANUP_CRON,
		tz: DOCKER_CLEANUP_TIMEZONE,
	};
};
