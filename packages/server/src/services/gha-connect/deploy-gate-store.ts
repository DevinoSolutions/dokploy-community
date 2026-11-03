import { db } from "@dokploy/server/db";
import {
	type GhaGateMode,
	type GhaGateOverride,
	ghaConnection,
	ghaRelease,
} from "@dokploy/server/db/schema";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
	type GateSettings,
	gateChangeRestarts,
} from "./deploy-gate-settings";
import type { DeployGateStore } from "./deploy-gate-step";
import { reduceConnection } from "./state-machine";

/**
 * Reads and writes of the deploy gate (T-13720): the `DeployGateStore` that
 * `runDeployGate` writes through, the settings change and Deploy anyway. The
 * rules live in deploy-gate.ts and deploy-gate-step.ts.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lift a block the GATE set, the way the state machine says. A connection that
 * is Blocked for another reason (a refused release) is left alone.
 */
const unblockGateInTransaction = async (
	tx: Tx,
	ghaConnectionId: string,
	hasRelease: boolean,
) => {
	const [row] = await tx
		.select({
			state: ghaConnection.state,
			detail: ghaConnection.stateDetail,
			gateBlocked: ghaConnection.gateBlocked,
		})
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
		.for("update");
	if (!row?.gateBlocked) return;
	if (row.state !== "blocked") {
		await tx
			.update(ghaConnection)
			.set({ gateBlocked: false })
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		return;
	}
	const after = reduceConnection(
		{ state: row.state, detail: row.detail },
		{ type: "unblock", hasRelease },
	);
	await tx
		.update(ghaConnection)
		.set({
			state: after.state,
			stateDetail: after.detail,
			stateSince: new Date(),
			lastError: null,
			gateBlocked: false,
		})
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
};

/** Block the connection for the gate, unless something else already blocks it. */
const blockGateInTransaction = async (
	tx: Tx,
	ghaConnectionId: string,
	reason: string,
) => {
	const [row] = await tx
		.select({
			state: ghaConnection.state,
			detail: ghaConnection.stateDetail,
			gateBlocked: ghaConnection.gateBlocked,
		})
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
		.for("update");
	if (!row) return;
	if (row.state === "blocked" && !row.gateBlocked) return;
	const after = reduceConnection(
		{ state: row.state, detail: row.detail },
		{ type: "release-refused", message: reason, block: true },
	);
	if (after.state !== "blocked") return;
	await tx
		.update(ghaConnection)
		.set({
			state: after.state,
			stateDetail: after.detail,
			...(row.state !== "blocked" ? { stateSince: new Date() } : {}),
			lastError: reason,
			gateBlocked: true,
		})
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
};

export const dbDeployGateStore: DeployGateStore = {
	clearGateStart: async (ghaConnectionId) => {
		await db
			.update(ghaConnection)
			.set({ gateStartedAt: null })
			.where(
				and(
					eq(ghaConnection.ghaConnectionId, ghaConnectionId),
					// Nothing to write when the gate never waited.
					isNotNull(ghaConnection.gateStartedAt),
				),
			);
	},

	recordGateOutcome: async (ghaConnectionId, releaseId, outcome) =>
		db.transaction(async (tx) => {
			// Only a release that is still waiting to go out, was not overridden by a
			// Deploy anyway that came in meanwhile, and was not evaluated by someone
			// else since it was read.
			const updated = await tx
				.update(ghaRelease)
				.set({
					gateState: outcome.gateState,
					gateReason: outcome.gateReason,
					gateCheckedAt: outcome.checkedAt,
					...(outcome.gateExpected
						? { gateExpected: outcome.gateExpected }
						: {}),
				})
				.where(
					and(
						eq(ghaRelease.releaseId, releaseId),
						eq(ghaRelease.status, "accepted"),
						sql`${ghaRelease.gateState} IS DISTINCT FROM 'overridden'`,
						outcome.previousCheckedAt
							? eq(ghaRelease.gateCheckedAt, outcome.previousCheckedAt)
							: isNull(ghaRelease.gateCheckedAt),
					),
				)
				.returning({ releaseId: ghaRelease.releaseId });
			if (updated.length === 0) return false;

			if (outcome.gateStart !== "keep") {
				await tx
					.update(ghaConnection)
					.set({
						gateStartedAt: outcome.gateStart === "mark" ? outcome.checkedAt : null,
					})
					.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
			}
			if (outcome.connection === "block") {
				await blockGateInTransaction(
					tx,
					ghaConnectionId,
					outcome.gateReason ?? "Blocked by the deploy gate",
				);
			} else if (outcome.connection === "unblock") {
				await unblockGateInTransaction(tx, ghaConnectionId, outcome.hasRelease);
			}
			return true;
		}),
};

export interface GateSettingsChange {
	gateMode?: GhaGateMode;
	gateWorkflows?: string[];
	gateTimeoutMinutes?: number;
}

export interface GateSettingsResult {
	before: GateSettings;
	after: GateSettings;
	restarted: boolean;
}

/**
 * Save the gate settings of a connection. A change of the mode or of the
 * workflows starts the gate over for the release still waiting (its gate
 * state and learned check set are forgotten); a longer wait gives a release
 * held for a timeout its time again. Either way the start time is cleared, the
 * gate's own block is lifted, and an evaluation that was in flight is
 * discarded (its compare-and-set value is gone). A release that was told to
 * Deploy anyway keeps that. Returns null when the connection is gone.
 */
export const updateGateSettings = async (
	ghaConnectionId: string,
	change: GateSettingsChange,
): Promise<GateSettingsResult | null> =>
	db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
			.for("update");
		if (!row) return null;
		const before: GateSettings = {
			gateMode: row.gateMode,
			gateWorkflows: row.gateWorkflows,
			gateTimeoutMinutes: row.gateTimeoutMinutes,
		};
		const after: GateSettings = {
			gateMode: change.gateMode ?? before.gateMode,
			gateWorkflows: change.gateWorkflows ?? before.gateWorkflows,
			gateTimeoutMinutes: change.gateTimeoutMinutes ?? before.gateTimeoutMinutes,
		};
		const restarts = gateChangeRestarts(before, after);
		await tx
			.update(ghaConnection)
			.set({
				...after,
				...(restarts.timer ? { gateStartedAt: null } : {}),
			})
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		if (restarts.timer) {
			const waiting = and(
				eq(ghaRelease.ghaConnectionId, ghaConnectionId),
				eq(ghaRelease.status, "accepted"),
				sql`${ghaRelease.gateState} IS DISTINCT FROM 'overridden'`,
			);
			await tx
				.update(ghaRelease)
				.set(
					restarts.full
						? {
								gateState: null,
								gateReason: null,
								gateCheckedAt: null,
								gateExpected: null,
							}
						: { gateCheckedAt: null },
				)
				.where(waiting);
			await unblockGateInTransaction(
				tx,
				ghaConnectionId,
				row.deployedSha !== null,
			);
		}
		return { before, after, restarted: restarts.timer };
	});

/** The release the gate is about: the newest one that was accepted and not yet deployed. */
export const findGatedRelease = async (ghaConnectionId: string) => {
	const [row] = await db
		.select()
		.from(ghaRelease)
		.where(
			and(
				eq(ghaRelease.ghaConnectionId, ghaConnectionId),
				eq(ghaRelease.status, "accepted"),
			),
		)
		.orderBy(desc(ghaRelease.createdAt))
		.limit(1);
	return row ?? null;
};

export type OverrideResult =
	| { kind: "ok"; releaseId: string; sha: string }
	/** No release is waiting. */
	| { kind: "none" }
	/** The release named is not the newest accepted one. */
	| { kind: "conflict"; newestReleaseId: string; newestSha: string };

/**
 * Deploy anyway: the named release goes without its checks, provided it is
 * still the newest accepted release (a newer one may have arrived while the
 * dialog was open). The who, when and why are kept on the release; the gate's
 * block is lifted and its start time cleared.
 */
export const overrideGate = async (
	ghaConnectionId: string,
	releaseId: string,
	override: GhaGateOverride,
): Promise<OverrideResult> =>
	db.transaction(async (tx) => {
		const [newest] = await tx
			.select()
			.from(ghaRelease)
			.where(
				and(
					eq(ghaRelease.ghaConnectionId, ghaConnectionId),
					eq(ghaRelease.status, "accepted"),
				),
			)
			.orderBy(desc(ghaRelease.createdAt))
			.limit(1)
			.for("update");
		if (!newest) return { kind: "none" } as const;
		if (newest.releaseId !== releaseId) {
			return {
				kind: "conflict",
				newestReleaseId: newest.releaseId,
				newestSha: newest.sha,
			} as const;
		}
		await tx
			.update(ghaRelease)
			.set({
				gateState: "overridden",
				gateReason: `Deployed anyway by ${override.by}`,
				gateCheckedAt: new Date(override.at),
				gateOverride: override,
			})
			.where(eq(ghaRelease.releaseId, newest.releaseId));
		const [connection] = await tx
			.select({ deployedSha: ghaConnection.deployedSha })
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		await tx
			.update(ghaConnection)
			.set({ gateStartedAt: null, lastActivityAt: new Date() })
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		await unblockGateInTransaction(
			tx,
			ghaConnectionId,
			(connection?.deployedSha ?? null) !== null,
		);
		return { kind: "ok", releaseId: newest.releaseId, sha: newest.sha } as const;
	});
