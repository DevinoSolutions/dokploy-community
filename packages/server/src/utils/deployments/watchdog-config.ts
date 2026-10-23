import { z } from "zod";

/**
 * Settings and decision rules of the stuck-deployment watchdog. Deliberately
 * pure (no db, no node APIs): the db schema imports it for input validation,
 * and so can the UI.
 *
 * The watchdog fails a deployment that is still `running` when
 * - its log has had no new output for `idleMinutes`, or
 * - it has run for longer than `maxMinutes` in total,
 * unless its service is on the exclusion list.
 */

export const DEFAULT_WATCHDOG_ENABLED = true;
export const DEFAULT_WATCHDOG_IDLE_MINUTES = 20;
/**
 * A rolling replace can be silent for up to 900 s while it waits for the new
 * replica to be healthy, so a shorter idle limit would fail a healthy deploy.
 */
export const MIN_WATCHDOG_IDLE_MINUTES = 15;
export const DEFAULT_WATCHDOG_MAX_MINUTES = 90;
export const MIN_WATCHDOG_MAX_MINUTES = 15;
/** Upper bounds only keep a typo (an extra zero) from disabling the check. */
export const MAX_WATCHDOG_IDLE_MINUTES = 24 * 60;
export const MAX_WATCHDOG_MAX_MINUTES = 7 * 24 * 60;

export const watchdogIdleMinutesSchema = z
	.number()
	.int()
	.min(MIN_WATCHDOG_IDLE_MINUTES)
	.max(MAX_WATCHDOG_IDLE_MINUTES);

export const watchdogMaxMinutesSchema = z
	.number()
	.int()
	.min(MIN_WATCHDOG_MAX_MINUTES)
	.max(MAX_WATCHDOG_MAX_MINUTES);

/** A service whose deployments the watchdog never fails. */
export const watchdogExclusionSchema = z.object({
	type: z.enum(["application", "compose"]),
	id: z.string().min(1),
	reason: z.string().max(300).optional(),
});

export type WatchdogExclusion = z.infer<typeof watchdogExclusionSchema>;

/** What `settings.updateDeploymentWatchdog` accepts. */
export const apiUpdateDeploymentWatchdog = z
	.object({
		enabled: z.boolean(),
		idleMinutes: watchdogIdleMinutesSchema,
		maxMinutes: watchdogMaxMinutesSchema,
	})
	.refine((value) => value.maxMinutes >= value.idleMinutes, {
		message:
			"The wall time limit cannot be shorter than the idle limit: a deployment would always hit it first",
		path: ["maxMinutes"],
	});

export const apiAddDeploymentWatchdogExclusion = watchdogExclusionSchema;

export const apiRemoveDeploymentWatchdogExclusion = z.object({
	type: z.enum(["application", "compose"]),
	id: z.string().min(1),
});

export interface WatchdogConfig {
	enabled: boolean;
	idleMinutes: number;
	maxMinutes: number;
	exclusions: WatchdogExclusion[];
}

type StoredSettings = {
	deploymentWatchdogEnabled?: boolean | null;
	deploymentWatchdogIdleMinutes?: number | null;
	deploymentWatchdogMaxMinutes?: number | null;
	deploymentWatchdogExclusions?: unknown;
} | null;

const clampMinutes = (
	value: number | null | undefined,
	fallback: number,
	min: number,
	max: number,
) =>
	typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.floor(value)))
		: fallback;

// Only the kind and the id decide whether a service is excluded: a reason that
// is too long (a direct SQL edit) must not cost the service its exclusion.
const storedExclusionSchema = z.object({
	type: z.enum(["application", "compose"]),
	id: z.string().min(1),
	reason: z.unknown().optional(),
});

/**
 * Each entry on its own: one bad element is dropped and the valid ones are
 * kept. Parsing the list as a whole would drop every exclusion for one typo,
 * and the watchdog would then fail services that were excluded on purpose.
 */
export const parseExclusions = (value: unknown): WatchdogExclusion[] => {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): WatchdogExclusion[] => {
		const parsed = storedExclusionSchema.safeParse(item);
		if (!parsed.success) return [];
		const { type, id, reason } = parsed.data;
		return [
			typeof reason === "string" && reason.length > 0
				? { type, id, reason: reason.slice(0, 300) }
				: { type, id },
		];
	});
};

/**
 * The effective configuration from the stored row. A value outside its bounds
 * (an old row, a direct SQL edit) is clamped instead of rejected: the watchdog
 * must never stop working, or fail deployments too eagerly, because of a typo.
 */
export const resolveWatchdogConfig = (
	settings: StoredSettings | undefined,
): WatchdogConfig => {
	const idleMinutes = clampMinutes(
		settings?.deploymentWatchdogIdleMinutes,
		DEFAULT_WATCHDOG_IDLE_MINUTES,
		MIN_WATCHDOG_IDLE_MINUTES,
		MAX_WATCHDOG_IDLE_MINUTES,
	);
	const maxMinutes = clampMinutes(
		settings?.deploymentWatchdogMaxMinutes,
		DEFAULT_WATCHDOG_MAX_MINUTES,
		MIN_WATCHDOG_MAX_MINUTES,
		MAX_WATCHDOG_MAX_MINUTES,
	);
	const exclusions = parseExclusions(settings?.deploymentWatchdogExclusions);
	return {
		enabled: settings?.deploymentWatchdogEnabled ?? DEFAULT_WATCHDOG_ENABLED,
		idleMinutes,
		// An idle limit above the wall limit would never be reached.
		maxMinutes: Math.max(maxMinutes, idleMinutes),
		exclusions,
	};
};

/** Is the service of this deployment on the exclusion list? */
export const isWatchdogExcluded = (
	exclusions: readonly WatchdogExclusion[],
	service: { applicationId?: string | null; composeId?: string | null },
): boolean =>
	exclusions.some(
		(entry) =>
			(entry.type === "application" && entry.id === service.applicationId) ||
			(entry.type === "compose" && entry.id === service.composeId),
	);

export type WatchdogTrigger =
	| { kind: "idle"; minutes: number; observedMinutes: number }
	| { kind: "wall"; minutes: number; observedMinutes: number };

const MINUTE_MS = 60_000;

/**
 * Whether a deployment is past a limit. The wall limit is checked first, since
 * a deployment past both is best described by the longer-running fact.
 *
 * @param runningMs how long the deployment has run
 * @param idleMs how long its log has had no new output, or null when that
 *   could not be read (an unreachable host, a log that is gone): then only the
 *   wall limit applies, a deployment is never failed on a guess
 */
export const evaluateWatchdog = (
	config: Pick<WatchdogConfig, "idleMinutes" | "maxMinutes">,
	{ runningMs, idleMs }: { runningMs: number; idleMs: number | null },
): WatchdogTrigger | null => {
	if (runningMs > config.maxMinutes * MINUTE_MS) {
		return {
			kind: "wall",
			minutes: config.maxMinutes,
			observedMinutes: Math.floor(runningMs / MINUTE_MS),
		};
	}
	if (idleMs !== null && idleMs > config.idleMinutes * MINUTE_MS) {
		return {
			kind: "idle",
			minutes: config.idleMinutes,
			observedMinutes: Math.floor(idleMs / MINUTE_MS),
		};
	}
	return null;
};

/** The line written to the deployment log when the watchdog steps in. */
export const watchdogTriggerLine = (trigger: WatchdogTrigger): string =>
	trigger.kind === "idle"
		? `Watchdog: no log output for ${trigger.minutes} min`
		: `Watchdog: exceeded ${trigger.minutes} min`;

/** The line written once the deployment has been marked failed. */
export const WATCHDOG_FAILED_LINE = "Watchdog: marked failed";
