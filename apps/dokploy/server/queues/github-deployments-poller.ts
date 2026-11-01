import {
	findApplicationById,
	findComposeById,
	getDokployUrl,
	IS_CLOUD,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	deployments,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema";
import {
	decideApplicationImage,
	deleteGithubWatch,
	describeError,
	type GithubDeployment,
	type InflightState,
	listEnabledGithubWatches,
	loadConnectionToken,
	markGithubConnectionRevoked,
	POLL_INTERVAL_MS,
	type PollDeps,
	patchGithubWatch,
	pinComposeImage,
	pollWatch,
	removeGhcrWatchConfigDirs,
	reportServiceGone,
	type StartOutcome,
	type WatchRow,
} from "@dokploy/server/services/github-deployments";
import { runBackgroundJob } from "@dokploy/server/utils/process/background";
import { and, desc, eq } from "drizzle-orm";
import type { DeploymentJob } from "./queue-types";
import { myQueue } from "./queueSetup";

/**
 * The real database, queue and GitHub behind the "Deploy from GitHub
 * Deployments" poller. The rules live in
 * packages/server/src/services/github-deployments/poll-core.ts; this file only
 * wires them to this process. See docs/design/github-deployments-pull.md.
 */

/** Title of the Dokploy deployment a GitHub deployment starts. Also its handle. */
export const githubDeploymentTitle = (githubDeploymentId: number) =>
	`GHA GitHub deployment #${githubDeploymentId}`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const serviceLink = async (watch: WatchRow): Promise<string> => {
	const base = await getDokployUrl();
	if (watch.serviceType === "application") {
		const app = await findApplicationById(watch.serviceId);
		return `${base}/dashboard/project/${app.environment.projectId}/environment/${app.environmentId}/services/application/${app.applicationId}?tab=deployments`;
	}
	const stack = await findComposeById(watch.serviceId);
	return `${base}/dashboard/project/${stack.environment.projectId}/environment/${stack.environmentId}/services/compose/${stack.composeId}?tab=deployments`;
};

/**
 * Move the cursor, record the deployment as in flight, write the new image on
 * the service and enqueue the Dokploy deploy, so that none of it is left behind
 * if any step fails.
 *
 * Everything in the database is one transaction (the watch row is locked first,
 * so two polls cannot both start the same deployment). The job is enqueued
 * after the commit, so it can never run against an image that is not committed
 * yet; if the enqueue fails, a second transaction puts the image, the cursor
 * and the in-flight mark back (each only if it still holds what this call
 * wrote) and the deployment is tried again on the next tick.
 *
 * Crash window: a process that dies between the commit and the enqueue leaves
 * the deployment in flight with no job; it is reported to GitHub as lost after
 * INFLIGHT_ROW_GRACE_MS and the new image stays on the service for its next
 * deploy. A crash before the commit changes nothing.
 */
const startDeploy = async (
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: Parameters<PollDeps["startDeploy"]>[2],
): Promise<StartOutcome> => {
	const prepared = await db.transaction(async (tx: Tx) => {
		const [row] = await tx
			.select()
			.from(githubDeploymentWatch)
			.where(eq(githubDeploymentWatch.watchId, watch.watchId))
			.for("update");
		// The tick decided on a snapshot of the watch. If the watch was
		// repointed, turned off and on, or advanced since, that decision no
		// longer applies.
		if (
			!row?.enabled ||
			row.inflightDeploymentId !== null ||
			row.owner !== watch.owner ||
			row.repo !== watch.repo ||
			row.environment !== watch.environment ||
			row.connectionId !== watch.connectionId ||
			row.lastSeenDeploymentId === null ||
			row.lastSeenDeploymentId >= deployment.id ||
			row.lastSeenDeploymentId !== watch.lastSeenDeploymentId
		) {
			return { kind: "stale" } as const;
		}

		const title = githubDeploymentTitle(deployment.id);
		const description = `${watch.owner}/${watch.repo} (${watch.environment}) ${payload.digest.slice(0, 19)}${payload.buildRunUrl ? ` ${payload.buildRunUrl}` : ""}`;
		// TODO(T-12149 / #576): the queue only carries these once #576 is merged;
		// until then they are ignored, and the "GHA " title prefix already lets
		// Dokploy infer github-actions as the build origin.
		const origin = {
			buildOrigin: "github-actions",
			...(payload.buildRunUrl ? { buildRunUrl: payload.buildRunUrl } : {}),
		};

		if (watch.serviceType === "application") {
			const app = await findApplicationById(watch.serviceId).catch(() => null);
			if (!app) {
				return {
					kind: "rejected",
					reason: "The application no longer exists.",
				} as const;
			}
			if (app.environment.project.organizationId !== watch.organizationId) {
				return {
					kind: "rejected",
					reason: "The application belongs to another organization.",
				} as const;
			}
			const decision = decideApplicationImage(app, payload, watch.owner);
			if (!decision.ok)
				return { kind: "rejected", reason: decision.reason } as const;
			const job = {
				applicationId: app.applicationId,
				titleLog: title,
				descriptionLog: description,
				type: "deploy",
				applicationType: "application",
				server: !!app.serverId,
				serverId: app.serverId ?? undefined,
				...origin,
			} as DeploymentJob;
			await tx
				.update(githubDeploymentWatch)
				.set(claim(deployment.id))
				.where(eq(githubDeploymentWatch.watchId, watch.watchId));
			await tx
				.update(applications)
				.set({ dockerImage: decision.dockerImage })
				.where(eq(applications.applicationId, app.applicationId));
			return {
				kind: "prepared",
				job,
				undo: async (tx2: Tx) => {
					await tx2
						.update(applications)
						.set({ dockerImage: app.dockerImage })
						.where(
							and(
								eq(applications.applicationId, app.applicationId),
								eq(applications.dockerImage, decision.dockerImage),
							),
						);
				},
			} as const;
		}

		const stack = await findComposeById(watch.serviceId).catch(() => null);
		if (!stack) {
			return {
				kind: "rejected",
				reason: "The compose stack no longer exists.",
			} as const;
		}
		if (stack.environment.project.organizationId !== watch.organizationId) {
			return {
				kind: "rejected",
				reason: "The compose stack belongs to another organization.",
			} as const;
		}
		if (stack.sourceType !== "raw") {
			return {
				kind: "rejected",
				reason:
					"Only compose stacks whose file is stored in Dokploy can follow GitHub deployments.",
			} as const;
		}
		const pinned = pinComposeImage(
			stack.composeFile,
			payload.repository,
			payload.digest,
		);
		if (!pinned.ok) return { kind: "rejected", reason: pinned.reason } as const;
		const job = {
			composeId: stack.composeId,
			titleLog: title,
			descriptionLog: description,
			type: "deploy",
			applicationType: "compose",
			server: !!stack.serverId,
			serverId: stack.serverId ?? undefined,
			...origin,
		} as DeploymentJob;
		await tx
			.update(githubDeploymentWatch)
			.set(claim(deployment.id))
			.where(eq(githubDeploymentWatch.watchId, watch.watchId));
		if (pinned.changed) {
			await tx
				.update(compose)
				.set({ composeFile: pinned.composeFile })
				.where(eq(compose.composeId, stack.composeId));
		}
		return {
			kind: "prepared",
			job,
			undo: async (tx2: Tx) => {
				if (!pinned.changed) return;
				await tx2
					.update(compose)
					.set({ composeFile: stack.composeFile })
					.where(
						and(
							eq(compose.composeId, stack.composeId),
							eq(compose.composeFile, pinned.composeFile),
						),
					);
			},
		} as const;
	});
	if (prepared.kind !== "prepared") return prepared;

	try {
		await myQueue.add("deployments", prepared.job, {
			removeOnComplete: true,
			removeOnFail: true,
		});
	} catch (error) {
		// Nothing is running for this deployment: put back what the commit wrote.
		await db
			.transaction(async (tx: Tx) => {
				await tx
					.update(githubDeploymentWatch)
					.set({
						lastSeenDeploymentId: watch.lastSeenDeploymentId,
						inflightDeploymentId: null,
						inflightStartedAt: null,
					})
					.where(
						and(
							eq(githubDeploymentWatch.watchId, watch.watchId),
							eq(githubDeploymentWatch.inflightDeploymentId, deployment.id),
						),
					);
				await prepared.undo(tx);
			})
			.catch((undoError) =>
				console.warn(
					`github deployments: could not undo watch ${watch.watchId}: ${describeError(undoError)}`,
				),
			);
		throw error;
	}
	return {
		kind: "started",
		logUrl: watch.postLogUrl
			? await serviceLink(watch).catch(() => undefined)
			: undefined,
	};
};

const claim = (githubDeploymentId: number) => ({
	lastSeenDeploymentId: githubDeploymentId,
	inflightDeploymentId: githubDeploymentId,
	inflightStartedAt: new Date(),
	lastError: null,
});

/** Where the Dokploy deployment started for a GitHub deployment stands. */
const inspectInflight = async (watch: WatchRow): Promise<InflightState> => {
	const id = watch.inflightDeploymentId;
	if (id === null) return { state: "missing" };
	const title = githubDeploymentTitle(id);
	const owner =
		watch.serviceType === "application"
			? eq(deployments.applicationId, watch.serviceId)
			: eq(deployments.composeId, watch.serviceId);
	const [row] = await db
		.select({ status: deployments.status })
		.from(deployments)
		.where(and(owner, eq(deployments.title, title)))
		.orderBy(desc(deployments.createdAt))
		.limit(1);
	// Only built for a watch that opted in to sending it to GitHub.
	const logUrl = watch.postLogUrl
		? await serviceLink(watch).catch(() => undefined)
		: undefined;
	if (!row) {
		// Still waiting in the queue behind other deploys of the service?
		const queued = await myQueue.getJobs(["waiting", "active"]);
		return queued.some((job) => job.data.titleLog === title)
			? { state: "running" }
			: { state: "missing" };
	}
	switch (row.status) {
		case "done":
			return { state: "done", logUrl };
		case "error":
			return { state: "error", logUrl };
		case "cancelled":
			return { state: "cancelled", logUrl };
		default:
			return { state: "running" };
	}
};

const blocks = new Map<string, number>();

export const createGithubDeploymentsPollDeps = (): PollDeps => ({
	fetch: (url, init) => fetch(url, init as RequestInit),
	now: () => Date.now(),
	loadToken: loadConnectionToken,
	markRevoked: markGithubConnectionRevoked,
	blockedUntil: (key) => blocks.get(key),
	block: (key, until) => {
		blocks.set(key, until);
	},
	patchWatch: (watchId, patch) => patchGithubWatch(watchId, patch),
	startDeploy,
	inspectInflight,
	log: (message) => console.warn(message),
});

const serviceExists = async (watch: WatchRow): Promise<boolean> => {
	if (watch.serviceType === "application") {
		const row = await db.query.applications.findFirst({
			where: eq(applications.applicationId, watch.serviceId),
			columns: { applicationId: true },
		});
		return !!row;
	}
	const row = await db.query.compose.findFirst({
		where: eq(compose.composeId, watch.serviceId),
		columns: { composeId: true },
	});
	return !!row;
};

/**
 * One pass over every enabled watch. `shouldStop` is checked between watches so
 * a shutdown does not start new deployments while the queue drains.
 */
export const runGithubDeploymentsTick = async (
	deps: PollDeps = createGithubDeploymentsPollDeps(),
	shouldStop: () => boolean = () => false,
): Promise<void> => {
	const watches = await listEnabledGithubWatches();
	for (const record of watches) {
		if (shouldStop()) return;
		const watch: WatchRow = {
			watchId: record.watchId,
			organizationId: record.organizationId,
			serviceType: record.serviceType,
			serviceId: record.serviceId,
			connectionId: record.connectionId,
			owner: record.owner,
			repo: record.repo,
			environment: record.environment,
			enabled: record.enabled,
			lastSeenDeploymentId: record.lastSeenDeploymentId,
			etag: record.etag,
			inflightDeploymentId: record.inflightDeploymentId,
			inflightStartedAt: record.inflightStartedAt,
			postLogUrl: record.postLogUrl,
		};
		// The service was deleted: the watch has nothing left to deploy. A
		// workflow may still be waiting on a deployment that was in flight, so
		// GitHub is told it failed before the watch (and its login) go away.
		if (!(await serviceExists(watch))) {
			await reportServiceGone(watch, deps);
			await deleteGithubWatch(watch.serviceType, watch.serviceId);
			await removeGhcrWatchConfigDirs(
				[watch.watchId],
				watch.organizationId,
			).catch(() => {});
			continue;
		}
		await pollWatch(watch, deps);
	}
};

/**
 * Starts the poll (every 20 seconds). Self-hosted only: cloud does not run this
 * queue. One tick at a time; a slow tick is skipped over, never stacked.
 * Returns a function that stops it: no new tick starts and a running one stops
 * before its next watch. server.ts calls it on SIGTERM, before the queue drains.
 */
export const startGithubDeploymentsPoller = (
	deps: PollDeps = createGithubDeploymentsPollDeps(),
	intervalMs: number = POLL_INTERVAL_MS,
): (() => void) => {
	if (IS_CLOUD) return () => {};
	let running = false;
	let stopped = false;
	const timer = setInterval(() => {
		if (running || stopped) return;
		running = true;
		void runBackgroundJob("github-deployments-poll", () =>
			runGithubDeploymentsTick(deps, () => stopped),
		).finally(() => {
			running = false;
		});
	}, intervalMs);
	// A tick must never keep the process alive on shutdown.
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
};
