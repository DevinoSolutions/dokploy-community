/**
 * The text the "Copy the file" step of the GitHub Actions provider offers (T-13879). Dokploy never edits a
 * repository: it shows the file, the user copies it (or opens GitHub's own "new file" page with it filled in).
 * Pure.
 *
 * Two shapes:
 * - `build`: a whole workflow, `.github/workflows/dokploy.yml`, that builds the image from a Dockerfile and
 *   publishes the release.
 * - `existing`: one job for the user's own workflow. It runs after their build job and publishes the release from
 *   an output of that job in the same run.
 *
 * Neither names a Dokploy address or key: Dokploy asks GitHub for releases, GitHub never calls Dokploy.
 */

export const WORKFLOW_PATH = ".github/workflows/dokploy.yml";
export const ACTION_REF = "v1";

export type SnippetInput = {
	/** Branch the release runs on (the tracked branch). */
	branch: string;
	/** GitHub Environment of the build (its deployment branch policy allows only `branch`). */
	environment: string;
	/** Service key: the Deployment task is `dokploy:<key>`. */
	serviceKey: string;
	/** Released tag of the action. */
	actionRef?: string;
} & (
	| {
			mode: "build";
			dockerfile: string;
			/** Build context directory; `.` is the repository root. */
			context: string;
	  }
	| {
			mode: "existing";
			/** Id of the job in the user's workflow that builds and pushes the image. */
			buildJob: string;
			/** Name of that job's output holding `repository@sha256:<digest>`. */
			imageOutput: string;
	  }
);

export type SnippetResult =
	| {
			ok: true;
			kind: "file" | "job";
			/** The file to create, or the file to add the job to (the user names that one). */
			path: string | null;
			yaml: string;
	  }
	| { ok: false; error: string };

const SAFE = /^[A-Za-z0-9._/-]+$/;
const JOB = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const bad = (error: string): SnippetResult => ({ ok: false, error });

const common = (input: SnippetInput): string | null => {
	if (!SAFE.test(input.branch) || input.branch.includes("..")) {
		return "The branch name has characters a workflow cannot take.";
	}
	if (!SAFE.test(input.environment)) {
		return "The environment name has characters a workflow cannot take.";
	}
	if (!KEY.test(input.serviceKey)) {
		return "The service key must be lowercase letters, digits, dots, dashes or underscores.";
	}
	if (input.actionRef !== undefined && !SAFE.test(input.actionRef)) {
		return "The action reference is not valid.";
	}
	return null;
};

export const buildWorkflowSnippet = (input: SnippetInput): SnippetResult => {
	const problem = common(input);
	if (problem) return bad(problem);
	const ref = input.actionRef ?? ACTION_REF;

	if (input.mode === "existing") {
		if (!JOB.test(input.buildJob)) {
			return bad("The build job id is not a valid job id.");
		}
		if (!JOB.test(input.imageOutput)) {
			return bad("The output name is not a valid output name.");
		}
		const yaml = [
			"  # Added for Dokploy: publishes the release. It needs no Dokploy address and no API key.",
			"  dokploy-release:",
			`    needs: ${input.buildJob}`,
			`    if: github.ref == 'refs/heads/${input.branch}'`,
			"    runs-on: ubuntu-latest",
			`    environment: ${input.environment}`,
			"    permissions:",
			"      contents: read",
			"      deployments: write",
			"      actions: read",
			"    steps:",
			`      - uses: DevinoSolutions/dokploy-release@${ref}`,
			"        with:",
			`          environments: "${input.branch}=${input.environment}"`,
			`          service: ${input.serviceKey}`,
			`          existing-image: \${{ needs.${input.buildJob}.outputs.${input.imageOutput} }}`,
			"",
		].join("\n");
		return { ok: true, kind: "job", path: null, yaml };
	}

	if (!SAFE.test(input.dockerfile) || input.dockerfile.includes("..")) {
		return bad("The Dockerfile path has characters a workflow cannot take.");
	}
	if (!SAFE.test(input.context) || input.context.includes("..")) {
		return bad("The build context has characters a workflow cannot take.");
	}
	const withLines = [
		`          environments: "${input.branch}=${input.environment}"`,
		`          service: ${input.serviceKey}`,
		`          dockerfile: ${input.dockerfile}`,
		...(input.context !== "." ? [`          context: ${input.context}`] : []),
	];
	const yaml = [
		"name: Dokploy",
		"on:",
		"  push:",
		`    branches: [${input.branch}]`,
		"  workflow_dispatch:",
		"concurrency:",
		"  group: dokploy-${{ github.workflow }}-${{ github.ref }}",
		"  cancel-in-progress: false",
		"permissions:",
		"  contents: read",
		"  packages: write",
		"  deployments: write",
		"  actions: read",
		"jobs:",
		"  release:",
		"    runs-on: ubuntu-latest",
		`    environment: ${input.environment}`,
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          persist-credentials: false",
		`      - uses: DevinoSolutions/dokploy-release@${ref}`,
		"        with:",
		...withLines,
		"",
	].join("\n");
	return { ok: true, kind: "file", path: WORKFLOW_PATH, yaml };
};

/**
 * GitHub's own "create new file" page with the file filled in. The user reviews it there and commits it to the
 * branch or to a new one with a pull request, with their own GitHub login: Dokploy needs no write access.
 */
export const githubNewFileUrl = (input: {
	repository: string;
	branch: string;
	path: string;
	yaml: string;
}): string | null => {
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.repository)) return null;
	if (!SAFE.test(input.branch) || input.branch.includes("..")) return null;
	const url = `https://github.com/${input.repository}/new/${input.branch}?filename=${encodeURIComponent(input.path)}&value=${encodeURIComponent(input.yaml)}`;
	// Browsers and GitHub refuse very long addresses; the file is a page long, so this never trips on a real one.
	return url.length > 7000 ? null : url;
};
