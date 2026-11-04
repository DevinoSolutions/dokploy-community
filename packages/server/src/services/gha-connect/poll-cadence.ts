/**
 * How often a connection is polled. 20 seconds while anything happens; after
 * 24 hours without a run or a release the interval grows to 120 seconds. A
 * webhook or the "Check now" action resets it (they clear `lastActivityAt`
 * to now). Pure.
 */

export const ACTIVE_INTERVAL_MS = 20_000;
export const IDLE_INTERVAL_MS = 120_000;
export const IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

export const intervalFor = (input: {
	now: number;
	/** Epoch ms of the last run seen or release handled; null = never (new connection). */
	lastActivityAt: number | null;
	createdAt: number;
}): number => {
	const last = input.lastActivityAt ?? input.createdAt;
	return input.now - last > IDLE_AFTER_MS
		? IDLE_INTERVAL_MS
		: ACTIVE_INTERVAL_MS;
};

/** Whether a connection polled at `lastPolledAt` is due now. */
export const isDue = (input: {
	now: number;
	lastPolledAt: number | null;
	lastActivityAt: number | null;
	createdAt: number;
}): boolean =>
	input.lastPolledAt === null ||
	input.now - input.lastPolledAt >= intervalFor(input) - 1_000;
