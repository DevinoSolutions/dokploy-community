import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

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

/**
 * Takes over the registered row of the deploy that is about to run: `externalBuildOnly` becomes false and the run
 * state `completed`, so the poller, the watchdog exemption and the derivations all treat it as a deploy row from
 * here. The row keeps its title (the workflow sends the same one); a description the deploy brings is appended.
 * The update is one statement guarded by the row's state, so two deploys can never both take the same row; the
 * loser gets null and creates its own. Returns the row (same log path, same deployment id, same start time) or null.
 */
export const claimLiveGithubBuild = async (
	claim: LiveBuildClaim,
	details: { title?: string | null; description?: string | null } = {},
): Promise<typeof deployments.$inferSelect | null> => {
	const row = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, claim.deploymentId),
	});
	if (!row || !canContinueLiveBuild(row, claim)) return null;
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
			...(description ? { description } : {}),
		})
		.where(
			and(
				eq(deployments.deploymentId, claim.deploymentId),
				eq(deployments.status, "running"),
				eq(deployments.buildOrigin, "github-actions"),
				eq(deployments.externalBuildOnly, true),
				eq(serviceColumn(claim.kind), claim.serviceId),
			),
		)
		.returning();
	return claimed[0] ?? null;
};

/**
 * A deploy that names a deployment it cannot continue is refused when it is asked for, not when it runs: an id that
 * does not exist, or one of another service, is a mistake of the caller (400). An id of this service whose row ended
 * or was taken over meanwhile is not: the deploy ignores it and writes its own row (see `claimLiveGithubBuild`).
 */
export const assertLiveBuildReference = async (
	reference: Pick<LiveBuildClaim, "deploymentId" | "kind" | "serviceId">,
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
