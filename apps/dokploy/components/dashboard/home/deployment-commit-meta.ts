import { presentGithubActionsTitle } from "@dokploy/server/services/build-origin-shared";

/** The "subject (sha)" line under a service name in the Recent deployments list. */
export function getDeploymentCommitMeta(d: {
	title?: string | null;
	description?: string | null;
}) {
	// A GitHub Actions title carries the run and the previous image; the list shows the commit and its sha only.
	const github = presentGithubActionsTitle(d.title);
	if (github) return github.text;
	// Any other "GHA " title is shown as stored: the description of such a row is the action's own note, not a commit.
	if (d.title && /^GHA\s/i.test(d.title))
		return d.title.split("\n", 1)[0]?.trim() ?? null;
	const commitMessage = d.title
		?.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	const commitHash = d.description?.replace(/^Commit:\s*/i, "").trim();

	if (!commitMessage || !commitHash) {
		return null;
	}

	return `${commitMessage} (${commitHash.slice(0, 7)})`;
}
