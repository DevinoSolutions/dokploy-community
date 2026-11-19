/**
 * The title protocol of a deployment row that GitHub Actions or a GitHub deployment started.
 *
 * A title is the only link between a row and the GitHub deployment it belongs to (the poller finds the row, and the
 * registry retry check finds the release, by the handle at the end of the title), so the pieces that build it, match
 * it in SQL and parse it in memory live together here: a change to one is a change to all. The shape is
 * `GHA [<environment>] [<sha8>] [deployment #<GitHub deployment id>]`.
 *
 * Pure: no database import, so the dashboard-safe modules and the SQL builders can both use it.
 */

/** The word every such title starts with. */
export const GHA_TITLE_TOKEN = "GHA";

/** What a title starts with: the word and the space after it. */
export const GHA_TITLE_PREFIX = `${GHA_TITLE_TOKEN} `;

/** SQL LIKE pattern: any title that starts with `GHA `. */
export const GHA_TITLE_LIKE = `${GHA_TITLE_PREFIX}%`;

/**
 * The end of the Dokploy deployment title a GitHub deployment starts. It is the handle the poller finds that
 * deployment by, whatever the rest of the title says, so it must stay unique per GitHub deployment id.
 */
export const githubDeploymentHandle = (githubDeploymentId: number) =>
	`[deployment #${githubDeploymentId}]`;

/**
 * SQL LIKE pattern: a `GHA ` title that ENDS with exactly this handle (no trailing text, not even a space). The
 * handle of #120 does not match a title that ends in the handle of #1120: the bracket closes it.
 */
export const ghaTitleEndingWithHandleLike = (handle: string) =>
	`${GHA_TITLE_PREFIX}%${handle}`;

/**
 * SQL LIKE pattern: any title that ends with a handle of any GitHub deployment, one space after the text before it.
 * These are the rows the "Deploy from GitHub Deployments" poller started itself, not a second deployer.
 */
export const GITHUB_DEPLOYMENT_HANDLE_LIKE = "% [deployment #%]";

/** Whether a title starts with `GHA `. */
export const isGhaTitle = (title: string | null | undefined): title is string =>
	typeof title === "string" && title.startsWith(GHA_TITLE_PREFIX);

/**
 * Whether a title is a `GHA ` title that ends with exactly this handle (the in-memory twin of
 * `ghaTitleEndingWithHandleLike`).
 */
export const isGhaTitleEndingWithHandle = (
	title: string | null | undefined,
	handle: string,
): boolean => isGhaTitle(title) && title.endsWith(handle);

const HANDLE_AT_END = /\[deployment #(\d+)\]\s*$/;

/**
 * The GitHub deployment id a title ends with, or null when it ends with no handle. Trailing whitespace is allowed
 * here (unlike `ghaTitleEndingWithHandleLike`), and the title need not start with `GHA `: combine it with
 * `isGhaTitle` when it must.
 */
export const parseGithubDeploymentHandle = (
	title: string | null | undefined,
): number | null => {
	const match = HANDLE_AT_END.exec(title ?? "");
	return match?.[1] ? Number(match[1]) : null;
};
