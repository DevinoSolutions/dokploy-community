import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull } from "drizzle-orm";

// Kept apart from external-build.ts: the deploy flows (application.ts, compose.ts) import this, and external-build.ts
// imports them, so a shared file would be an import cycle.

const serviceColumn = (kind: "application" | "compose") =>
	kind === "application" ? deployments.applicationId : deployments.composeId;

/**
 * Not a row that still waits for its GitHub Actions deploy (T-12686): the workflow registered it while GitHub
 * builds, so nothing runs on this instance for it, no log is written by Dokploy, and there is nothing to stop. The
 * run poller ends such a row (a failed run, a run that finished without deploying, or 6 hours); the first deploy
 * call to take it over makes it a normal row (`externalBuildOnly` false). Every other row, including every row written
 * before the column existed, passes.
 */
export const notWaitingForGithubRun = eq(deployments.externalBuildOnly, false);

/** What `claimLiveGithubBuild` needs to know about the deploy that wants the row. */
export type LiveBuildClaim = {
	deploymentId: string;
	kind: "application" | "compose";
	serviceId: string;
	/** The host the deploy writes its log on: build server, else the serving host (null: the Dokploy host). */
	logHost: string | null;
};

/** Who a deploy names: the registered deployment and the service the deploy is for. */
export type LiveBuildReference = Pick<
	LiveBuildClaim,
	"deploymentId" | "kind" | "serviceId"
>;

type ClaimableRow = {
	status: string | null;
	buildOrigin: string | null;
	externalBuildOnly: boolean | null;
	applicationId: string | null;
	composeId: string | null;
	serverId: string | null;
	buildServerId: string | null;
	logPath: string;
};

/**
 * Whether a deploy may continue a row: it is a running GitHub Actions row that no deploy took over yet, belongs to
 * the same service, and its log is on the host the deploy appends to (a log file is only there). A mismatch is not
 * an error: the deploy then writes a row of its own, as it always did.
 */
export const canContinueLiveBuild = (
	row: ClaimableRow,
	claim: Pick<LiveBuildClaim, "kind" | "serviceId" | "logHost">,
): boolean =>
	row.status === "running" &&
	row.buildOrigin === "github-actions" &&
	row.externalBuildOnly === true &&
	Boolean(row.logPath) &&
	(claim.kind === "application" ? row.applicationId : row.composeId) ===
		claim.serviceId &&
	(row.buildServerId || row.serverId || null) === (claim.logHost || null);

/** A registered row nothing took over and that is still open: the only state a deploy request or a poller may end. */
const openRegisteredRow = (deploymentId: string) =>
	and(
		eq(deployments.deploymentId, deploymentId),
		eq(deployments.status, "running"),
		eq(deployments.buildOrigin, "github-actions"),
		eq(deployments.externalBuildOnly, true),
	);

/**
 * Takes over the registered row of the deploy that is about to run: `externalBuildOnly` becomes false and the run
 * state `completed`, so the poller, the watchdog exemption and the derivations all treat it as a deploy row from
 * here; `deployStartedAt` records when the deploy began (the watchdog counts from it). The row keeps its title (the
 * workflow sends the same one); a description the deploy brings is appended. The update is one statement guarded by
 * the row's state, so two deploys can never both take the same row; the loser gets null and creates its own. A row
 * the deploy asked for (`deployQueuedAt`) is taken over however long the deploy waited in the queue. Returns the
 * row (same log path, same deployment id, same start time) or null.
 */
export const claimLiveGithubBuild = async (
	claim: LiveBuildClaim,
	details: { title?: string | null; description?: string | null } = {},
): Promise<typeof deployments.$inferSelect | null> => {
	const row = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, claim.deploymentId),
	});
	if (!row) return null;
	if (!canContinueLiveBuild(row, claim)) {
		// A row this deploy accepted but cannot continue (its log is on another host) would stay open until the
		// backstop: nothing else will ever take it over, so it ends here and the deploy writes a row of its own.
		if (
			row.deployQueuedAt &&
			row.status === "running" &&
			row.buildOrigin === "github-actions" &&
			row.externalBuildOnly &&
			(claim.kind === "application" ? row.applicationId : row.composeId) ===
				claim.serviceId
		) {
			await endQueuedLiveBuild(
				claim.deploymentId,
				"error",
				"The deploy wrote its log on another host than the one this deployment was registered on, so it created its own deployment.",
			);
		}
		return null;
	}
	const extra = details.description?.trim();
	const description =
		extra && extra !== row.description
			? [row.description?.trim(), extra].filter(Boolean).join(" - ")
			: null;
	const claimed = await db
		.update(deployments)
		.set({
			externalBuildOnly: false,
			buildRunStatus: "completed",
			buildRunStep: null,
			deployStartedAt: new Date().toISOString(),
			...(description ? { description } : {}),
		})
		.where(
			and(
				openRegisteredRow(claim.deploymentId),
				eq(serviceColumn(claim.kind), claim.serviceId),
			),
		)
		.returning();
	return claimed[0] ?? null;
};

/**
 * A deploy that names a deployment it cannot continue is refused when it is asked for, not when it runs: an id that
 * does not exist, or one of another service, is a mistake of the caller (400).
 */
export const assertLiveBuildReference = async (
	reference: LiveBuildReference,
): Promise<void> => {
	const row = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, reference.deploymentId),
		columns: { applicationId: true, composeId: true },
	});
	if (!row) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `deploymentId ${reference.deploymentId} does not exist. Send the deploymentId that deployment.registerExternalBuild returned for this service, or leave it out.`,
		});
	}
	const owner =
		reference.kind === "application" ? row.applicationId : row.composeId;
	if (owner !== reference.serviceId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `deploymentId ${reference.deploymentId} does not belong to this ${reference.kind}. Send the deploymentId that deployment.registerExternalBuild returned for this service, or leave it out.`,
		});
	}
};

/**
 * Accepts a deploy for a registered row, before the deploy is queued (T-12686): the id is checked (400 for an id that
 * does not exist or belongs to another service), then the row is marked as having a deploy on the way
 * (`deployQueuedAt`) in one guarded UPDATE. From then on the run poller leaves the row alone, however long the
 * deploy waits in Dokploy's queue, and the queue job takes it over when it starts. A row that is no longer open (it
 * ended, or a deploy already took it over) is refused with 409 CONFLICT, so the caller retries without the id and
 * follows the row the deploy creates. Call `withdrawLiveBuildDeploy` when queueing fails afterwards.
 */
export const requestLiveBuildDeploy = async (
	reference: LiveBuildReference,
): Promise<void> => {
	await assertLiveBuildReference(reference);
	const marked = await db
		.update(deployments)
		.set({
			deployQueuedAt: new Date().toISOString(),
			buildRunStatus: "deploy_queued",
		})
		.where(
			and(
				openRegisteredRow(reference.deploymentId),
				eq(serviceColumn(reference.kind), reference.serviceId),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	if (marked.length === 0) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `deploymentId ${reference.deploymentId} can no longer be continued: it ended or a deploy already took it over. Retry without deploymentId; the deploy creates its own deployment.`,
		});
	}
};

/** Undoes `requestLiveBuildDeploy` when the deploy could not be queued, so the run poller owns the row again. */
export const withdrawLiveBuildDeploy = async (deploymentId: string) => {
	await db
		.update(deployments)
		// The poller reads the real state again on its next pass and corrects the guess.
		.set({ deployQueuedAt: null, buildRunStatus: "in_progress" })
		.where(openRegisteredRow(deploymentId));
};

/**
 * Ends a row whose deploy was accepted but will not take it over: the queued job was removed or replaced before it
 * ran, or it ran on another host. Only an open registered row that has a deploy on the way is touched. True when a
 * row was ended.
 */
export const endQueuedLiveBuild = async (
	deploymentId: string,
	status: "cancelled" | "error",
	message: string,
): Promise<boolean> => {
	const ended = await db
		.update(deployments)
		.set({
			status,
			finishedAt: new Date().toISOString(),
			errorMessage: message,
			buildRunStatus: "completed",
			buildRunStep: null,
		})
		.where(
			and(
				openRegisteredRow(deploymentId),
				isNotNull(deployments.deployQueuedAt),
			),
		)
		.returning({ deploymentId: deployments.deploymentId });
	return ended.length > 0;
};

/** What to tell the row when its queued deploy leaves the queue without running. */
export const QUEUED_DEPLOY_REMOVED_MESSAGE =
	"The deploy that was waiting for this GitHub Actions build was removed from the queue before it ran.";
