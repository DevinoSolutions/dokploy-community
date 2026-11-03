import type { GhaGateMode } from "@dokploy/server/db/schema";

/**
 * The deploy gate settings of a connection, and what a change of them means.
 * Pure: the router asks whether a change weakens the gate (then only an owner
 * or admin may make it), the store asks whether it restarts the gate.
 */

export interface GateSettings {
	gateMode: GhaGateMode;
	gateWorkflows: string[];
	gateTimeoutMinutes: number;
}

/**
 * A change that lets a release through on less than before: turning the gate
 * off, swapping one kind of gate for another (not comparable, so not assumed
 * stronger), dropping a workflow from the list, or waiting longer for a check
 * that never reports.
 */
export const gateChangeWeakens = (
	before: GateSettings,
	after: GateSettings,
): boolean => {
	if (after.gateMode === "image" && before.gateMode !== "image") return true;
	if (
		before.gateMode !== "image" &&
		after.gateMode !== "image" &&
		after.gateMode !== before.gateMode
	) {
		return true;
	}
	if (before.gateWorkflows.some((name) => !after.gateWorkflows.includes(name))) {
		return true;
	}
	return after.gateTimeoutMinutes > before.gateTimeoutMinutes;
};

/** Which parts of a change start the gate over for the release that is waiting. */
export const gateChangeRestarts = (
	before: GateSettings,
	after: GateSettings,
): { full: boolean; timer: boolean } => {
	const full =
		after.gateMode !== before.gateMode ||
		(after.gateMode === "workflows" &&
			[...after.gateWorkflows].sort().join("\n") !==
				[...before.gateWorkflows].sort().join("\n"));
	// A longer wait gives a release held for a timeout its time again.
	const timer = after.gateTimeoutMinutes > before.gateTimeoutMinutes;
	return { full, timer: full || timer };
};
