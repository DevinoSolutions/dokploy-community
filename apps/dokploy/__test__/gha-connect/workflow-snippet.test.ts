import {
	buildWorkflowSnippet,
	githubNewFileUrl,
	WORKFLOW_PATH,
} from "@dokploy/server/services/gha-connect/workflow-snippet";
import { describe, expect, it } from "vitest";

const base = {
	branch: "dev",
	environment: "development",
	serviceKey: "web",
};

describe("buildWorkflowSnippet, build mode", () => {
	const build = {
		...base,
		mode: "build" as const,
		dockerfile: "apps/web/Dockerfile",
		context: ".",
	};

	it("renders the whole workflow the dashboard offers as .github/workflows/dokploy.yml", () => {
		const result = buildWorkflowSnippet(build);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.kind).toBe("file");
		expect(result.path).toBe(WORKFLOW_PATH);
		expect(result.yaml).toContain("branches: [dev]");
		expect(result.yaml).toContain("environment: development");
		expect(result.yaml).toContain("uses: DevinoSolutions/dokploy-release@v1");
		expect(result.yaml).toContain('environments: "dev=development"');
		expect(result.yaml).toContain("service: web");
		expect(result.yaml).toContain("dockerfile: apps/web/Dockerfile");
		expect(result.yaml).toContain("workflow_dispatch:");
		expect(result.yaml).not.toContain("context:");
		expect(result.yaml).toContain("persist-credentials: false");
		expect(result.yaml.endsWith("\n")).toBe(true);
	});

	it("asks for the least: contents read, packages write, deployments write, actions read", () => {
		const result = buildWorkflowSnippet(build);
		if (!result.ok) throw new Error("unreachable");
		const permissions = result.yaml.split("jobs:")[0] ?? "";
		for (const line of [
			"contents: read",
			"packages: write",
			"deployments: write",
			"actions: read",
		]) {
			expect(permissions).toContain(line);
		}
		expect(result.yaml).not.toMatch(/DOKPLOY_(API_KEY|URL)|secrets\./);
	});

	it("names a build directory only when it is not the repository root", () => {
		const result = buildWorkflowSnippet({ ...build, context: "apps/web" });
		if (!result.ok) throw new Error("unreachable");
		expect(result.yaml).toContain("context: apps/web");
	});
});

describe("buildWorkflowSnippet, existing mode", () => {
	const existing = {
		...base,
		mode: "existing" as const,
		buildJob: "compose",
		imageOutput: "image",
	};

	it("renders one job that publishes the release from the build job's output", () => {
		const result = buildWorkflowSnippet(existing);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.kind).toBe("job");
		expect(result.path).toBeNull();
		expect(result.yaml).toContain("needs: compose");
		expect(result.yaml).toContain("if: github.ref == 'refs/heads/dev'");
		expect(result.yaml).toContain("environment: development");
		expect(result.yaml).toContain(
			"existing-image: ${{ needs.compose.outputs.image }}",
		);
		expect(result.yaml).not.toMatch(/DOKPLOY_(API_KEY|URL)/);
	});
});

describe("buildWorkflowSnippet refuses what could change the workflow", () => {
	it.each([
		["branch", { branch: "dev; rm -rf /" }],
		["branch with ..", { branch: "a/../b" }],
		["environment", { environment: "prod uction" }],
		["service key", { serviceKey: "Web" }],
		["action ref", { actionRef: "v1 # x" }],
	])("a %s", (_name, patch) => {
		const result = buildWorkflowSnippet({
			...base,
			...patch,
			mode: "build",
			dockerfile: "Dockerfile",
			context: ".",
		});
		expect(result.ok).toBe(false);
	});

	it.each([
		["dockerfile", { dockerfile: "Dockerfile\nrun: x" }],
		["context", { context: "../outside" }],
	])("a %s", (_name, patch) => {
		expect(
			buildWorkflowSnippet({
				...base,
				mode: "build",
				dockerfile: "Dockerfile",
				context: ".",
				...patch,
			}).ok,
		).toBe(false);
	});

	it.each([
		["build job", { buildJob: "1bad" }],
		["output", { imageOutput: "a b" }],
	])("a %s", (_name, patch) => {
		expect(
			buildWorkflowSnippet({
				...base,
				mode: "existing",
				buildJob: "build",
				imageOutput: "image",
				...patch,
			}).ok,
		).toBe(false);
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
