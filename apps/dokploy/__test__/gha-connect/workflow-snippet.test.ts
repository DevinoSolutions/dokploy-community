import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildWorkflowSnippet,
	githubNewFileUrl,
	WORKFLOW_PATH,
} from "@dokploy/server/services/gha-connect/workflow-snippet";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const base = {
	branch: "dev",
	environment: "development",
	serviceKey: "web",
};

const build = {
	...base,
	mode: "build" as const,
	repository: "Acme/Shop",
	dockerfile: "apps/web/Dockerfile",
	context: ".",
};

const existing = {
	...base,
	mode: "existing" as const,
	buildJob: "compose",
	imageOutput: "image",
};

/** The action as published (vendored at efafd804): the only truth about which inputs a step may send. */
const action = parse(
	readFileSync(
		resolve(__dirname, "action-fixture/dokploy-release-action.yml"),
		"utf8",
	),
) as {
	inputs: Record<string, { description: string; required?: boolean }>;
};
const declared = Object.keys(action.inputs);
const reserved = declared.filter((name) =>
	action.inputs[name]?.description.startsWith("Reserved"),
);

type Step = { uses?: string; with?: Record<string, unknown> };
type Job = {
	needs?: string;
	if?: string;
	environment?: string;
	permissions?: Record<string, string>;
	outputs?: Record<string, string>;
	steps?: Step[];
};
type Workflow = {
	on?: { push?: { branches?: unknown[] } };
	jobs: Record<string, Job>;
	permissions?: object;
};

const releaseSteps = (jobs: Record<string, Job>) =>
	Object.values(jobs)
		.flatMap((job) => job.steps ?? [])
		.filter((step) =>
			step.uses?.startsWith("DevinoSolutions/dokploy-release@"),
		);

const generated = () => {
	const whole = buildWorkflowSnippet(build);
	const job = buildWorkflowSnippet(existing);
	if (!whole.ok || !job.ok) throw new Error("unreachable");
	return {
		whole: parse(whole.yaml) as Workflow,
		// The job text is indented to sit under `jobs:`; parse it as that.
		job: parse(`jobs:\n${job.yaml}`) as Workflow,
		wholeYaml: whole.yaml,
		jobYaml: job.yaml,
	};
};

describe("what the generated text sends to dokploy-release", () => {
	it("sends only inputs the action declares, none of them reserved", () => {
		const { whole, job } = generated();
		for (const workflow of [whole, job]) {
			const steps = releaseSteps(workflow.jobs);
			expect(steps).toHaveLength(1);
			for (const key of Object.keys(steps[0]?.with ?? {})) {
				expect(declared, `input ${key}`).toContain(key);
				expect(reserved, `input ${key} is reserved in v1`).not.toContain(key);
			}
		}
	});

	it("sends every required input of the action", () => {
		const { whole, job } = generated();
		const required = declared.filter((name) => action.inputs[name]?.required);
		expect(required.sort()).toEqual(["environment", "existing-image"]);
		for (const workflow of [whole, job]) {
			const sent = Object.keys(releaseSteps(workflow.jobs)[0]?.with ?? {});
			for (const name of required) expect(sent).toContain(name);
			// A service is named with `service` or `services`, one of them.
			expect(sent).toContain("service");
		}
	});

	it("takes the image from a job output of the same run, never builds in the action", () => {
		const { whole, job } = generated();
		expect(releaseSteps(whole.jobs)[0]?.with?.["existing-image"]).toBe(
			"${{ needs.build.outputs.image }}",
		);
		expect(releaseSteps(job.jobs)[0]?.with?.["existing-image"]).toBe(
			"${{ needs.compose.outputs.image }}",
		);
	});
});

describe("buildWorkflowSnippet, build mode (the whole workflow)", () => {
	it("is .github/workflows/dokploy.yml with a build job and a release job after it", () => {
		const result = buildWorkflowSnippet(build);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.kind).toBe("file");
		expect(result.path).toBe(WORKFLOW_PATH);
		const { whole } = generated();
		expect(Object.keys(whole.jobs)).toEqual(["build", "release"]);
		expect(whole.jobs.release?.needs).toBe("build");
		expect(whole.jobs.release?.environment).toBe("development");
		expect(result.yaml).toContain("branches: ['dev']");
		expect(result.yaml).toContain("workflow_dispatch:");
		expect(result.yaml.endsWith("\n")).toBe(true);
	});

	it("builds with buildx, pushes to GHCR with the run's token, and caches in GitHub's cache", () => {
		const { whole, wholeYaml } = generated();
		const steps = whole.jobs.build?.steps ?? [];
		const uses = steps.map((step) => step.uses?.split("@")[0]);
		expect(uses).toEqual([
			"actions/checkout",
			"docker/login-action",
			"docker/setup-buildx-action",
			"docker/build-push-action",
		]);
		const login = steps[1]?.with;
		expect(login).toMatchObject({
			registry: "ghcr.io",
			password: "${{ secrets.GITHUB_TOKEN }}",
		});
		const push = steps[3]?.with;
		expect(push).toMatchObject({
			context: ".",
			file: "apps/web/Dockerfile",
			push: true,
			// Scoped to the service key so two services of one repository do not share (and evict) one cache.
			"cache-from": "type=gha,scope=web",
			"cache-to": "type=gha,mode=max,scope=web",
		});
		expect(push?.tags).toBe("ghcr.io/acme/shop/web:${{ github.sha }}");
		expect(wholeYaml).not.toMatch(
			/DOKPLOY_(API_KEY|URL)|secrets\.(?!GITHUB_TOKEN)/,
		);
	});

	it("names the image by the digest the push returns, in the namespace the connection allows", () => {
		const { whole } = generated();
		expect(whole.jobs.build?.outputs?.image).toBe(
			"ghcr.io/acme/shop/web@${{ steps.build.outputs.digest }}",
		);
	});

	it("asks for the least: contents read, packages write for the build, deployments write for the release", () => {
		const { whole } = generated();
		expect(whole.permissions).toEqual({ contents: "read" });
		expect(whole.jobs.build?.permissions).toEqual({
			contents: "read",
			packages: "write",
		});
		expect(whole.jobs.release?.permissions).toEqual({
			contents: "read",
			deployments: "write",
		});
	});

	it("names a build directory as written, and delivery when it is push", () => {
		const result = buildWorkflowSnippet({
			...build,
			context: "apps/web",
			delivery: "push",
		});
		if (!result.ok) throw new Error("unreachable");
		const workflow = parse(result.yaml) as Workflow;
		expect(workflow.jobs.build?.steps?.[3]?.with?.context).toBe("apps/web");
		expect(releaseSteps(workflow.jobs)[0]?.with?.delivery).toBe("push");
	});
});

describe("buildWorkflowSnippet, build mode: what a pull request or another branch can do", () => {
	it("publishes a release only from the tracked branch", () => {
		const { whole, wholeYaml } = generated();
		expect(whole.jobs.release?.if).toBe("github.ref == 'refs/heads/dev'");
		// The build job has no such condition: a run elsewhere may build, never publish.
		expect(whole.jobs.build?.if).toBeUndefined();
		expect(wholeYaml).toContain("    if: github.ref == 'refs/heads/dev'");
	});

	it("follows the tracked branch it is generated for", () => {
		const result = buildWorkflowSnippet({ ...build, branch: "release/2" });
		if (!result.ok) throw new Error("unreachable");
		const workflow = parse(result.yaml) as Workflow;
		expect(workflow.jobs.release?.if).toBe(
			"github.ref == 'refs/heads/release/2'",
		);
		expect(result.yaml).toContain("branches: ['release/2']");
	});

	it("scopes the build cache to the service key", () => {
		const result = buildWorkflowSnippet({ ...build, serviceKey: "api.v2" });
		if (!result.ok) throw new Error("unreachable");
		const workflow = parse(result.yaml) as Workflow;
		const push = workflow.jobs.build?.steps?.[3]?.with;
		expect(push?.["cache-from"]).toBe("type=gha,scope=api.v2");
		expect(push?.["cache-to"]).toBe("type=gha,mode=max,scope=api.v2");
	});
});

describe("the image the whole workflow pushes", () => {
	it("is the repository the service already runs, when it is inside ghcr.io/<owner>/<repo>/", () => {
		const result = buildWorkflowSnippet({
			...build,
			image: "ghcr.io/acme/shop/storefront",
		});
		if (!result.ok) throw new Error("unreachable");
		const workflow = parse(result.yaml) as Workflow;
		expect(workflow.jobs.build?.outputs?.image).toBe(
			"ghcr.io/acme/shop/storefront@${{ steps.build.outputs.digest }}",
		);
		expect(workflow.jobs.build?.steps?.[3]?.with?.tags).toBe(
			"ghcr.io/acme/shop/storefront:${{ github.sha }}",
		);
	});

	it("is ghcr.io/<owner>/<repo>/<service key> when the service runs nothing of its own", () => {
		const result = buildWorkflowSnippet(build);
		if (!result.ok) throw new Error("unreachable");
		expect(result.yaml).toContain("ghcr.io/acme/shop/web@");
	});

	it.each([
		["another owner", "ghcr.io/org/app"],
		["another repository", "ghcr.io/acme/other/web"],
		["the namespace itself", "ghcr.io/acme/shop/"],
		["a preview image", "ghcr.io/acme/shop/preview/pr-1"],
		["another registry", "localhost:5000/registry.devino.ca/shop/web"],
		["a path escape", "ghcr.io/acme/shop/../x"],
		["text a workflow cannot take", "ghcr.io/acme/shop/web; rm -rf /"],
	])("refuses %s", (_name, image) => {
		expect(buildWorkflowSnippet({ ...build, image }).ok).toBe(false);
	});
});

describe("the tracked branch is a string in the workflow", () => {
	it("stays one when it looks like a number", () => {
		const result = buildWorkflowSnippet({ ...build, branch: "1.0" });
		if (!result.ok) throw new Error("unreachable");
		expect(result.yaml).toContain("branches: ['1.0']");
		const workflow = parse(result.yaml) as Workflow;
		expect(workflow.on?.push?.branches).toEqual(["1.0"]);
		expect(workflow.jobs.release?.if).toBe("github.ref == 'refs/heads/1.0'");
	});
});

describe("the private package limit of phase 1", () => {
	it.each([
		["the whole workflow", () => buildWorkflowSnippet(build)],
		["the job", () => buildWorkflowSnippet(existing)],
	])("is written into %s as a comment", (_name, make) => {
		const result = make();
		if (!result.ok) throw new Error("unreachable");
		const comments = result.yaml
			.split("\n")
			.filter((line) => line.trim().startsWith("#"))
			.join(" ");
		expect(comments).toMatch(/private by default|private package/i);
		expect(comments).toMatch(/make it public/);
		expect(comments).toMatch(/registry Dokploy can read/);
	});

	it("does not change what the workflow does: comments only", () => {
		const { whole, job } = generated();
		expect(Object.keys(whole.jobs)).toEqual(["build", "release"]);
		expect(Object.keys(job.jobs)).toEqual(["dokploy-release"]);
	});
});

describe("buildWorkflowSnippet, existing mode (one job)", () => {
	it("renders one job that publishes the release from the build job's output", () => {
		const result = buildWorkflowSnippet(existing);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.kind).toBe("job");
		expect(result.path).toBeNull();
		const { job } = generated();
		const release = job.jobs["dokploy-release"];
		expect(release?.needs).toBe("compose");
		expect(release?.environment).toBe("development");
		expect(release?.permissions).toEqual({
			contents: "read",
			deployments: "write",
		});
		expect(release?.if).toBe("github.ref == 'refs/heads/dev'");
		expect(result.yaml).toContain("    if: github.ref == 'refs/heads/dev'");
		expect(result.yaml).not.toMatch(/DOKPLOY_(API_KEY|URL)/);
	});

	it("follows the tracked branch it is generated for, like the whole workflow", () => {
		const result = buildWorkflowSnippet({ ...existing, branch: "release/2" });
		if (!result.ok) throw new Error("unreachable");
		const workflow = parse(`jobs:
${result.yaml}`) as Workflow;
		expect(workflow.jobs["dokploy-release"]?.if).toBe(
			"github.ref == 'refs/heads/release/2'",
		);
	});
});

describe("buildWorkflowSnippet refuses what could change the workflow", () => {
	it.each([
		["branch", { branch: "dev; rm -rf /" }],
		["branch with ..", { branch: "a/../b" }],
		["environment", { environment: "prod uction" }],
		["service key", { serviceKey: "Web" }],
		["action ref", { actionRef: "v1 # x" }],
		["repository", { repository: "acme" }],
		["dockerfile", { dockerfile: "Dockerfile\nrun: x" }],
		["context", { context: "../outside" }],
	])("a %s", (_name, patch) => {
		expect(buildWorkflowSnippet({ ...build, ...patch }).ok).toBe(false);
	});

	it.each([
		["build job", { buildJob: "1bad" }],
		["output", { imageOutput: "a b" }],
	])("a %s", (_name, patch) => {
		expect(buildWorkflowSnippet({ ...existing, ...patch }).ok).toBe(false);
	});
});

describe("githubNewFileUrl", () => {
	it("opens GitHub's new-file page with the file filled in, on the tracked branch", () => {
		const url = githubNewFileUrl({
			repository: "acme/shop",
			branch: "dev",
			path: WORKFLOW_PATH,
			yaml: "name: Dokploy\n",
		});
		expect(url).toBe(
			"https://github.com/acme/shop/new/dev?filename=.github%2Fworkflows%2Fdokploy.yml&value=name%3A%20Dokploy%0A",
		);
	});

	it("gives nothing for a repository or branch that is not one", () => {
		expect(
			githubNewFileUrl({
				repository: "acme",
				branch: "dev",
				path: "a",
				yaml: "",
			}),
		).toBeNull();
		expect(
			githubNewFileUrl({
				repository: "acme/shop",
				branch: "dev?x=1",
				path: "a",
				yaml: "",
			}),
		).toBeNull();
	});

	it("gives nothing for a file too long for an address", () => {
		expect(
			githubNewFileUrl({
				repository: "acme/shop",
				branch: "dev",
				path: "a",
				yaml: "x".repeat(8000),
			}),
		).toBeNull();
	});
});
