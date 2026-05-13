export const LOCAL_TARGET = "__local__";
export const CANCEL_CHANNEL = "dokploy:deployments:cancel";

export const getTargetKey = (data: {
	buildServerId?: string | null;
	serverId?: string | null;
}): string => data.buildServerId ?? data.serverId ?? LOCAL_TARGET;

/**
 * LOCAL_TARGET keeps canary's queue name `deployments` so an upgrade from a
 * BullMQ-only canary doesn't strand pending jobs in an orphaned queue.
 * Per-server queues use `__` as the separator because BullMQ rejects queue
 * names containing `:`.
 */
export const getQueueName = (targetKey: string): string =>
	targetKey === LOCAL_TARGET ? "deployments" : `deployments__${targetKey}`;

export const getInflightKey = (targetKey: string, jobId: string): string =>
	`${getQueueName(targetKey)}:${jobId}`;
