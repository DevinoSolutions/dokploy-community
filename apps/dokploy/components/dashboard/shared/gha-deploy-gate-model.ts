/**
 * The "Deploy when" form of a service that follows GitHub Actions (T-13720):
 * the options in plain words and the checks the form makes before it saves.
 * The server checks the same bounds again.
 */

export type GateMode = "image" | "checks" | "workflows";

export const GATE_OPTIONS: Array<{
	value: GateMode;
	label: string;
	hint: string;
}> = [
	{
		value: "image",
		label: "the image is built",
		hint: "Deploys as soon as GitHub Actions has built it.",
	},
	{
		value: "checks",
		label: "all checks on the commit pass",
		hint: "Waits for the checks your branch requires, or the ones that passed on the last good commit.",
	},
	{
		value: "workflows",
		label: "these workflows pass",
		hint: "Waits for the workflows you name below.",
	},
];

export const WORKFLOWS_MAX = 20;
export const WORKFLOW_NAME_MAX = 100;
export const TIMEOUT_MIN = 5;
export const TIMEOUT_MAX = 720;
export const TIMEOUT_DEFAULT = 60;

/**
 * Add what was typed or pasted to the list of workflow names: commas and new
 * lines separate names, blanks and repeats are dropped, a name over 100
 * characters is not added, and the list stops at 20.
 */
export const addWorkflowNames = (
	current: string[],
	typed: string,
): string[] => {
	const next = [...current];
	for (const piece of typed.split(/[,\n]/)) {
		const name = piece.trim();
		if (!name || name.length > WORKFLOW_NAME_MAX) continue;
		if (next.length >= WORKFLOWS_MAX) break;
		if (!next.includes(name)) next.push(name);
	}
	return next;
};

/** Why the form cannot be saved yet, in a short sentence; null when it can. */
export const gateFormProblem = (form: {
	mode: GateMode;
	workflows: string[];
	timeout: string;
}): string | null => {
	if (form.mode === "workflows" && form.workflows.length === 0) {
		return "Add at least one workflow.";
	}
	const minutes = Number(form.timeout);
	if (
		form.timeout.trim() === "" ||
		!Number.isInteger(minutes) ||
		minutes < TIMEOUT_MIN ||
		minutes > TIMEOUT_MAX
	) {
		return `Waiting time is ${TIMEOUT_MIN} to ${TIMEOUT_MAX} minutes.`;
	}
	return null;
};

/** The one line shown while a release waits at the gate. */
export const gateStatusLine = (
	release: { gateState: string | null; gateReason: string | null } | undefined,
): { tone: "waiting" | "blocked"; text: string } | null => {
	if (!release?.gateState) return null;
	if (release.gateState === "waiting") {
		return { tone: "waiting", text: release.gateReason ?? "Waiting for CI" };
	}
	if (release.gateState === "blocked") {
		return { tone: "blocked", text: release.gateReason ?? "Blocked" };
	}
	return null;
};
