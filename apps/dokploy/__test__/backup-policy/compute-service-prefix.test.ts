import { computeServicePrefix } from "@dokploy/server/services/backup-policy";
import { describe, expect, it } from "vitest";

describe("computeServicePrefix", () => {
	it("composes <base>/<project>/<service> when a base prefix is set", () => {
		expect(computeServicePrefix("prod", "billing", "postgres")).toBe(
			"prod/billing/postgres",
		);
	});

	it("omits the base segment when no base prefix is provided", () => {
		expect(computeServicePrefix(null, "billing", "postgres")).toBe(
			"billing/postgres",
		);
		expect(computeServicePrefix(undefined, "billing", "postgres")).toBe(
			"billing/postgres",
		);
		expect(computeServicePrefix("", "billing", "postgres")).toBe(
			"billing/postgres",
		);
		expect(computeServicePrefix("   ", "billing", "postgres")).toBe(
			"billing/postgres",
		);
	});

	it("preserves multi-segment base prefixes and strips outer slashes", () => {
		expect(computeServicePrefix("/a/b/", "proj", "svc")).toBe("a/b/proj/svc");
		expect(computeServicePrefix("a//b", "proj", "svc")).toBe("a/b/proj/svc");
	});

	it("sanitizes spaces into single dashes", () => {
		expect(computeServicePrefix(null, "My Project", "Postgres DB")).toBe(
			"My-Project/Postgres-DB",
		);
	});

	it("collapses runs of illegal characters into a single dash", () => {
		expect(computeServicePrefix("ba$$e", "pr@@j", "s v")).toBe("ba-e/pr-j/s-v");
	});

	it("turns slashes inside project/service names into path-safe dashes", () => {
		// Project and service names are single path segments; an embedded slash must
		// not create an extra directory level.
		expect(computeServicePrefix(null, "team/a", "svc/1")).toBe("team-a/svc-1");
	});

	it("keeps dots, underscores and dashes untouched", () => {
		expect(computeServicePrefix("v1.2_x", "a-b", "c.d_e")).toBe(
			"v1.2_x/a-b/c.d_e",
		);
	});

	it("trims leading and trailing dashes produced by sanitization", () => {
		expect(computeServicePrefix(null, "-proj-", "-svc-")).toBe("proj/svc");
	});

	it("falls back to the service name when project and base are empty", () => {
		expect(computeServicePrefix(null, "", "onlysvc")).toBe("onlysvc");
	});

	it("falls back to a literal 'backup' when every segment is empty", () => {
		expect(computeServicePrefix(null, "", "")).toBe("backup");
		expect(computeServicePrefix("///", "!!!", "@@@")).toBe("backup");
	});

	it("is deterministic across repeated calls with identical inputs", () => {
		const args = ["prod/eu", "My Project", "Postgres 16"] as const;
		const first = computeServicePrefix(...args);
		const second = computeServicePrefix(...args);
		expect(first).toBe(second);
		expect(first).toBe("prod/eu/My-Project/Postgres-16");
	});
});
