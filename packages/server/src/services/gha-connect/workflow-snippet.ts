/**
 * The text the "Copy the file" step of the GitHub Actions provider offers (T-13879). Dokploy never edits a
 * repository: it shows the file, the user copies it (or opens GitHub's own "new file" page with it filled in).
 * Pure.
 *
 * Two shapes:
 * - `build`: a whole workflow, `.github/workflows/dokploy.yml`: a `build` job that builds the image from a Dockerfile
 *   and pushes it to GHCR, then a `release` job that publishes the release for it.
 * - `existing`: one job for the user's own workflow. It runs after their build job and publishes the release from
 *   an output of that job in the same run.
 *
 * Neither names a Dokploy address or key: Dokploy asks GitHub for releases, GitHub never calls Dokploy.
 *
 * The action (DevinoSolutions/dokploy-release@v1) takes the image from the user's own job (`existing-image`) and
 * publishes it. Its inputs for building (`dockerfile`, `context`, `environments`, ...) are reserved in v1 and refused,
 * so only the inputs it declares and honours are written here: `service`, `environment`, `delivery`, `existing-image`.
 */

export const WORKFLOW_PATH = ".github/workflows/dokploy.yml";
export const ACTION_REF = "v1";

export type SnippetInput = {
	/** Branch the release runs on (the tracked branch). */
	branch: string;
	/** GitHub Environment of the release (its deployment branch policy allows only `branch`). */
	environment: string;
	/** Service key: the Deployment task is `dokploy:<key>`. */
	serviceKey: string;
	/** `pull`: Dokploy deploys the release. `push`: the workflow still deploys; Dokploy only verifies. */
	delivery?: "pull" | "push";
	/** Released tag of the action. */
	actionRef?: string;
} & (
	| {
			mode: "build";
			/** owner/name of the repository: the image is pushed to ghcr.io/<owner>/<name>/<key>. */
			repository: string;
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
			/** The file to create, or null for a job to add to a file the user names. */
			path: string | null;
			yaml: string;
	  }
	| { ok: false; error: string };

const SAFE = /^[A-Za-z0-9._/-]+$/;
const JOB = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

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

/**
 * Phase 1 limit, written into the generated text where the user will read it: Dokploy pulls the image without a
 * GitHub login, so a GHCR package that is private is not pullable until it is made public (or the image is mirrored
 * to a registry Dokploy can read).
 */
const PRIVATE_PACKAGE_NOTE = [
	"Dokploy pulls the image without a GitHub login. A GHCR package is private by default: make it public",
	"(Package settings, Change visibility) or mirror the image to a registry Dokploy can read. Until then a",
	"private package cannot be pulled.",
];

/** A GitHub Actions expression, written without a template-literal clash. */
const expr = (inner: string) => `\${{ ${inner} }}`;

/** The step of the action, with only the inputs it declares and honours in v1. */
const releaseStep = (
	input: SnippetInput,
	ref: string,
	existingImage: string,
	indent: string,
): string[] => [
	`${indent}- uses: DevinoSolutions/dokploy-release@${ref}`,
	`${indent}  with:`,
	`${indent}    environment: ${input.environment}`,
	`${indent}    service: ${input.serviceKey}`,
	`${indent}    delivery: ${input.delivery ?? "pull"}`,
	`${indent}    existing-image: ${existingImage}`,
];

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
			...PRIVATE_PACKAGE_NOTE.map((line) => `  # ${line}`),
			"  dokploy-release:",
			`    needs: ${input.buildJob}`,
			`    if: github.ref == 'refs/heads/${input.branch}'`,
			"    runs-on: ubuntu-latest",
			`    environment: ${input.environment}`,
			"    permissions:",
			"      contents: read",
			"      deployments: write",
			"    steps:",
			...releaseStep(
				input,
				ref,
				expr(`needs.${input.buildJob}.outputs.${input.imageOutput}`),
				"      ",
			),
			"",
		].join("\n");
		return { ok: true, kind: "job", path: null, yaml };
	}

	if (!REPOSITORY.test(input.repository)) {
		return bad("Enter the repository as owner/name.");
	}
	if (!SAFE.test(input.dockerfile) || input.dockerfile.includes("..")) {
		return bad("The Dockerfile path has characters a workflow cannot take.");
	}
	if (!SAFE.test(input.context) || input.context.includes("..")) {
		return bad("The build context has characters a workflow cannot take.");
	}
	// GHCR names are lower case. The digest comes from the push, so the release names the image exactly.
	const image = `ghcr.io/${input.repository.toLowerCase()}/${input.serviceKey}`;
	const yaml = [
		"name: Dokploy",
		"on:",
		"  push:",
		`    branches: [${input.branch}]`,
		"  workflow_dispatch:",
		"concurrency:",
		`  group: dokploy-${expr("github.workflow")}-${expr("github.ref")}`,
		"  cancel-in-progress: false",
		"permissions:",
		"  contents: read",
		"jobs:",
		"  build:",
		...PRIVATE_PACKAGE_NOTE.map((line) => `    # ${line}`),
		"    runs-on: ubuntu-latest",
		"    permissions:",
		"      contents: read",
		"      packages: write",
		"    outputs:",
		`      image: ${image}@${expr("steps.build.outputs.digest")}`,
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          persist-credentials: false",
		"      - uses: docker/login-action@v3",
		"        with:",
		"          registry: ghcr.io",
		`          username: ${expr("github.actor")}`,
		`          password: ${expr("secrets.GITHUB_TOKEN")}`,
		"      - uses: docker/setup-buildx-action@v3",
		"      - id: build",
		"        uses: docker/build-push-action@v6",
		"        with:",
		`          context: ${input.context}`,
		`          file: ${input.dockerfile}`,
		"          push: true",
		`          tags: ${image}:${expr("github.sha")}`,
		`          cache-from: type=gha,scope=${input.serviceKey}`,
		`          cache-to: type=gha,mode=max,scope=${input.serviceKey}`,
		"  release:",
		"    needs: build",
		`    if: github.ref == 'refs/heads/${input.branch}'`,
		"    runs-on: ubuntu-latest",
		`    environment: ${input.environment}`,
		"    permissions:",
		"      contents: read",
		"      deployments: write",
		"    steps:",
		...releaseStep(input, ref, expr("needs.build.outputs.image"), "      "),
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
	if (!REPOSITORY.test(input.repository)) return null;
	if (!SAFE.test(input.branch) || input.branch.includes("..")) return null;
	const url = `https://github.com/${input.repository}/new/${input.branch}?filename=${encodeURIComponent(input.path)}&value=${encodeURIComponent(input.yaml)}`;
	// Browsers and GitHub refuse very long addresses; the file is a page long, so this never trips on a real one.
	return url.length > 7000 ? null : url;
};
