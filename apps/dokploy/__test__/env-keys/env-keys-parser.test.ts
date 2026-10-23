import { listEnvKeys } from "@dokploy/server/services/service-secrets";
import { describe, expect, it } from "vitest";

describe("listEnvKeys", () => {
	it("returns each key once, in order, and never a value", () => {
		const keys = listEnvKeys("B=2\nA=1\nC=3\n");
		expect(keys).toEqual(["B", "A", "C"]);
	});

	it("skips comments and blank lines", () => {
		expect(
			listEnvKeys("# a comment\n\nA=1\n   # indented comment\nB=2 # trailing"),
		).toEqual(["A", "B"]);
	});

	it("accepts an export prefix", () => {
		expect(listEnvKeys("export A=1\nexport   B=2\nC=3")).toEqual([
			"A",
			"B",
			"C",
		]);
	});

	it("handles single, double and backtick quoted values", () => {
		expect(
			listEnvKeys('A=\'one two\'\nB="three # four"\nC=`five`\nD="=x="'),
		).toEqual(["A", "B", "C", "D"]);
	});

	it("does not read a line inside a multiline quoted value as a key", () => {
		const source = 'KEY="line1\nINNER=oops\nline3"\nAFTER=1\n';
		expect(listEnvKeys(source)).toEqual(["KEY", "AFTER"]);
	});

	it("keeps a key whose value is empty", () => {
		expect(listEnvKeys("A=\nB=''\nC=\"\"\nD=1")).toEqual(["A", "B", "C", "D"]);
	});

	it("lists a repeated key once, at its first position", () => {
		expect(listEnvKeys("A=1\nB=2\nA=3\nC=4\nB=5")).toEqual(["A", "B", "C"]);
	});

	it("handles CRLF line endings", () => {
		expect(listEnvKeys("A=1\r\nB=2\r\n")).toEqual(["A", "B"]);
	});

	it("keeps vault and project references as plain values", () => {
		expect(
			listEnvKeys("DB=${{vault.main.password}}\nURL=${{project.URL}}"),
		).toEqual(["DB", "URL"]);
	});

	it("returns an empty list for empty, null and undefined input", () => {
		expect(listEnvKeys("")).toEqual([]);
		expect(listEnvKeys(null)).toEqual([]);
		expect(listEnvKeys(undefined)).toEqual([]);
		expect(listEnvKeys("# only a comment\n")).toEqual([]);
	});
});
