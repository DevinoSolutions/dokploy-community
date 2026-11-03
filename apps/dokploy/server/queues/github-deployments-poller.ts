import {
	findApplicationById,
	findComposeById,
	getDokployUrl,
	IS_CLOUD,
	type RegisterExternalBuildInput,
	registerExternalBuild,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	deployments,
	ghaConnection,
	ghaRelease,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema";
import { buildOriginJobFields } from "@dokploy/server/services/build-origin-shared";
import {
	consumeWake,
	deleteGhaConnection,
	deploySourceTypeOf,
	isDue,
	listGhaConnections,
	planApplicationFlip,
	snapshotPreviousSource,
} from "@dokploy/server/services/gha-connect";
import {
	createGithubFetch,
	type DeployPayload,
	decideApplicationImage,
	deleteGithubWatch,
	describeError,
	findGithubWatch,
	GITHUB_DEPLOYMENTS_POLL_INTERVAL_MS,
	type GithubDeployment,
	type InflightState,
	listEnabledGithubWatches,
	loadConnectionToken,
	markGithubConnectionRevoked,
	type PollDeps,
	patchGithubWatch,
	pinComposeImage,
	pinComposeImages,
	pollWatch,
	removeGhcrWatchConfigDirs,
	reportServiceGone,
	repositoryOfReference,
	type StartOutcome,
	upsertGithubWatch,
	type WatchRow,
} from "@dokploy/server/services/github-deployments";
import { runBackgroundJob } from "@dokploy/server/utils/process/background";
import { and, asc, desc, eq, gte, like } from "drizzle-orm";
import {
	createGhaConnectionPollDeps,
	pollGhaConnection,
} from "./gha-connection-deps";
import type { DeploymentJob } from "./queue-types";
import { myQueue } from "./queueSetup";

/**
 * The real database, queue and GitHub behind the "Deploy from GitHub
 * Deployments" poller. The rules live in
 * packages/server/src/services/github-deployments/poll-core.ts; this file only
 * wires them to this process. See docs/design/github-deployments-pull.md.
 */

/**
 * The end of the Dokploy deployment title a GitHub deployment starts. It is the
 * handle the poller finds that deployment by, whatever the rest of the title
 * says, so it must stay unique per GitHub deployment id.
 */
export const githubDeploymentHandle = (githubDeploymentId: number) =>
	`[deployment #${githubDeploymentId}]`;

/** An environment as one word of a title (the title parser reads one token after "GHA "). */
const titleToken = (value: string | undefined): string | null => {
	const token = (value ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._/-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.slice(0, 100);
	return token || null;
};

/**
 * Title of the Dokploy deployment a GitHub deployment starts, in the shape the
 * dokploy-deploy action uses ("GHA <environment> <sha8> ..."), so the GitHub
 * Actions pill and the run modal read the environment and the commit from it
 * (parseGithubActionsTitle). Ends with the handle.
 */
export const githubDeploymentTitle = (
	watch: Pick<WatchRow, "environment">,
	deployment: Pick<GithubDeployment, "id" | "sha" | "environment">,
) => {
	const sha = /^[0-9a-f]{7,40}$/i.test(deployment.sha ?? "")
		? (deployment.sha as string).slice(0, 8).toLowerCase()
		: null;
	const environment =
		titleToken(deployment.environment) ?? titleToken(watch.environment);
	return [
		"GHA",
		...(environment ? [environment] : []),
		...(sha ? [sha] : []),
		githubDeploymentHandle(deployment.id),
	].join(" ");
};

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
 * What the transaction of a start decided, before anything is enqueued.
 * `undo` puts back whatever the committed transaction wrote.
 */
type Prepared =
	| { kind: "stale" }
	| { kind: "rejected"; reason: string }
	| {
			kind: "prepared";
			job: DeploymentJob;
			undo: (tx: Tx) => Promise<void>;
			/** The live GitHub Actions row this deploy continues, registered after the commit. */
			liveRow?: RegisterExternalBuildInput;
	  };

/**
 * The tick decided on a snapshot of the watch. If the watch was repointed,
 * turned off and on, or advanced since, that decision no longer applies.
 */
const watchChangedSinceTick = (
	row: typeof githubDeploymentWatch.$inferSelect | undefined,
	watch: WatchRow,
	deployment: GithubDeployment,
) =>
	!row?.enabled ||
	row.inflightDeploymentId !== null ||
	row.owner !== watch.owner ||
	row.repo !== watch.repo ||
	row.environment !== watch.environment ||
	row.connectionId !== watch.connectionId ||
	row.lastSeenDeploymentId === null ||
	row.lastSeenDeploymentId >= deployment.id ||
	row.lastSeenDeploymentId !== watch.lastSeenDeploymentId;

/**
 * A release start is made long after its Deployment was read (it waited for the
 * deploy gate), so the cursor is already past it: only a watch that was
 * repointed, turned off and on, or advanced by another pass since the tick
 * decided makes the start stale.
 */
const watchChangedSinceReleaseTick = (
	row: typeof githubDeploymentWatch.$inferSelect | undefined,
	watch: WatchRow,
) =>
	!row?.enabled ||
	row.inflightDeploymentId !== null ||
	row.owner !== watch.owner ||
	row.repo !== watch.repo ||
	row.environment !== watch.environment ||
	row.connectionId !== watch.connectionId ||
	row.lastSeenDeploymentId === null ||
	row.lastSeenDeploymentId !== watch.lastSeenDeploymentId;

const preparePlainDeploy = async (
	tx: Tx,
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: DeployPayload,
): Promise<Prepared> => {
	const [row] = await tx
		.select()
		.from(githubDeploymentWatch)
		.where(eq(githubDeploymentWatch.watchId, watch.watchId))
		.for("update");
	if (watchChangedSinceTick(row, watch, deployment)) {
		return { kind: "stale" };
	}

	const title = githubDeploymentTitle(watch, deployment);
	const description = `${watch.owner}/${watch.repo} (${watch.environment}) ${payload.digest.slice(0, 19)}${payload.buildRunUrl ? ` ${payload.buildRunUrl}` : ""}`;
	// What the queue carries to the deployment row: where the image was built
	// (a valid run link only, as for the deploy API).
	const origin = buildOriginJobFields({
		buildOrigin: "github-actions",
		buildRunUrl: payload.buildRunUrl,
	});

	if (watch.serviceType === "application") {
		const app = await findApplicationById(watch.serviceId).catch(() => null);
		if (!app) {
			return {
				kind: "rejected",
				reason: "The application no longer exists.",
			};
		}
		if (app.environment.project.organizationId !== watch.organizationId) {
			return {
				kind: "rejected",
				reason: "The application belongs to another organization.",
			};
		}
		const decision = decideApplicationImage(app, payload, watch.owner);
		if (!decision.ok) return { kind: "rejected", reason: decision.reason };
		const job: DeploymentJob = {
			applicationId: app.applicationId,
			titleLog: title,
			descriptionLog: description,
			type: "deploy",
			applicationType: "application",
			server: !!app.serverId,
			serverId: app.serverId ?? undefined,
			...origin,
		};
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
		};
	}

	const stack = await findComposeById(watch.serviceId).catch(() => null);
	if (!stack) {
		return {
			kind: "rejected",
			reason: "The compose stack no longer exists.",
		};
	}
	if (stack.environment.project.organizationId !== watch.organizationId) {
		return {
			kind: "rejected",
			reason: "The compose stack belongs to another organization.",
		};
	}
	if (stack.sourceType !== "raw") {
		return {
			kind: "rejected",
			reason:
				"Only compose stacks whose file is stored in Dokploy can follow GitHub deployments.",
		};
	}
	const pinned = pinComposeImage(
		stack.composeFile,
		payload.repository,
		payload.digest,
	);
	if (!pinned.ok) return { kind: "rejected", reason: pinned.reason };
	const job: DeploymentJob = {
		composeId: stack.composeId,
		titleLog: title,
		descriptionLog: description,
		type: "deploy",
		applicationType: "compose",
		server: !!stack.serverId,
		serverId: stack.serverId ?? undefined,
		...origin,
	};
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
	};
};

type ReleaseContext = NonNullable<DeployPayload["release"]>;

/**
 * Start a release a GitHub Actions connection accepted and the deploy gate let
 * go. As for a plain deployment, everything in the database is one transaction
 * with the watch row locked first; the connection row is locked second and the
 * release row third (the gate's own write takes the connection, then the
 * release, so the orders never cross).
 *
 * Application: a Docker source gets the new digest of the repository it runs; a
 * git source is flipped to the image (this is the FIRST release; the settings
 * saved at Connect are kept in previousSource, git autodeploy is turned off). A
 * docker application whose image is another repository is refused.
 * Compose: every image of the release is pinned in the stored file.
 *
 * The release row already exists (status accepted, written when the run was
 * verified). This transaction adds `sourceBackup`: the service as it was just
 * before this change (an application's source settings without the registry
 * password; a compose stack's id, source type and file text), so a rollback or a
 * take-over reads it from the database and not only from the connection's
 * previousSource. `undo` clears it again and leaves the release accepted: a
 * start that could not be queued is tried again on the next tick.
 */
const prepareReleaseDeploy = async (
	tx: Tx,
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: DeployPayload,
	release: ReleaseContext,
): Promise<Prepared> => {
	const [row] = await tx
		.select()
		.from(githubDeploymentWatch)
		.where(eq(githubDeploymentWatch.watchId, watch.watchId))
		.for("update");
	if (watchChangedSinceReleaseTick(row, watch)) return { kind: "stale" };

	const [connection] = await tx
		.select()
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, release.connectionId))
		.for("update");
	if (
		!connection ||
		connection.organizationId !== watch.organizationId ||
		connection.serviceType !== watch.serviceType ||
		connection.serviceId !== watch.serviceId ||
		connection.state === "disconnected"
	) {
		return {
			kind: "rejected",
			reason: "The GitHub Actions connection of this service is gone.",
		};
	}
	// Blocked for a reason that is not the gate's: the tick checked, and a block that
	// came in between still wins.
	if (connection.state === "blocked" && !connection.gateBlocked) {
		return { kind: "stale" };
	}
	const [stored] = await tx
		.select({ releaseId: ghaRelease.releaseId })
		.from(ghaRelease)
		.where(
			and(
				eq(ghaRelease.ghaConnectionId, connection.ghaConnectionId),
				eq(ghaRelease.githubDeploymentId, deployment.id),
				eq(ghaRelease.status, "accepted"),
			),
		)
		.for("update");
	// Superseded, failed or deployed since the tick read it.
	if (!stored) return { kind: "stale" };

	const images = [
		{ repository: payload.repository, digest: payload.digest },
		...(payload.extraImages ?? []),
	];
	const title = githubDeploymentTitle(watch, deployment);
	const description =
		`${watch.owner}/${watch.repo} (${watch.environment}) ${release.sha.slice(0, 7)} ${payload.buildRunUrl ?? ""}`.trim();
	const origin = buildOriginJobFields({
		buildOrigin: "github-actions",
		buildRunUrl: payload.buildRunUrl,
	});
	const saveBackup = (backup: Record<string, unknown>) =>
		tx
			.update(ghaRelease)
			.set({ sourceBackup: backup })
			.where(eq(ghaRelease.releaseId, stored.releaseId));
	const clearBackup = (tx2: Tx) =>
		tx2
			.update(ghaRelease)
			.set({ sourceBackup: null })
			.where(eq(ghaRelease.releaseId, stored.releaseId));
	// Claimed, not moved: the cursor is already past this Deployment.
	const claimRelease = () =>
		tx
			.update(githubDeploymentWatch)
			.set({
				inflightDeploymentId: deployment.id,
				inflightStartedAt: new Date(),
				lastError: null,
			})
			.where(eq(githubDeploymentWatch.watchId, watch.watchId));
	const liveRow = (kind: "applicationId" | "composeId", serviceId: string) =>
		payload.buildRunUrl
			? ({
					[kind]: serviceId,
					buildOrigin: "github-actions",
					buildRunUrl: payload.buildRunUrl,
					buildRunId: String(release.runId),
					buildRepository: `${watch.owner}/${watch.repo}`,
					buildCommitSha: release.sha,
					title,
					description,
				} as RegisterExternalBuildInput)
			: undefined;

	if (watch.serviceType === "application") {
		const app = await findApplicationById(watch.serviceId).catch(() => null);
		if (!app) {
			return { kind: "rejected", reason: "The application no longer exists." };
		}
		if (app.environment.project.organizationId !== watch.organizationId) {
			return {
				kind: "rejected",
				reason: "The application belongs to another organization.",
			};
		}
		if (images.length > 1) {
			return {
				kind: "rejected",
				reason:
					"An application takes one image and this release has several. Connect a compose stack instead.",
			};
		}
		const appFields = app as unknown as Record<string, unknown>;
		let update: Record<string, unknown> = { dockerImage: payload.image };
		let savedSource = connection.previousSource;
		if (deploySourceTypeOf(app, "application") === "docker") {
			const current = app.dockerImage?.trim();
			if (
				current &&
				repositoryOfReference(current).toLowerCase() !==
					payload.repository.toLowerCase()
			) {
				return {
					kind: "rejected",
					reason: `The image repository ${payload.repository} is not the one this application runs (${repositoryOfReference(current)}).`,
				};
			}
		} else {
			const flip = planApplicationFlip(appFields, payload.image);
			if (!flip.flip) {
				return {
					kind: "rejected",
					reason: "This application cannot move to an image.",
				};
			}
			update = flip.update;
			// The settings saved at Connect predate the autodeploy change; keep them.
			savedSource = connection.previousSource ?? flip.previousSource;
		}
		const before = Object.fromEntries(
			Object.keys(update).map((key) => [key, appFields[key] ?? null]),
		);
		await claimRelease();
		await tx
			.update(applications)
			.set(update)
			.where(eq(applications.applicationId, app.applicationId));
		if (savedSource !== connection.previousSource) {
			await tx
				.update(ghaConnection)
				.set({ previousSource: savedSource })
				.where(eq(ghaConnection.ghaConnectionId, connection.ghaConnectionId));
		}
		await saveBackup(snapshotPreviousSource(appFields));
		const job: DeploymentJob = {
			applicationId: app.applicationId,
			titleLog: title,
			descriptionLog: description,
			type: "deploy",
			applicationType: "application",
			server: !!app.serverId,
			serverId: app.serverId ?? undefined,
			...origin,
		};
		return {
			kind: "prepared",
			job,
			liveRow: liveRow("applicationId", app.applicationId),
			undo: async (tx2: Tx) => {
				await tx2
					.update(applications)
					.set(before)
					.where(
						and(
							eq(applications.applicationId, app.applicationId),
							eq(applications.dockerImage, payload.image),
						),
					);
				await clearBackup(tx2);
			},
		};
	}

	const stack = await findComposeById(watch.serviceId).catch(() => null);
	if (!stack) {
		return { kind: "rejected", reason: "The compose stack no longer exists." };
	}
	if (stack.environment.project.organizationId !== watch.organizationId) {
		return {
			kind: "rejected",
			reason: "The compose stack belongs to another organization.",
		};
	}
	if (deploySourceTypeOf(stack, "compose") !== "raw") {
		return {
			kind: "rejected",
			reason:
				"Only compose stacks whose file is stored in Dokploy can follow GitHub Actions releases.",
		};
	}
	const pinned = pinComposeImages(stack.composeFile, images);
	if (!pinned.ok) return { kind: "rejected", reason: pinned.reason };
	await claimRelease();
	if (pinned.changed) {
		await tx
			.update(compose)
			.set({ composeFile: pinned.composeFile })
			.where(eq(compose.composeId, stack.composeId));
	}
	await saveBackup({
		composeId: stack.composeId,
		sourceType: stack.sourceType,
		composeFile: stack.composeFile,
	});
	const job: DeploymentJob = {
		composeId: stack.composeId,
		titleLog: title,
		descriptionLog: description,
		type: "deploy",
		applicationType: "compose",
		server: !!stack.serverId,
		serverId: stack.serverId ?? undefined,
		...origin,
	};
	return {
		kind: "prepared",
		job,
		liveRow: liveRow("composeId", stack.composeId),
		undo: async (tx2: Tx) => {
			if (pinned.changed) {
				await tx2
					.update(compose)
					.set({ composeFile: stack.composeFile })
					.where(
						and(
							eq(compose.composeId, stack.composeId),
							eq(compose.composeFile, pinned.composeFile),
						),
					);
			}
			await clearBackup(tx2);
		},
	};
};

/**
 * Enqueue what a committed start prepared. If the enqueue fails, a second
 * transaction puts the image, the cursor and the in-flight mark back (each
 * only if it still holds what this call wrote) and the deployment is tried
 * again on the next tick.
 *
 * Crash window: a process that dies between the commit and the enqueue leaves
 * the deployment in flight with no job; it is reported to GitHub as lost after
 * INFLIGHT_ROW_GRACE_MS and the new image stays on the service for its next
 * deploy. A crash before the commit changes nothing.
 */
const finishStart = async (
	watch: WatchRow,
	deployment: GithubDeployment,
	prepared: Prepared,
): Promise<StartOutcome> => {
	if (prepared.kind !== "prepared") return prepared;
	let job = prepared.job;
	if (prepared.liveRow) {
		// After the commit, before the enqueue: the job continues the row the run's
		// own tracking registered (or this one), so one run is one row in the tab.
		const live = await registerExternalBuild(prepared.liveRow).catch(
			() => null,
		);
		if (live)
			job = { ...job, deploymentId: live.deploymentId } as DeploymentJob;
	}
	try {
		await myQueue.add("deployments", job, {
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

/**
 * Record the deployment as in flight, write the new image on the service and
 * enqueue the Dokploy deploy, so that none of it is left behind if any step
 * fails. A plain deployment also moves the cursor to itself; a release a
 * GitHub Actions connection accepted is started by prepareReleaseDeploy.
 *
 * Everything in the database is one transaction (the watch row is locked first,
 * so two polls cannot both start the same deployment). The job is enqueued
 * after the commit, so it can never run against an image that is not committed
 * yet.
 */
const startDeploy = async (
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: Parameters<PollDeps["startDeploy"]>[2],
): Promise<StartOutcome> => {
	const release = payload.release;
	const prepared = await db.transaction((tx: Tx) =>
		release
			? prepareReleaseDeploy(tx, watch, deployment, payload, release)
			: preparePlainDeploy(tx, watch, deployment, payload),
	);
	return finishStart(watch, deployment, prepared);
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
	const handle = githubDeploymentHandle(id);
	const owner =
		watch.serviceType === "application"
			? eq(deployments.applicationId, watch.serviceId)
			: eq(deployments.composeId, watch.serviceId);
	const statusOf = {
		status: deployments.status,
	};
	const [titled] = await db
		.select(statusOf)
		.from(deployments)
		.where(and(owner, like(deployments.title, `GHA %${handle}`)))
		.orderBy(desc(deployments.createdAt))
		.limit(1);
	let row = titled;
	if (!row && watch.inflightStartedAt) {
		// A manual Deploy that arrived while this job was still waiting is folded
		// into it (coalesceWaiting) and the merged job carries the manual title.
		// It deploys the image this watch already wrote, so the first deployment
		// row of the service created after the claim is this deployment.
		[row] = await db
			.select(statusOf)
			.from(deployments)
			.where(
				and(
					owner,
					gte(deployments.createdAt, watch.inflightStartedAt.toISOString()),
				),
			)
			.orderBy(asc(deployments.createdAt))
			.limit(1);
	}
	// Only built for a watch that opted in to sending it to GitHub.
	const logUrl = watch.postLogUrl
		? await serviceLink(watch).catch(() => undefined)
		: undefined;
	if (!row) {
		// Still waiting in the queue? Under its own title, or merged into another
		// waiting deploy of the service.
		const queued = await myQueue.getJobs(["waiting", "active"]);
		const serviceKey =
			watch.serviceType === "application" ? "applicationId" : "composeId";
		return queued.some(
			(job) =>
				(typeof job.data.titleLog === "string" &&
					job.data.titleLog.startsWith("GHA ") &&
					job.data.titleLog.endsWith(handle)) ||
				(job.data as Record<string, unknown>)[serviceKey] === watch.serviceId,
		)
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
	// Cut off after 15 s: a hung GitHub must not stall the tick for every watch.
	fetch: createGithubFetch(),
	now: () => Date.now(),
	loadToken: loadConnectionToken,
	markRevoked: markGithubConnectionRevoked,
	blockedUntil: (key) => blocks.get(key),
	block: (key, until) => {
		blocks.set(key, until);
	},
	patchWatch: (watchId, patch, options) =>
		patchGithubWatch(watchId, patch, options),
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

const toWatchRow = (
	record: Awaited<ReturnType<typeof listEnabledGithubWatches>>[number],
	ghaConnectionId: string | null,
): WatchRow => ({
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
	ghaConnectionId,
});

/**
 * The watch a connection polls through is created disabled by Connect (so the
 * plain loop never sees it). The connection poll turns it on, and turning on
 * forgets the cursor: the first poll only baselines, so Deployments that piled
 * up before never run.
 */
const enableConnectionWatch = async (
	connection: Awaited<ReturnType<typeof listGhaConnections>>[number],
) => {
	const existing = await findGithubWatch(
		connection.serviceType,
		connection.serviceId,
	);
	if (!existing || existing.enabled) return existing;
	return upsertGithubWatch({
		organizationId: existing.organizationId,
		serviceType: existing.serviceType,
		serviceId: existing.serviceId,
		connectionId: existing.connectionId,
		owner: existing.owner,
		repo: existing.repo,
		environment: existing.environment,
		enabled: true,
	});
};

/**
 * One pass over every enabled watch, and over every GitHub Actions connection.
 * `shouldStop` is checked between watches so a shutdown does not start new
 * deployments while the queue drains. A watch that a connection owns is polled
 * by the connection poll (when it is due: 20 seconds, 120 after a day idle, or
 * at once after "Check now"); every other watch by the plain poll.
 */
export const runGithubDeploymentsTick = async (
	deps: PollDeps = createGithubDeploymentsPollDeps(),
	shouldStop: () => boolean = () => false,
): Promise<void> => {
	const connectionRows = await listGhaConnections();
	const connections = new Map(
		connectionRows.map((row) => [`${row.serviceType}:${row.serviceId}`, row]),
	);
	for (const connection of connectionRows) {
		try {
			await enableConnectionWatch(connection);
		} catch (error) {
			deps.log(
				`gha connection ${connection.ghaConnectionId}: could not turn its watch on: ${describeError(error)}`,
			);
		}
	}
	const watches = await listEnabledGithubWatches();
	// One call per tick: the verification budget of a repository is counted inside it.
	const connectionDeps = createGhaConnectionPollDeps(deps);
	for (const record of watches) {
		if (shouldStop()) return;
		// One watch failing (a database error, a service lookup) must not end the
		// tick for the watches after it.
		try {
			await pollOneWatch(
				record,
				connections.get(`${record.serviceType}:${record.serviceId}`) ?? null,
				deps,
				connectionDeps,
			);
		} catch (error) {
			deps.log(
				`github deployments: watch ${record.watchId} failed this tick: ${describeError(error)}`,
			);
		}
	}
};

const pollOneWatch = async (
	record: Awaited<ReturnType<typeof listEnabledGithubWatches>>[number],
	gha: Awaited<ReturnType<typeof listGhaConnections>>[number] | null,
	deps: PollDeps,
	connectionDeps: ReturnType<typeof createGhaConnectionPollDeps>,
): Promise<void> => {
	const watch = toWatchRow(record, gha?.ghaConnectionId ?? null);
	// The service was deleted: the watch has nothing left to deploy. A
	// workflow may still be waiting on a deployment that was in flight, so
	// GitHub is told it failed before the watch (and its login) go away.
	if (!(await serviceExists(watch))) {
		await reportServiceGone(watch, deps);
		await deleteGithubWatch(watch.serviceType, watch.serviceId);
		if (gha) await deleteGhaConnection(watch.serviceType, watch.serviceId);
		await removeGhcrWatchConfigDirs(
			[watch.watchId],
			watch.organizationId,
		).catch(() => {});
		return;
	}
	if (!gha) {
		await pollWatch(watch, deps);
		return;
	}
	const woken = consumeWake(gha.ghaConnectionId);
	const due =
		woken ||
		isDue({
			now: Date.now(),
			lastPolledAt: record.lastCheckedAt?.getTime() ?? null,
			lastActivityAt: gha.lastActivityAt?.getTime() ?? null,
			createdAt: gha.createdAt.getTime(),
		});
	if (due) await pollGhaConnection(watch, gha, connectionDeps, { woken });
};

/**
 * Starts the poll (every 20 seconds). Self-hosted only: cloud does not run this
 * queue. One tick at a time; a slow tick is skipped over, never stacked.
 * Returns a function that stops it: no new tick starts and a running one stops
 * before its next watch. server.ts calls it on SIGTERM, before the queue drains.
 */
export const startGithubDeploymentsPoller = (
	deps: PollDeps = createGithubDeploymentsPollDeps(),
	intervalMs: number = GITHUB_DEPLOYMENTS_POLL_INTERVAL_MS,
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
