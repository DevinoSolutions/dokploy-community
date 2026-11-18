import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
import type { IntakeHold, QueueBusySnapshot } from "./in-memory-queue";

/**
 * The step in front of anything that restarts the Dokploy service (Update
 * Server, Reload Server): close the deploy intake, then look at what runs.
 *
 * Both happen in one synchronous step inside the queue, so a deploy that
 * arrives after the operator's own look at the queue can no longer start, and
 * the running count it reads can only fall afterwards. Deploys that arrive
 * while the intake is closed are accepted and journaled, and run as ordinary
 * first runs after the restart.
 */

/**
 * Longest the intake stays closed without the process being replaced. The
 * update attempt is declared dead after 15 minutes (UPDATE_ATTEMPT_STALE_MS),
 * so a hold that long covers a slow pull and no more.
 */
export const DEPLOY_INTAKE_HOLD_MS = 15 * 60_000;
/** After the pull, before the swap: the restart is minutes away at most. */
export const DEPLOY_INTAKE_SWAP_HOLD_MS = 5 * 60_000;

/** How many services the refusal names before it says "and N more". */
const NAMED_SERVICES = 5;

export interface RestartGuardQueue {
	closeIntake(ttlMs: number): IntakeHold;
	busy(): QueueBusySnapshot;
}

export type ServiceNames = (ids: {
	applicationIds: string[];
	composeIds: string[];
}) => Promise<{
	applications: Map<string, string>;
	composes: Map<string, string>;
}>;

/** Display names (name, falling back to appName) of the services. */
export const lookupServiceNames: ServiceNames = async ({
	applicationIds,
	composeIds,
}) => {
	const [apps, composes] = await Promise.all([
		applicationIds.length
			? db
					.select({
						id: applications.applicationId,
						name: applications.name,
						appName: applications.appName,
					})
					.from(applications)
					.where(inArray(applications.applicationId, applicationIds))
			: [],
		composeIds.length
			? db
					.select({
						id: compose.composeId,
						name: compose.name,
						appName: compose.appName,
					})
					.from(compose)
					.where(inArray(compose.composeId, composeIds))
			: [],
	]);
	const label = (row: { name: string | null; appName: string }) =>
		row.name || row.appName;
	return {
		applications: new Map(apps.map((row) => [row.id, label(row)])),
		composes: new Map(composes.map((row) => [row.id, label(row)])),
	};
};

/**
 * What the refusal says about the busy work: only service names (never a
 * payload, a log line or a command). A service that cannot be named is counted
 * but not listed.
 */
const describeBusy = async (
	busy: QueueBusySnapshot,
	names: ServiceNames,
): Promise<{ text: string; count: number }> => {
	const groups = [
		...new Set([...busy.active.map((job) => job.group), ...busy.heldGroups]),
	];
	const idsOf = (prefix: string) =>
		groups
			.filter((group) => group.startsWith(prefix))
			.map((group) => group.slice(prefix.length));
	const applicationIds = idsOf("application:");
	const composeIds = idsOf("compose:");
	let listed: string[] = [];
	try {
		const found = await names({ applicationIds, composeIds });
		listed = [
			...applicationIds.flatMap((id) => found.applications.get(id) ?? []),
			...composeIds.flatMap((id) => found.composes.get(id) ?? []),
		];
	} catch {
		// The count alone still says what is in the way.
	}
	const count = groups.length;
	const shown = listed.slice(0, NAMED_SERVICES);
	const more = count - shown.length;
	const noun = count === 1 ? "service has" : "services have";
	const text =
		shown.length === 0
			? `${count} ${noun} a deployment running`
			: `${count} ${noun} a deployment running (${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""})`;
	return { text, count };
};

/**
 * Close the deploy intake for a restart of Dokploy, unless something is
 * running that the restart would interrupt. Returns the hold, which the caller
 * releases if the restart does not happen. Jobs that are only waiting do not
 * stop it: they stay in the journal and start after the restart.
 */
export const closeIntakeForRestart = async (
	queue: RestartGuardQueue,
	action: "update" | "reload",
	names: ServiceNames = lookupServiceNames,
): Promise<IntakeHold> => {
	const hold = queue.closeIntake(DEPLOY_INTAKE_HOLD_MS);
	const busy = queue.busy();
	if (busy.active.length === 0 && busy.heldGroups.length === 0) return hold;
	hold.release();
	const { text, count } = await describeBusy(busy, names);
	const them = count === 1 ? "it" : "them";
	throw new TRPCError({
		code: "CONFLICT",
		message: `Not ${action === "update" ? "updating" : "reloading"}: ${text}. Restarting Dokploy now would interrupt ${them}. Wait for ${them} to finish, then try again.`,
	});
};
