/**
 * "Check now": ask the poller to look at one connection on its next tick,
 * whatever its cadence or back-off says. In memory on purpose: a restart
 * polls every connection on its first tick anyway.
 */

const requested = new Set<string>();

export const wakeGhaConnection = (ghaConnectionId: string) => {
	requested.add(ghaConnectionId);
};

/** True once per request: the poller calls it when it is about to decide whether a connection is due. */
export const consumeWake = (ghaConnectionId: string): boolean =>
	requested.delete(ghaConnectionId);

export const resetWakeRequests = () => requested.clear();
