import { describe, expect, it } from "vitest";
import {
	addWorkflowNames,
	GATE_OPTIONS,
	gateFormProblem,
	gateStatusLine,
} from "@/components/dashboard/shared/gha-deploy-gate-model";

describe("the Deploy when options", () => {
	it("are the three modes in plain words, without jargon", () => {
		expect(GATE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
			["image", "the image is built"],
			["checks", "all checks on the commit pass"],
			["workflows", "these workflows pass"],
		]);
		for (const o of GATE_OPTIONS) {
			expect(`${o.label} ${o.hint}`).not.toMatch(/gate|sha|digest|artifact/i);
		}
	});
});

describe("addWorkflowNames", () => {
	it("adds trimmed names, splitting on commas and new lines, without repeats or blanks", () => {
		expect(addWorkflowNames(["CI"], " Lint , CI\n\nSecurity,, ")).toEqual([
			"CI",
			"Lint",
			"Security",
		]);
	});

	it("skips a name over 100 characters and stops at 20", () => {
		expect(addWorkflowNames([], "x".repeat(101))).toEqual([]);
		const many = Array.from({ length: 25 }, (_, i) => `w${i}`).join(",");
		expect(addWorkflowNames([], many)).toHaveLength(20);
	});
});

describe("gateFormProblem", () => {
	const ok = { mode: "checks" as const, workflows: [], timeout: "60" };

	it("accepts a valid form", () => {
		expect(gateFormProblem(ok)).toBeNull();
		expect(gateFormProblem({ ...ok, mode: "image" })).toBeNull();
		expect(
			gateFormProblem({ ...ok, mode: "workflows", workflows: ["CI"] }),
		).toBeNull();
	});

	it("asks for a workflow when that is the gate", () => {
		expect(gateFormProblem({ ...ok, mode: "workflows" })).toBe(
			"Add at least one workflow.",
		);
	});

	it("keeps the waiting time within 5 to 720 minutes", () => {
		for (const timeout of ["4", "721", "", "abc", "10.5"]) {
			expect(gateFormProblem({ ...ok, timeout }), timeout).toBe(
				"Waiting time is 5 to 720 minutes.",
			);
		}
		expect(gateFormProblem({ ...ok, timeout: "5" })).toBeNull();
		expect(gateFormProblem({ ...ok, timeout: "720" })).toBeNull();
	});
});

describe("gateStatusLine", () => {
	it("shows a waiting or blocked release, and nothing else", () => {
		expect(
			gateStatusLine({ gateState: "waiting", gateReason: "Waiting for test" }),
		).toEqual({ tone: "waiting", text: "Waiting for test" });
		expect(
			gateStatusLine({ gateState: "blocked", gateReason: "Check test failed" }),
		).toEqual({ tone: "blocked", text: "Check test failed" });
		expect(
			gateStatusLine({ gateState: "passed", gateReason: null }),
		).toBeNull();
		expect(gateStatusLine({ gateState: null, gateReason: null })).toBeNull();
		expect(gateStatusLine(undefined)).toBeNull();
	});
});
