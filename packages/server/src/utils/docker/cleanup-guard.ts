import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../../db/index";
import { applications, compose, deployments } from "../../db/schema";
import { listQueueJobs } from "../../services/deployment-queue-journal";

/**
 * Keeps the nightly Docker cleanup away from hosts that are deploying.
 *
 * `cleanupAll` prunes images, builder cache, containers and volumes, so running
 * it while a build is pushing or a deploy is pulling can delete the image that
 * is about to be used (it did, 2026-10-22). Every cleanup path (the boot-time
 * `initCronJobs`, `updateDockerCleanup`, server create/update) goes through
 * `runDockerCleanupWhenIdle`.
 */

export const DOCKER_CLEANUP_RETRY_MS = 15 * 60 * 1000;
export const DOCKER_CLEANUP_MAX_WAIT_MS = 3 * 60 * 60 * 1000;

// A `running` deployment row older than this is a leftover (a crashed process,
// a hung command), not a build; it must not hold cleanup off forever.
const STALE_RUNNING_AFTER_MS = 12 * 60 * 60 * 1000;

const LOCAL_HOST = "local";

const hostKey = (serverId: string | null | undefined) => serverId || LOCAL_HOST;

type HostRefs = {
	serverId?: string | null;
	buildServerId?: string | null;
};

/**
 * The hosts a deploy touches: the one it runs on (null = the Dokploy server)
 * and the build server it builds on, which can be a different machine.
 */
const hostsOf = (...refs: Array<HostRefs | null | undefined>) => {
	const hosts = new Set<string>();
	for (const ref of refs) {
		if (!ref) continue;
		hosts.add(hostKey(ref.serverId));
		if (ref.buildServerId) hosts.add(ref.buildServerId);
	}
	return hosts;
};

const str = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/** Which service a queue job deploys: compose jobs say so, the rest are applications. */
const serviceOf = (payload: Record<string, unknown>) => {
	const composeId = str(payload.composeId);
	const applicationId = str(payload.applicationId);
	const isCompose = String(payload.applicationType).startsWith("compose");
	if (isCompose && composeId)
		return { kind: "compose", id: composeId } as const;
	if (applicationId) return { kind: "application", id: applicationId } as const;
	if (composeId) return { kind: "compose", id: composeId } as const;
	return null;
};

/**
 * How many deployments are running or queued that touch `serverId` (null or
 * undefined = the Dokploy server): `running` deployment rows plus the jobs in
 * the deploy queue journal, whether they run on the host or build on it.
 */
export const countActiveDeploymentsOnHost = async (
	serverId: string | null | undefined,
): Promise<number> => {
	const host = hostKey(serverId);
	let count = 0;

	const cutoff = new Date(Date.now() - STALE_RUNNING_AFTER_MS).toISOString();
	const running = await db.query.deployments.findMany({
		where: and(
			eq(deployments.status, "running"),
			gte(deployments.createdAt, cutoff),
		),
		columns: { serverId: true, buildServerId: true },
		with: {
			application: { columns: { serverId: true, buildServerId: true } },
			compose: { columns: { serverId: true, buildServerId: true } },
		},
	});
	for (const row of running) {
		if (hostsOf(row, row.application, row.compose).has(host)) count++;
	}

	// Queued and starting jobs have no deployment row yet, and the payload only
	// names the service, so the hosts come from the service.
	const jobs = await listQueueJobs();
	const applicationIds = new Set<string>();
	const composeIds = new Set<string>();
	for (const { payload } of jobs) {
		const service = serviceOf(payload);
		if (service?.kind === "compose") composeIds.add(service.id);
		else if (service) applicationIds.add(service.id);
	}
	const [apps, composes] = await Promise.all([
		applicationIds.size
			? db.query.applications.findMany({
					where: inArray(applications.applicationId, [...applicationIds]),
					columns: { applicationId: true, serverId: true, buildServerId: true },
				})
			: [],
		composeIds.size
			? db.query.compose.findMany({
					where: inArray(compose.composeId, [...composeIds]),
					columns: { composeId: true, serverId: true, buildServerId: true },
				})
			: [],
	]);
	const appRefs = new Map(apps.map((app) => [app.applicationId, app]));
	const composeRefs = new Map(composes.map((item) => [item.composeId, item]));
	for (const { payload } of jobs) {
		const service = serviceOf(payload);
		if (!service) continue;
		const ref =
			service.kind === "compose"
				? composeRefs.get(service.id)
				: appRefs.get(service.id);
		if (hostsOf(ref).has(host)) count++;
	}

	return count;
};

// One wait per host. The slot is process-wide because the app can load a
// second copy of this module (see utils/process/background.ts).
const WAITING_SLOT = Symbol.for("dokploy.dockerCleanupWaiting");

const waitingHosts = (): Set<string> => {
	const registry = globalThis as unknown as Record<symbol, Set<string>>;
	let slot = registry[WAITING_SLOT];
	if (!slot) {
		slot = new Set();
		registry[WAITING_SLOT] = slot;
	}
	return slot;
};

export type DockerCleanupOutcome =
	| "ran"
	| "gave-up"
	| "superseded"
	| "already-waiting";

export type RunDockerCleanupWhenIdleOptions = {
	/** The host to guard: a serverId, or null/undefined for the Dokploy server. */
	serverId?: string | null;
	/** How logs name the host, for example "server prod (abc123)". */
	hostLabel: string;
	/** The cleanup itself. Only called when the host is idle. */
	run: () => Promise<unknown> | unknown;
	/** False once the job was cancelled or replaced; stops the wait. */
	shouldContinue?: () => boolean;
	retryMs?: number;
	maxWaitMs?: number;
	/** Test seams. */
	countActive?: (serverId: string | null | undefined) => Promise<number>;
	sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run` when no deployment is active on the host. If one is, logs
 * "Docker cleanup deferred: N deployment(s) active on <host>" and checks again
 * every 15 minutes for up to 3 hours; after that it gives up for this trigger
 * (the next scheduled run tries again). Never runs while the host is busy, and
 * treats a failed check as busy.
 */
export const runDockerCleanupWhenIdle = async ({
	serverId,
	hostLabel,
	run,
	shouldContinue = () => true,
	retryMs = DOCKER_CLEANUP_RETRY_MS,
	maxWaitMs = DOCKER_CLEANUP_MAX_WAIT_MS,
	countActive = countActiveDeploymentsOnHost,
	sleep = defaultSleep,
}: RunDockerCleanupWhenIdleOptions): Promise<DockerCleanupOutcome> => {
	const key = hostKey(serverId);
	const waiting = waitingHosts();
	if (waiting.has(key)) {
		console.log(
			`Docker cleanup skipped: a previous run is still waiting on ${hostLabel}`,
		);
		return "already-waiting";
	}
	waiting.add(key);
	try {
		let waited = 0;
		for (;;) {
			if (!shouldContinue()) {
				console.log(
					`Docker cleanup cancelled while waiting on ${hostLabel}: the schedule changed`,
				);
				return "superseded";
			}
			let active: number | null;
			try {
				active = await countActive(serverId);
			} catch (error) {
				console.error(
					`Docker cleanup: could not check active deployments on ${hostLabel}`,
					error instanceof Error ? error.message : error,
				);
				active = null;
			}
			if (active === 0) {
				await run();
				return "ran";
			}
			console.log(
				active === null
					? `Docker cleanup deferred: could not check active deployments on ${hostLabel}`
					: `Docker cleanup deferred: ${active} deployment(s) active on ${hostLabel}`,
			);
			if (waited + retryMs > maxWaitMs) {
				console.warn(
					`Docker cleanup skipped on ${hostLabel}: still busy after ${Math.round(maxWaitMs / 60000)} minutes, will try again at the next scheduled run`,
				);
				return "gave-up";
			}
			await sleep(retryMs);
			waited += retryMs;
		}
	} finally {
		waiting.delete(key);
	}
};
