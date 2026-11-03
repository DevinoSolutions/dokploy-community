import {
	compareCommits,
	createActionsApi,
	downloadArtifactZip,
	getBranchHead,
	getEnvironmentPolicy,
	getFileText,
	getRepositoryById,
	getRunAttempt,
	listRunArtifacts,
	listWorkflowRuns,
} from "@dokploy/server/services/gha-connect/actions-api";
import { describe, expect, it } from "vitest";
import { routedFetch } from "./gha-helpers";

const NOW = 1_700_000_000_000;
const REPO = { owner: "DevinoSolutions", repo: "voicelabs" };
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const deps = (routes: Parameters<typeof routedFetch>[0]) => {
	const { fetch, calls } = routedFetch(routes);
	return { deps: { fetch, now: () => NOW }, calls };
};

describe("failure mapping (shared by every call)", () => {
	it.each([
		[401, { kind: "unauthorized" }],
		[404, { kind: "not-found" }],
		[500, { kind: "error", status: 500 }],
		[304, { kind: "not-modified" }],
	])("maps HTTP %s", async (status, expected) => {
		const { deps: d } = deps([["/branches/", { status }]]);
		expect(await getBranchHead(d, "t", REPO, "main")).toEqual(expected);
	});

	it("tells a rate limit from a plain refusal", async () => {
		const limited = deps([
			[
				"/branches/",
				{ status: 403, headers: { "retry-after": "30" }, text: "rate limit" },
			],
		]);
		expect(await getBranchHead(limited.deps, "t", REPO, "main")).toEqual({
			kind: "rate-limited",
			retryAt: NOW + 30_000,
		});
		const refused = deps([
			["/branches/", { status: 403, text: "Resource not accessible" }],
		]);
		expect(await getBranchHead(refused.deps, "t", REPO, "main")).toMatchObject({
			kind: "forbidden",
		});
	});

	it("reports an unreadable body as an error, and a network failure as status 0", async () => {
		const odd = deps([["/branches/", { json: { nope: true } }]]);
		expect(await getBranchHead(odd.deps, "t", REPO, "main")).toMatchObject({
			kind: "error",
		});
		const down: ReturnType<typeof deps> = {
			deps: {
				fetch: async () => {
					throw new Error("offline");
				},
				now: () => NOW,
			},
			calls: [],
		};
		expect(await getBranchHead(down.deps, "t", REPO, "main")).toEqual({
			kind: "error",
			status: 0,
		});
	});

	it("never calls GitHub for a dot segment or an odd repository name", async () => {
		const { deps: d, calls } = deps([["/", { json: {} }]]);
		expect(
			await getBranchHead(d, "t", { owner: "..", repo: "x" }, "main"),
		).toEqual({
			kind: "not-found",
		});
		expect(
			await getBranchHead(d, "t", { owner: "a", repo: "b/c" }, "main"),
		).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});

	it("sends the token only in the Authorization header", async () => {
		const { deps: d, calls } = deps([
			["/branches/", { json: { commit: { sha: SHA } } }],
		]);
		await getBranchHead(d, "gho_secret", REPO, "main");
		expect(calls[0]?.headers.Authorization).toBe("Bearer gho_secret");
		expect(calls[0]?.url).not.toContain("gho_secret");
	});
});

describe("repository and branch", () => {
	it("reads a repository by its immutable id", async () => {
		const { deps: d, calls } = deps([
			[
				"/repositories/42",
				{
					json: {
						id: 42,
						name: "voicelabs",
						full_name: "DevinoSolutions/voicelabs",
						owner: { login: "DevinoSolutions" },
						default_branch: "main",
						private: true,
					},
					headers: { etag: 'W/"x"' },
				},
			],
		]);
		expect(await getRepositoryById(d, "t", 42)).toEqual({
			kind: "ok",
			etag: 'W/"x"',
			value: {
				id: 42,
				owner: "DevinoSolutions",
				name: "voicelabs",
				fullName: "DevinoSolutions/voicelabs",
				defaultBranch: "main",
				isPrivate: true,
			},
		});
		expect(calls[0]?.url).toBe("https://api.github.com/repositories/42");
	});

	it("sends If-None-Match when given an etag", async () => {
		const { deps: d, calls } = deps([["/repositories/42", { status: 304 }]]);
		expect(await getRepositoryById(d, "t", 42, 'W/"x"')).toEqual({
			kind: "not-modified",
		});
		expect(calls[0]?.headers["If-None-Match"]).toBe('W/"x"');
	});

	it("encodes a branch name with a slash", async () => {
		const { deps: d, calls } = deps([
			["/branches/", { json: { commit: { sha: SHA } } }],
		]);
		expect(await getBranchHead(d, "t", REPO, "release/1.x")).toMatchObject({
			kind: "ok",
			value: { sha: SHA },
		});
		expect(calls[0]?.url).toContain("/branches/release%2F1.x");
	});

	it("refuses a branch head that is not a 40 character sha", async () => {
		const { deps: d } = deps([
			["/branches/", { json: { commit: { sha: "abc" } } }],
		]);
		expect(await getBranchHead(d, "t", REPO, "main")).toMatchObject({
			kind: "error",
		});
	});
});

describe("runs", () => {
	const run = {
		id: 9876543210,
		run_attempt: 2,
		path: ".github/workflows/dokploy.yml@refs/heads/main",
		head_branch: "main",
		head_sha: SHA,
		event: "push",
		status: "completed",
		conclusion: "success",
		repository: { id: 42 },
		head_repository: { id: 42 },
		html_url:
			"https://github.com/DevinoSolutions/voicelabs/actions/runs/9876543210/attempts/2",
	};

	it("reads one attempt and strips the @ref from the path", async () => {
		const { deps: d, calls } = deps([["/attempts/2", { json: run }]]);
		const result = await getRunAttempt(d, "t", REPO, 9876543210, 2);
		expect(calls[0]?.url).toContain("/actions/runs/9876543210/attempts/2");
		expect(result).toMatchObject({
			kind: "ok",
			value: {
				id: 9876543210,
				attempt: 2,
				path: ".github/workflows/dokploy.yml",
				headBranch: "main",
				headSha: SHA,
				event: "push",
				status: "completed",
				conclusion: "success",
				repositoryId: 42,
				headRepositoryId: 42,
			},
		});
	});

	it("keeps a missing head repository (a deleted fork) as null", async () => {
		const { deps: d } = deps([
			["/attempts/1", { json: { ...run, head_repository: null } }],
		]);
		const result = await getRunAttempt(d, "t", REPO, 1, 1);
		expect(result).toMatchObject({
			kind: "ok",
			value: { headRepositoryId: null },
		});
	});

	it("lists the runs of the workflow file on a branch", async () => {
		const { deps: d, calls } = deps([
			[
				"/workflows/dokploy.yml/runs",
				{ json: { workflow_runs: [run, { nope: 1 }] } },
			],
		]);
		const result = await listWorkflowRuns(d, "t", REPO, "dokploy.yml", "main");
		expect(calls[0]?.url).toContain("branch=main&per_page=20");
		expect(result).toMatchObject({ kind: "ok" });
		if (result.kind === "ok") expect(result.value).toHaveLength(1);
	});

	it("refuses a workflow file name that could change the path", async () => {
		const { deps: d, calls } = deps([["/", { json: {} }]]);
		expect(await listWorkflowRuns(d, "t", REPO, "../x.yml", "main")).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("artifacts", () => {
	const artifact = {
		id: 77,
		name: "dokploy-release",
		expired: false,
		size_in_bytes: 321,
		workflow_run: { id: 9876543210, repository_id: 42, head_repository_id: 42 },
	};

	it("lists the artifacts of a run by name", async () => {
		const { deps: d, calls } = deps([
			["/artifacts?", { json: { artifacts: [artifact] } }],
		]);
		const result = await listRunArtifacts(
			d,
			"t",
			REPO,
			9876543210,
			"dokploy-release",
		);
		expect(calls[0]?.url).toContain("name=dokploy-release");
		expect(result).toMatchObject({
			kind: "ok",
			value: [
				{
					id: 77,
					expired: false,
					sizeInBytes: 321,
					workflowRunId: 9876543210,
					workflowRunRepositoryId: 42,
					workflowRunHeadRepositoryId: 42,
				},
			],
		});
	});

	it("treats a missing expired flag as expired", async () => {
		const { deps: d } = deps([
			[
				"/artifacts?",
				{ json: { artifacts: [{ ...artifact, expired: undefined }] } },
			],
		]);
		const result = await listRunArtifacts(d, "t", REPO, 1, "dokploy-release");
		expect(result).toMatchObject({ kind: "ok", value: [{ expired: true }] });
	});

	it("downloads the zip and refuses one above the limit", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const { deps: d } = deps([["/artifacts/77/zip", { bytes }]]);
		expect(await downloadArtifactZip(d, "t", REPO, 77, 10)).toEqual({
			kind: "ok",
			value: bytes,
			etag: null,
		});
		expect(await downloadArtifactZip(d, "t", REPO, 77, 3)).toEqual({
			kind: "error",
			status: 413,
		});
	});

	it("maps an expired artifact (410) to not-found", async () => {
		const { deps: d } = deps([["/artifacts/77/zip", { status: 410 }]]);
		expect(await downloadArtifactZip(d, "t", REPO, 77, 10)).toEqual({
			kind: "not-found",
		});
	});
});

describe("compare", () => {
	it("returns the status of head relative to base", async () => {
		const { deps: d, calls } = deps([
			["/compare/", { json: { status: "behind" } }],
		]);
		expect(await compareCommits(d, "t", REPO, SHA, SHA2)).toMatchObject({
			kind: "ok",
			value: "behind",
		});
		expect(calls[0]?.url).toContain(`/compare/${SHA}...${SHA2}`);
	});

	it("refuses anything that is not a full sha, without calling GitHub", async () => {
		const { deps: d, calls } = deps([["/", { json: {} }]]);
		expect(await compareCommits(d, "t", REPO, "main", SHA2)).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});

	it("refuses an unknown status", async () => {
		const { deps: d } = deps([["/compare/", { json: { status: "weird" } }]]);
		expect(await compareCommits(d, "t", REPO, SHA, SHA2)).toMatchObject({
			kind: "error",
		});
	});
});

describe("environment policy", () => {
	it("reads the environment and its branch policies", async () => {
		const { deps: d, calls } = deps([
			[
				"/deployment-branch-policies",
				{ json: { branch_policies: [{ name: "main", type: "branch" }] } },
			],
			[
				"/environments/production",
				{
					json: {
						deployment_branch_policy: {
							custom_branch_policies: true,
							protected_branches: false,
						},
					},
				},
			],
		]);
		expect(await getEnvironmentPolicy(d, "t", REPO, "production")).toEqual({
			kind: "ok",
			etag: null,
			value: {
				customBranchPolicies: true,
				protectedBranches: false,
				policies: [{ name: "main", type: "branch" }],
			},
		});
		expect(calls).toHaveLength(2);
	});

	it("needs one call when the environment has no custom policy", async () => {
		const { deps: d, calls } = deps([
			[
				"/environments/production",
				{ json: { deployment_branch_policy: null } },
			],
		]);
		expect(
			await getEnvironmentPolicy(d, "t", REPO, "production"),
		).toMatchObject({
			kind: "ok",
			value: { customBranchPolicies: false, policies: [] },
		});
		expect(calls).toHaveLength(1);
	});

	it("reports a missing environment, and a failing policy list", async () => {
		const missing = deps([["/environments/", { status: 404 }]]);
		expect(
			await getEnvironmentPolicy(missing.deps, "t", REPO, "production"),
		).toEqual({
			kind: "not-found",
		});
		const broken = deps([
			["/deployment-branch-policies", { status: 500 }],
			[
				"/environments/production",
				{
					json: { deployment_branch_policy: { custom_branch_policies: true } },
				},
			],
		]);
		expect(
			await getEnvironmentPolicy(broken.deps, "t", REPO, "production"),
		).toEqual({
			kind: "error",
			status: 500,
		});
	});
});

describe("file text and the bound api", () => {
	it("decodes a base64 file", async () => {
		const content = Buffer.from(
			"uses: DevinoSolutions/dokploy-release@v1",
		).toString("base64");
		const { deps: d, calls } = deps([
			["/contents/", { json: { content, encoding: "base64" } }],
		]);
		expect(
			await getFileText(d, "t", REPO, ".github/workflows/dokploy.yml", "main"),
		).toMatchObject({
			kind: "ok",
			value: "uses: DevinoSolutions/dokploy-release@v1",
		});
		expect(calls[0]?.url).toContain(
			"/contents/.github/workflows/dokploy.yml?ref=main",
		);
	});

	it("binds the repository and token once", async () => {
		const { deps: d, calls } = deps([
			["/branches/", { json: { commit: { sha: SHA } } }],
		]);
		const api = createActionsApi(d, "gho_x", REPO);
		await api.branchHead("main");
		expect(calls[0]?.url).toContain(
			"/repos/DevinoSolutions/voicelabs/branches/main",
		);
	});
});
