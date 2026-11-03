import {
	type GateSettings,
	gateChangeRestarts,
	gateChangeWeakens,
} from "@dokploy/server/services/gha-connect/deploy-gate-settings";
import { describe, expect, it } from "vitest";

const checks: GateSettings = {
	gateMode: "checks",
	gateWorkflows: [],
	gateTimeoutMinutes: 60,
};
const workflows: GateSettings = {
	gateMode: "workflows",
	gateWorkflows: ["CI", "Lint"],
	gateTimeoutMinutes: 60,
};
const image: GateSettings = { ...checks, gateMode: "image" };

describe("gateChangeWeakens", () => {
	it("turning the gate off weakens it", () => {
		expect(gateChangeWeakens(checks, { ...checks, gateMode: "image" })).toBe(
			true,
		);
		expect(
			gateChangeWeakens(workflows, { ...workflows, gateMode: "image" }),
		).toBe(true);
	});

	it("swapping one kind of gate for the other is not assumed stronger", () => {
		expect(
			gateChangeWeakens(checks, { ...checks, gateMode: "workflows" }),
		).toBe(true);
		expect(
			gateChangeWeakens(workflows, { ...workflows, gateMode: "checks" }),
		).toBe(true);
	});

	it("removing a workflow weakens it, adding one does not", () => {
		expect(
			gateChangeWeakens(workflows, { ...workflows, gateWorkflows: ["CI"] }),
		).toBe(true);
		expect(
			gateChangeWeakens(workflows, {
				...workflows,
				gateWorkflows: ["CI", "Lint", "Security"],
			}),
		).toBe(false);
		// Renaming one is removing one.
		expect(
			gateChangeWeakens(workflows, {
				...workflows,
				gateWorkflows: ["CI", "Other"],
			}),
		).toBe(true);
	});

	it("waiting longer weakens it, a shorter wait does not", () => {
		expect(
			gateChangeWeakens(checks, { ...checks, gateTimeoutMinutes: 61 }),
		).toBe(true);
		expect(
			gateChangeWeakens(checks, { ...checks, gateTimeoutMinutes: 30 }),
		).toBe(false);
	});

	it("turning the gate on, or no change, does not", () => {
		expect(gateChangeWeakens(image, checks)).toBe(false);
		expect(gateChangeWeakens(image, workflows)).toBe(false);
		expect(gateChangeWeakens(checks, checks)).toBe(false);
	});
});

describe("gateChangeRestarts", () => {
	it("a mode or workflow change restarts everything", () => {
		expect(gateChangeRestarts(checks, image)).toEqual({
			full: true,
			timer: true,
		});
		expect(
			gateChangeRestarts(workflows, { ...workflows, gateWorkflows: ["CI"] }),
		).toEqual({ full: true, timer: true });
	});

	it("the same workflows in another order do not", () => {
		expect(
			gateChangeRestarts(workflows, {
				...workflows,
				gateWorkflows: ["Lint", "CI"],
			}),
		).toEqual({ full: false, timer: false });
	});

	it("a longer wait restarts the timer only; a shorter one nothing", () => {
		expect(
			gateChangeRestarts(checks, { ...checks, gateTimeoutMinutes: 120 }),
		).toEqual({ full: false, timer: true });
		expect(
			gateChangeRestarts(checks, { ...checks, gateTimeoutMinutes: 10 }),
		).toEqual({ full: false, timer: false });
	});

	it("workflows listed under another mode do not matter", () => {
		expect(
			gateChangeRestarts(checks, { ...checks, gateWorkflows: ["CI"] }),
		).toEqual({ full: false, timer: false });
	});
});
