import { db } from "@dokploy/server/db";
import {
	type GhaGateMode,
	type GhaGateOverride,
	ghaConnection,
	ghaRelease,
} from "@dokploy/server/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { DeployGateStore } from "./deploy-gate-step";
import { reduceConnection } from "./state-machine";

/**
 * Reads and writes of the deploy gate (T-13720): the `DeployGateStore` that
 * `runDeployGate` writes through, the settings change and Deploy anyway. The
 * rules live in deploy-gate.ts and deploy-gate-step.ts.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The connection leaves `blocked` the way the state machine says it does. */
const unblockInTransaction = async (
	tx: Tx,
	ghaConnectionId: string,
	hasRelease: boolean,
) => {
	const [row] = await tx
		.select({
			state: ghaConnection.state,
			detail: ghaConnection.stateDetail,
		})
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
		.for("update");
	if (!row || row.state !== "blocked") return;
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
		})
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
};

export const dbDeployGateStore: DeployGateStore = {
	markGateStarted: async (ghaConnectionId, at) => {
		await db
			.update(ghaConnection)
			.set({ gateStartedAt: at })
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
	},
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
	recordGateOutcome: async (releaseId, outcome) => {
		await db
			.update(ghaRelease)
			.set({
				gateState: outcome.gateState,
				gateReason: outcome.gateReason,
				gateCheckedAt: outcome.checkedAt,
				...(outcome.gateExpected ? { gateExpected: outcome.gateExpected } : {}),
			})
			.where(eq(ghaRelease.releaseId, releaseId));
	},
	blockConnection: async (ghaConnectionId, reason) => {
		await db.transaction(async (tx) => {
			const [row] = await tx
				.select({
					state: ghaConnection.state,
					detail: ghaConnection.stateDetail,
				})
				.from(ghaConnection)
				.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
				.for("update");
			if (!row) return;
			const after = reduceConnection(
				{ state: row.state, detail: row.detail },
				{ type: "release-refused", message: reason, block: true },
			);
			if (after.state === row.state && after.detail === row.detail) return;
			await tx
				.update(ghaConnection)
				.set({
					state: after.state,
					stateDetail: after.detail,
					stateSince: new Date(),
					lastError: reason,
				})
				.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		});
	},
	unblockConnection: async (ghaConnectionId, hasRelease) => {
		await db.transaction((tx) =>
			unblockInTransaction(tx, ghaConnectionId, hasRelease),
		);
	},
};

export interface GateSettingsChange {
	gateMode?: GhaGateMode;
	gateWorkflows?: string[];
	gateTimeoutMinutes?: number;
}

/**
 * Save the gate settings of a connection. Changing the mode or the workflows
 * starts the gate over for the releases still waiting: their gate state and
 * learned check set are forgotten, the start time is cleared, and a Blocked
 * connection is unblocked ("a gate mode change" is one of Blocked's exits).
 * Returns null when the connection is gone.
 */
export const updateGateSettings = async (
	ghaConnectionId: string,
	change: GateSettingsChange,
): Promise<{ gateMode: GhaGateMode; restarted: boolean } | null> =>
	db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
			.for("update");
		if (!row) return null;
		const nextMode = change.gateMode ?? row.gateMode;
		const nextWorkflows = change.gateWorkflows ?? row.gateWorkflows;
		const restarted =
			nextMode !== row.gateMode ||
			(nextMode === "workflows" &&
				nextWorkflows.join("\n") !== row.gateWorkflows.join("\n"));
		await tx
			.update(ghaConnection)
			.set({
				gateMode: nextMode,
				gateWorkflows: nextWorkflows,
				gateTimeoutMinutes: change.gateTimeoutMinutes ?? row.gateTimeoutMinutes,
				...(restarted ? { gateStartedAt: null } : {}),
			})
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		if (restarted) {
			await tx
				.update(ghaRelease)
				.set({
					gateState: null,
					gateReason: null,
					gateCheckedAt: null,
					gateExpected: null,
				})
				.where(
					and(
						eq(ghaRelease.ghaConnectionId, ghaConnectionId),
						eq(ghaRelease.status, "accepted"),
					),
				);
			await unblockInTransaction(tx, ghaConnectionId, row.deployedSha !== null);
		}
		return { gateMode: nextMode, restarted };
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

/**
 * Deploy anyway: the newest accepted release goes without its checks. The
 * who, when and why are kept on the release; a Blocked connection is unblocked
 * and the gate's start time cleared. Returns null when no release is waiting.
 */
export const overrideGate = async (
	ghaConnectionId: string,
	override: GhaGateOverride,
): Promise<{ releaseId: string; sha: string } | null> =>
	db.transaction(async (tx) => {
		const [release] = await tx
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
		if (!release) return null;
		await tx
			.update(ghaRelease)
			.set({
				gateState: "overridden",
				gateReason: `Deployed anyway by ${override.by}`,
				gateCheckedAt: new Date(override.at),
				gateOverride: override,
			})
			.where(eq(ghaRelease.releaseId, release.releaseId));
		const [connection] = await tx
			.select({ deployedSha: ghaConnection.deployedSha })
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		await tx
			.update(ghaConnection)
			.set({ gateStartedAt: null, lastActivityAt: new Date() })
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		await unblockInTransaction(
			tx,
			ghaConnectionId,
			(connection?.deployedSha ?? null) !== null,
		);
		return { releaseId: release.releaseId, sha: release.sha };
	});
