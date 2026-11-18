import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditIgnoreProblems } from "../../../../scripts/check-audit-ignore-expiry.mjs";

const pkg = (
	ignoreGhsas: string[],
	auditIgnoreExpiry?: Record<string, unknown>,
) => ({
	pnpm: { auditConfig: { ignoreGhsas } },
	...(auditIgnoreExpiry ? { auditIgnoreExpiry } : {}),
});
const GHSA = "GHSA-fc5q-39xc-vjpf";
const dated = (value: unknown) => pkg([GHSA], { [GHSA]: value });

describe("auditIgnoreProblems", () => {
	it.each([
		[dated("expires=2026-12-01 | no patched release"), "2026-11-17", 0],
		[dated("expires=2026-12-01 | no patched release"), "2026-11-30", 0],
		// the expiry day itself is expired, and it stays red afterwards
		[dated("expires=2026-12-01 | no patched release"), "2026-12-01", 1],
		[dated("expires=2026-12-01 | no patched release"), "2027-06-01", 1],
		// more than 30 days out is a mute, not a loan
		[dated("expires=2027-01-15 | no patched release"), "2026-11-17", 1],
		// no reason, not the shape, not a real date
		[dated("expires=2026-12-01"), "2026-11-17", 1],
		[dated("2026-12-01 | reason"), "2026-11-17", 1],
		[dated("expires=2026-11-31 | reason"), "2026-11-17", 1],
		[dated(20261201), "2026-11-17", 1],
		// a dated entry for a GHSA that is no longer muted
		[pkg([], { [GHSA]: "expires=2026-12-01 | x" }), "2026-11-17", 1],
		// nothing muted at all
		[{}, "2026-11-17", 0],
	])("case %#", (input, today, problems) => {
		expect(auditIgnoreProblems(input, today).problems).toHaveLength(problems);
	});

	it("warns, without failing, about a mute with no date", () => {
		const result = auditIgnoreProblems(pkg([GHSA]), "2026-11-17");
		expect(result.problems).toEqual([]);
		expect(result.warnings).toEqual([
			`${GHSA} is muted with no auditIgnoreExpiry entry (an undated mute)`,
		]);
	});

	it("names the expired advisory", () => {
		const { problems } = auditIgnoreProblems(
			dated("expires=2026-12-01 | r"),
			"2026-12-02",
		);
		expect(problems[0]).toMatch(/GHSA-fc5q-39xc-vjpf: the mute expired on 2026-12-01/);
	});

	it("the repo's picomatch mute is dated 2026-12-01 with the required reason", () => {
		const root = JSON.parse(
			readFileSync(join(__dirname, "../../../../package.json"), "utf8"),
		);
		expect(root.pnpm.auditConfig.ignoreGhsas).toContain(GHSA);
		const entry: string = root.auditIgnoreExpiry[GHSA];
		expect(entry).toMatch(
			/^expires=2026-12-01 \| runtime watchPaths now validated and matched with extglob\/brace parsing disabled \(see should-deploy\.ts\); checked .+; drop when picomatch ships a fix \(micromatch\/picomatch#194\)$/,
		);
		expect(auditIgnoreProblems(root, "2026-11-17").problems).toEqual([]);
		expect(auditIgnoreProblems(root, "2026-12-01").problems).toHaveLength(1);
	});
});
