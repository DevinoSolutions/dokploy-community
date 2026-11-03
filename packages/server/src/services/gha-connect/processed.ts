/**
 * The runs a connection already looked at. A poll skips them without any
 * request, so a spammed or repeated Deployment costs one request once.
 */

export interface ProcessedEntry {
	runId: number;
	attempt: number;
	outcome: string;
	at: string;
}

/** Handled runs remembered per connection. */
export const PROCESSED_CAP = 50;

export const wasProcessed = (
	processed: readonly ProcessedEntry[],
	runId: number,
	attempt: number,
) => processed.some((p) => p.runId === runId && p.attempt === attempt);

/** Newest first, bounded: the oldest entries fall off. */
export const mergeProcessed = (
	existing: readonly ProcessedEntry[],
	added: readonly ProcessedEntry[],
): ProcessedEntry[] => [...added, ...existing].slice(0, PROCESSED_CAP);
