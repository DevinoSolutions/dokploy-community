import { apiUpdateApplication } from "@dokploy/server/db/schema";
import { describe, expect, it } from "vitest";

describe("apiUpdateApplication validates git branch names", () => {
	const base = { applicationId: "app-1" };

	it.each([
		"branch",
		"gitlabBranch",
		"bitbucketBranch",
		"giteaBranch",
		"customGitBranch",
	])("rejects a %s that is not a valid branch name", (field) => {
		for (const value of ["--upload-pack=touch /tmp/x", "a b", "main;ls", ""]) {
			expect(
				apiUpdateApplication.safeParse({ ...base, [field]: value }).success,
			).toBe(false);
		}
	});

	it.each([
		"branch",
		"gitlabBranch",
		"bitbucketBranch",
		"giteaBranch",
		"customGitBranch",
	])("accepts a valid, null or omitted %s", (field) => {
		for (const value of ["main", "feature/new-ui", null, undefined]) {
			expect(
				apiUpdateApplication.safeParse({ ...base, [field]: value }).success,
			).toBe(true);
		}
	});
});
