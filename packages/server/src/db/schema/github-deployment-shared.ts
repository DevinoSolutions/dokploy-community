import { z } from "zod";

/**
 * Constants and input validators shared by github-deployment.ts and
 * gha-connection.ts. A leaf module (only zod): the schema files import each
 * other through account.ts and the schema index, so a module-level z.enum()
 * over a constant from a file still loading would see undefined.
 */

export const GITHUB_WATCH_SERVICE_TYPES = ["application", "compose"] as const;
export type GithubWatchServiceType =
	(typeof GITHUB_WATCH_SERVICE_TYPES)[number];

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** "." and ".." match GITHUB_NAME, and encodeURIComponent leaves dots alone: /repos/../x would walk out of /repos. */
const isDotSegment = (name: string) => /^\.{1,2}$/.test(name);

export const apiGithubOwnerRepo = z.object({
	owner: z
		.string()
		.trim()
		.regex(GITHUB_NAME, "Not a valid GitHub owner")
		.refine((name) => !isDotSegment(name), "Not a valid GitHub owner")
		.describe("GitHub user or organization that owns the repository."),
	repo: z
		.string()
		.trim()
		.regex(GITHUB_NAME, "Not a valid GitHub repository name")
		.refine((name) => !isDotSegment(name), "Not a valid GitHub repository name")
		.describe("GitHub repository name, without the owner."),
});

export const apiGithubDeploymentEnvironment = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.describe(
		'GitHub Deployments environment name to follow (default "production").',
	);
