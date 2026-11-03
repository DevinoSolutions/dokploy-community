import { describe, expect, test } from "vitest";
import { getDeploymentCommitMeta } from "@/components/dashboard/home/deployment-commit-meta";

describe("getDeploymentCommitMeta (T-13877)", () => {
	test("a GitHub Actions row ignores its description", () => {
		expect(
			getDeploymentCommitMeta({
				title: "GHA production 61c3c874: Flag rows [run 41729774159.1]",
				description: "prev: web@sha256:abc",
			}),
		).toBe("Flag rows (61c3c874)");
		expect(
			getDeploymentCommitMeta({
				title: "GHA rollback production to 61c3c874 [run 1.1]",
				description: "restoring web",
			}),
		).toBe("Rolled back to 61c3c874");
		expect(
			getDeploymentCommitMeta({
				title: "GHA production old",
				description: "Built by GitHub Actions.",
			}),
		).toBe("GHA production old");
	});

	test("a Dokploy row keeps subject and short hash", () => {
		expect(
			getDeploymentCommitMeta({
				title: "play: reads (#83)",
				description: "Commit: 390a3b6abcdef",
			}),
		).toBe("play: reads (#83) (390a3b6)");
	});
});
