import { db } from "@dokploy/server/db";
import {
	type GhaProcessedRun,
	type GhaReleaseStatus,
	type GithubWatchServiceType,
	ghaConnection,
	ghaRelease,
} from "@dokploy/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { mergeProcessed } from "./processed";
import {
	type ConnectionEvent,
	reduceConnection,
	type StateView,
} from "./state-machine";

/** Reads and writes of gha_connection and gha_release. The rules live in the pure modules next to this file. */

export type GhaConnectionRow = typeof ghaConnection.$inferSelect;
export type GhaReleaseRow = typeof ghaRelease.$inferSelect;

export const findGhaConnection = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	const [row] = await db
		.select()
		.from(ghaConnection)
		.where(
			and(
				eq(ghaConnection.serviceType, serviceType),
				eq(ghaConnection.serviceId, serviceId),
			),
		);
	return row ?? null;
};

export const findGhaConnectionById = async (ghaConnectionId: string) => {
	const [row] = await db
		.select()
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
	return row ?? null;
};

export const listGhaConnections = async () => db.select().from(ghaConnection);

export const createGhaConnection = async (
	input: typeof ghaConnection.$inferInsert,
	executor: Pick<typeof db, "insert"> = db,
) => {
	const [row] = await executor.insert(ghaConnection).values(input).returning();
	if (!row) throw new Error("Could not save the connection");
	return row;
};

export const deleteGhaConnection = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	await db
		.delete(ghaConnection)
		.where(
			and(
				eq(ghaConnection.serviceType, serviceType),
				eq(ghaConnection.serviceId, serviceId),
			),
		);
};

/**
 * Apply one event to the stored state. Read-modify-write in a transaction;
 * `stateSince` only moves when the state really changes. `note` replaces
 * `lastError` (null clears it).
 */
export const applyConnectionEvent = async (
	ghaConnectionId: string,
	event: ConnectionEvent,
	note?: string | null,
): Promise<StateView | null> =>
	db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
			.for("update");
		if (!row) return null;
		const before: StateView = {
			state: row.state,
			detail: row.stateDetail,
		};
		const after = reduceConnection(before, event);
		const changed = after.state !== before.state;
		await tx
			.update(ghaConnection)
			.set({
				state: after.state,
				stateDetail: after.detail,
				...(changed ? { stateSince: new Date() } : {}),
				...(note !== undefined ? { lastError: note } : {}),
			})
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		return after;
	});

export const recordProcessedRuns = async (
	ghaConnectionId: string,
	entries: GhaProcessedRun[],
) => {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ processed: ghaConnection.processed })
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
			.for("update");
		if (!row) return;
		await tx
			.update(ghaConnection)
			.set({
				processed: mergeProcessed(row.processed, entries),
				lastActivityAt: new Date(),
			})
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
	});
};

export const touchConnectionActivity = async (ghaConnectionId: string) => {
	await db
		.update(ghaConnection)
		.set({ lastActivityAt: new Date() })
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
};

export interface ReleaseInput {
	ghaConnectionId: string;
	manifestReleaseId: string;
	sha: string;
	runId: number;
	runAttempt: number;
	delivery: "pull" | "push";
	status: GhaReleaseStatus;
	githubDeploymentId: number | null;
	images: Array<{ name: string; composeService: string; ref: string }>;
	digests: string[];
	/** The service as it was before this release changed it. */
	sourceBackup?: Record<string, unknown> | null;
}

/** One history row per (connection, run, attempt); a repeat changes nothing. */
export const recordRelease = async (
	input: ReleaseInput,
	executor: Pick<typeof db, "insert"> = db,
) => {
	await executor
		.insert(ghaRelease)
		.values({
			...input,
			settledAt: input.status === "accepted" ? null : new Date(),
		})
		.onConflictDoNothing({
			target: [
				ghaRelease.ghaConnectionId,
				ghaRelease.runId,
				ghaRelease.runAttempt,
			],
		});
};

export const findReleaseByDeployment = async (
	ghaConnectionId: string,
	githubDeploymentId: number,
) => {
	const [row] = await db
		.select()
		.from(ghaRelease)
		.where(
			and(
				eq(ghaRelease.ghaConnectionId, ghaConnectionId),
				eq(ghaRelease.githubDeploymentId, githubDeploymentId),
			),
		);
	return row ?? null;
};

/**
 * A Dokploy deployment ended: settle the release row and, when it succeeded,
 * make it the deployed release of the connection. Safe to repeat.
 */
export const settleRelease = async (
	ghaConnectionId: string,
	githubDeploymentId: number,
	outcome: "deployed" | "failed",
) => {
	await db.transaction(async (tx) => {
		const [release] = await tx
			.select()
			.from(ghaRelease)
			.where(
				and(
					eq(ghaRelease.ghaConnectionId, ghaConnectionId),
					eq(ghaRelease.githubDeploymentId, githubDeploymentId),
				),
			)
			.for("update");
		if (!release) return;
		await tx
			.update(ghaRelease)
			.set({ status: outcome, settledAt: new Date() })
			.where(eq(ghaRelease.releaseId, release.releaseId));
		if (outcome === "deployed") {
			await tx
				.update(ghaConnection)
				.set({
					deployedSha: release.sha,
					deployedRunId: release.runId,
					deployedRunAttempt: release.runAttempt,
					deployedDigests: release.digests,
					deployedAt: new Date(),
					lastActivityAt: new Date(),
				})
				.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		}
	});
};

/**
 * A release that needs no deploy was verified (a `push` release, or a `pull`
 * release that matches what runs): it advances the deployed commit like a
 * deploy would. The row is `noop` when the caller says so, else `verified`.
 */
export const recordVerifiedRelease = async (input: ReleaseInput) => {
	await db.transaction(async (tx) => {
		await recordRelease(
			{ ...input, status: input.status === "noop" ? "noop" : "verified" },
			tx,
		);
		await tx
			.update(ghaConnection)
			.set({
				deployedSha: input.sha,
				deployedRunId: input.runId,
				deployedRunAttempt: input.runAttempt,
				deployedDigests: input.digests,
				deployedAt: new Date(),
				lastActivityAt: new Date(),
			})
			.where(eq(ghaConnection.ghaConnectionId, input.ghaConnectionId));
	});
};

export const listReleases = async (ghaConnectionId: string, limit = 10) =>
	db
		.select()
		.from(ghaRelease)
		.where(eq(ghaRelease.ghaConnectionId, ghaConnectionId))
		.orderBy(desc(ghaRelease.createdAt))
		.limit(limit);
