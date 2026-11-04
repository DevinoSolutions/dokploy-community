import type {
	ApiResult,
	RepositoryInfo,
} from "@dokploy/server/services/gha-connect/actions-api";
import {
	type ConnectReads,
	type ConnectRequest,
	planConnect,
	type ServiceFacts,
	scopeProblem,
} from "@dokploy/server/services/gha-connect/connect";
import type { EnvironmentPolicy } from "@dokploy/server/services/gha-connect/environment-policy";
import { describe, expect, it } from "vitest";

const SHA = "c".repeat(40);
const ok = <T>(value: T): ApiResult<T> => ({ kind: "ok", value, etag: null });

const repo = (isPrivate = false): RepositoryInfo => ({
	id: 7,
	owner: "acme",
	name: "shop",
	fullName: "acme/shop",
	defaultBranch: "main",
	isPrivate,
});

const onlyMain: EnvironmentPolicy = {
	customBranchPolicies: true,
	protectedBranches: false,
	policies: [{ name: "main", type: "branch" }],
};

const request: ConnectRequest = {
	owner: "acme",
	repo: "shop",
	trackedBranch: "main",
	environment: "production",
	protectionMode: "environment",
	registryPrefix: null,
};

const githubApp: ServiceFacts = {
	kind: "application",
	sourceType: "github",
	owner: "Acme",
	repository: "shop",
	fields: {
		sourceType: "github",
		autoDeploy: true,
		branch: "main",
		password: "x",
	},
};

const reads = (over: Partial<ConnectReads> = {}): ConnectReads => ({
	repository: async () => ok(repo()),
	branchHead: async () => ok({ sha: SHA }),
	environmentPolicy: async () => ok(onlyMain),
	...over,
});

const SCOPES = ["repo_deployment", "public_repo"];

describe("scopeProblem", () => {
	it("needs repo_deployment", () => {
		expect(scopeProblem(["repo"], false)).toMatch(/repo_deployment/);
	});
	it("accepts public_repo for a public repository only", () => {
		expect(scopeProblem(["repo_deployment", "public_repo"], false)).toBeNull();
		expect(scopeProblem(["repo_deployment", "public_repo"], true)).toMatch(
			/private/,
		);
	});
	it("accepts repo for both", () => {
		expect(scopeProblem(["repo_deployment", "repo"], true)).toBeNull();
	});
	it("refuses the old scope set", () => {
		expect(scopeProblem(["repo_deployment", "read:packages"], false)).toMatch(
			/public_repo/,
		);
	});
});

describe("planConnect", () => {
	it("accepts a service already marked github-actions without a connection, and has nothing to restore", async () => {
		const app = await planConnect(
			{
				scopes: SCOPES,
				service: {
					kind: "application",
					sourceType: "github-actions",
					owner: null,
					repository: null,
					fields: { sourceType: "github-actions" },
				},
				request,
			},
			reads(),
		);
		expect(app).toMatchObject({
			ok: true,
			previousSource: null,
			serviceUpdate: { sourceType: "github-actions", autoDeploy: false },
		});
		const stack = await planConnect(
			{
				scopes: SCOPES,
				service: { kind: "compose", sourceType: "github-actions" },
				request,
			},
			reads(),
		);
		expect(stack).toMatchObject({ ok: true, previousSource: null });
	});

	it("plans a GitHub application: keep the old source, turn autodeploy off", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads(),
		);
		expect(plan).toMatchObject({
			ok: true,
			repoId: 7,
			repoFullName: "acme/shop",
			expectedSha: SHA,
			serviceUpdate: { sourceType: "github-actions", autoDeploy: false },
		});
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.previousSource).toMatchObject({
			sourceType: "github",
			autoDeploy: true,
			branch: "main",
		});
		expect(plan.previousSource).not.toHaveProperty("password");
	});

	it("keeps what a service that already runs an image was, so Disconnect can restore it", async () => {
		const plan = await planConnect(
			{
				scopes: SCOPES,
				service: {
					kind: "application",
					sourceType: "docker",
					owner: null,
					repository: null,
					fields: {},
				},
				request,
			},
			reads(),
		);
		expect(plan).toMatchObject({
			ok: true,
			previousSource: { sourceType: "docker" },
			serviceUpdate: { sourceType: "github-actions", autoDeploy: false },
		});
	});

	it("accepts a raw compose and refuses the other compose sources", async () => {
		const raw = await planConnect(
			{
				scopes: SCOPES,
				service: { kind: "compose", sourceType: "raw" },
				request,
			},
			reads(),
		);
		expect(raw).toMatchObject({
			ok: true,
			previousSource: { sourceType: "raw" },
			serviceUpdate: { sourceType: "github-actions" },
		});
		expect((raw as { serviceUpdate: object }).serviceUpdate).not.toHaveProperty(
			"autoDeploy",
		);
		const git = await planConnect(
			{
				scopes: SCOPES,
				service: { kind: "compose", sourceType: "git" },
				request,
			},
			reads(),
		);
		expect(git).toMatchObject({ ok: false, code: "service" });
	});

	it("refuses an application built from another repository", async () => {
		const other: ServiceFacts = {
			...githubApp,
			repository: "other",
		} as ServiceFacts;
		const plan = await planConnect(
			{ scopes: SCOPES, service: other, request },
			reads(),
		);
		expect(plan).toMatchObject({ ok: false, code: "repository" });
	});

	it("refuses application sources it cannot flip", async () => {
		const plan = await planConnect(
			{
				scopes: SCOPES,
				service: {
					kind: "application",
					sourceType: "gitlab",
					owner: null,
					repository: null,
					fields: {},
				},
				request,
			},
			reads(),
		);
		expect(plan).toMatchObject({ ok: false, code: "service" });
	});

	it("refuses a git application that wants a private registry, and lets a raw compose have one", async () => {
		const mirror = {
			...request,
			registryPrefix: "localhost:5000/registry.devino.ca",
		};
		const gitApp = await planConnect(
			{ scopes: SCOPES, service: githubApp, request: mirror },
			reads(),
		);
		expect(gitApp).toMatchObject({ ok: false, code: "registry" });
		const compose = await planConnect(
			{
				scopes: SCOPES,
				service: { kind: "compose", sourceType: "raw" },
				request: mirror,
			},
			reads(),
		);
		expect(compose).toMatchObject({ ok: true });
	});

	it("refuses repository-secret mode for now", async () => {
		const plan = await planConnect(
			{
				scopes: SCOPES,
				service: githubApp,
				request: { ...request, protectionMode: "repository-secret" },
			},
			reads(),
		);
		expect(plan).toMatchObject({ ok: false, code: "mode" });
	});

	it("blocks a private repository without the repo scope", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ repository: async () => ok(repo(true)) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "scope" });
	});

	it("blocks a missing branch", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ branchHead: async () => ({ kind: "not-found" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "branch" });
	});

	it("tells the user to create a missing environment", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ environmentPolicy: async () => ({ kind: "not-found" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "environment" });
		if (plan.ok) throw new Error("unreachable");
		expect(plan.message).toMatch(/Create the GitHub environment production/);
	});

	it("blocks an environment that allows more than the tracked branch", async () => {
		const wide: EnvironmentPolicy = {
			customBranchPolicies: false,
			protectedBranches: false,
			policies: [],
		};
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ environmentPolicy: async () => ok(wide) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "environment" });
	});

	it("never turns a read error into a pass", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({
				environmentPolicy: async () => ({
					kind: "forbidden",
					message: "Resource not accessible",
				}),
			}),
		);
		expect(plan).toMatchObject({ ok: false, code: "github" });
	});

	it("hints at the repo scope when a repository is not found for a token without it (GitHub's 404 for a private repository)", async () => {
		const notFound = reads({ repository: async () => ({ kind: "not-found" }) });
		const withPublic = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			notFound,
		);
		expect(withPublic).toMatchObject({
			ok: false,
			code: "github",
			message: expect.stringContaining("repo scope"),
		});
		const withRepo = await planConnect(
			{ scopes: ["repo_deployment", "repo"], service: githubApp, request },
			notFound,
		);
		expect(withRepo).toMatchObject({
			ok: false,
			message: expect.not.stringContaining("repo scope"),
		});
	});

	it("reports an unauthorized token as a reconnect", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ repository: async () => ({ kind: "unauthorized" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "github" });
		if (plan.ok) throw new Error("unreachable");
		expect(plan.message).toMatch(/Reconnect GitHub/);
	});
});
