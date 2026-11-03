import {
	type AcceptanceResult,
	acceptRelease,
	type ConnectionFacts,
	digestsOf,
} from "@dokploy/server/services/gha-connect/acceptance";
import type {
	ActionsApi,
	ApiResult,
	ArtifactInfo,
	JobInfo,
	RunInfo,
} from "@dokploy/server/services/gha-connect/actions-api";
import type { EnvironmentPolicy } from "@dokploy/server/services/gha-connect/environment-policy";
import type { CompareStatus } from "@dokploy/server/services/gha-connect/ordering";
import type {
	ProbeResult,
	RegistryProbe,
} from "@dokploy/server/services/gha-connect/registry-probe";
import { describe, expect, it } from "vitest";
import { buildZip } from "./zip-fixture";

const SHA = "a".repeat(40);
const OLD_SHA = "c".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const RUN_ID = 9876543210;
const REPO_ID = 42;
const ok = <T>(value: T): ApiResult<T> => ({ kind: "ok", value, etag: null });

const manifest = (overrides: Record<string, unknown> = {}) => ({
	schema: "dokploy.release/v1",
	sha: SHA,
	delivery: "pull",
	release: { id: `gh-${RUN_ID}.1`, services: ["web"] },
	source: {
		forge: "github",
		ref: "refs/heads/dev",
		runId: String(RUN_ID),
		runAttempt: 1,
	},
	environment: "development",
	services: [
		{
			key: "web",
			images: [
				{
					name: "web",
					composeService: "web",
					ref: `registry.devino.ca/voicelabs/web@${DIGEST}`,
				},
			],
		},
	],
	...overrides,
});

const facts = (overrides: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
	repoId: REPO_ID,
	workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "web",
	owner: "DevinoSolutions",
	repo: "voicelabs",
	protectionMode: "environment",
	registryPrefix: "registry.devino.ca",
	registryProbeHost: null,
	deployed: null,
	currentRepositories: ["registry.devino.ca/voicelabs/web"],
	...overrides,
});

/** A GitHub where everything is right; each test breaks one thing. */
const world = () => {
	const state = {
		run: {
			id: RUN_ID,
			attempt: 1,
			path: ".github/workflows/dokploy-web-build-deploy.yml",
			headBranch: "dev",
			headSha: SHA,
			event: "push",
			status: "completed",
			conclusion: "success",
			repositoryId: REPO_ID,
			headRepositoryId: REPO_ID,
			htmlUrl: `https://github.com/DevinoSolutions/voicelabs/actions/runs/${RUN_ID}`,
			runStartedAt: null,
			updatedAt: null,
		} as RunInfo,
		runResult: null as ApiResult<RunInfo> | null,
		artifacts: [
			{
				id: 77,
				name: "dokploy-release",
				expired: false,
				sizeInBytes: 400,
				workflowRunId: RUN_ID,
				workflowRunRepositoryId: REPO_ID,
				workflowRunHeadRepositoryId: REPO_ID,
			},
		] as ArtifactInfo[],
		artifactsResult: null as ApiResult<ArtifactInfo[]> | null,
		zip: buildZip([
			{ name: "dokploy-release.json", data: JSON.stringify(manifest()) },
		]) as Uint8Array,
		policy: {
			customBranchPolicies: true,
			protectedBranches: false,
			policies: [{ name: "dev", type: "branch" }],
		} as EnvironmentPolicy,
		policyResult: null as ApiResult<EnvironmentPolicy> | null,
		downloadResult: null as ApiResult<Uint8Array> | null,
		jobs: [] as JobInfo[],
		jobsResult: null as ApiResult<JobInfo[]> | null,
		logs: new Map<number, string>(),
		logResult: null as ApiResult<string> | null,
		jobCalls: [] as number[],
		head: SHA,
		compare: new Map<string, CompareStatus>(),
		probe: { kind: "ok", digest: DIGEST } as ProbeResult,
		calls: [] as string[],
		probeCalls: [] as Array<{ host: string; name: string; digest: string }>,
	};
	const api: ActionsApi = {
		branchHead: async () => ok({ sha: state.head }),
		runAttempt: async () => state.runResult ?? ok(state.run),
		artifacts: async () => state.artifactsResult ?? ok(state.artifacts),
		downloadArtifact: async () => state.downloadResult ?? ok(state.zip),
		runJobs: async () => state.jobsResult ?? ok(state.jobs),
		jobLog: async (jobId) => {
			state.jobCalls.push(jobId);
			const log = state.logs.get(jobId);
			if (state.logResult) return state.logResult;
			return log === undefined ? { kind: "not-found" } : ok(log);
		},
		compare: async (base, head) => {
			state.calls.push(`compare ${base.slice(0, 1)}..${head.slice(0, 1)}`);
			const status = state.compare.get(`${base}...${head}`);
			return status ? ok(status) : { kind: "not-found" };
		},
		environmentPolicy: async () => state.policyResult ?? ok(state.policy),
	};
	const probe: RegistryProbe = {
		headDigest: async (input) => {
			state.probeCalls.push(input);
			return state.probe;
		},
	};
	return { state, api, probe };
};

const run = (
	w: ReturnType<typeof world>,
	connection: ConnectionFacts = facts(),
	attempt = 1,
) =>
	acceptRelease(
		{ runId: RUN_ID, runAttempt: attempt, connection },
		{ api: w.api, probe: w.probe },
	);

const expectRefused = (
	result: AcceptanceResult,
	code: string,
	block: boolean,
) => {
	expect(result).toMatchObject({ kind: "refused", code, block });
};

const zipOf = (m: unknown) =>
	buildZip([{ name: "dokploy-release.json", data: JSON.stringify(m) }]);

describe("acceptRelease: the happy path", () => {
	it("accepts a clean release and returns only this service's images", async () => {
		const result = await run(world());
		expect(result.kind).toBe("accepted");
		if (result.kind !== "accepted") return;
		expect(result.release).toMatchObject({
			runId: RUN_ID,
			runAttempt: 1,
			sha: SHA,
			delivery: "pull",
			serviceKey: "web",
			environment: "development",
		});
		expect(digestsOf(result.release.images)).toEqual([DIGEST]);
	});

	it("skips the environment check only in confirmed repository-secret mode", async () => {
		const w = world();
		w.state.policy = {
			customBranchPolicies: false,
			protectedBranches: false,
			policies: [],
		};
		expectRefused(await run(w), "policy-wider", true);
		const relaxed = await run(
			w,
			facts({ protectionMode: "repository-secret" }),
		);
		expect(relaxed.kind).toBe("accepted");
	});
});

describe("rule 1: the run", () => {
	it("refuses a run of another workflow file", async () => {
		const w = world();
		w.state.run = { ...w.state.run, path: ".github/workflows/evil.yml" };
		expectRefused(await run(w), "run-path", false);
	});
	it("refuses a run of another branch", async () => {
		const w = world();
		w.state.run = { ...w.state.run, headBranch: "feature/x" };
		expectRefused(await run(w), "run-branch", false);
	});
	it.each(["pull_request", "workflow_run", "schedule", "pull_request_target"])(
		"refuses a %s run",
		async (event) => {
			const w = world();
			w.state.run = { ...w.state.run, event };
			expectRefused(await run(w), "run-event", false);
		},
	);
	it("accepts a manual dispatch", async () => {
		const w = world();
		w.state.run = { ...w.state.run, event: "workflow_dispatch" };
		expect((await run(w)).kind).toBe("accepted");
	});
	it("refuses a run from a fork (another head repository) and a deleted fork", async () => {
		const w = world();
		w.state.run = { ...w.state.run, headRepositoryId: 999 };
		expectRefused(await run(w), "run-repository", false);
		w.state.run = { ...w.state.run, headRepositoryId: null };
		expectRefused(await run(w), "run-repository", false);
	});
	it("waits for a run that has not completed, without deciding", async () => {
		const w = world();
		w.state.run = { ...w.state.run, status: "in_progress", conclusion: null };
		expect(await run(w)).toMatchObject({ kind: "pending" });
	});
	it.each(["failure", "cancelled", "timed_out", null])(
		"refuses a run that concluded %s",
		async (conclusion) => {
			const w = world();
			w.state.run = { ...w.state.run, conclusion };
			expectRefused(await run(w), "run-failed", false);
		},
	);
	it("refuses a run GitHub does not know", async () => {
		const w = world();
		w.state.runResult = { kind: "not-found" };
		expectRefused(await run(w), "run-missing", false);
	});
});

describe("rule 2: the artifact", () => {
	it("refuses a run without the artifact", async () => {
		const w = world();
		w.state.artifacts = [];
		expectRefused(await run(w), "artifact-missing", false);
	});
	it("refuses an artifact with another name", async () => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, name: "other" }));
		expectRefused(await run(w), "artifact-missing", false);
	});
	it("refuses an expired artifact", async () => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, expired: true }));
		expectRefused(await run(w), "artifact-expired", false);
	});
	it.each([
		["another run", { workflowRunId: 1 }],
		["another repository", { workflowRunRepositoryId: 1 }],
		["another head repository", { workflowRunHeadRepositoryId: 1 }],
	])("refuses an artifact uploaded by %s", async (_name, patch) => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, ...patch }));
		expectRefused(await run(w), "artifact-binding", false);
	});
	it("uses the newest artifact when a re-run left two", async () => {
		const w = world();
		const first = w.state.artifacts[0] as ArtifactInfo;
		w.state.artifacts = [first, { ...first, id: 99, expired: true }];
		expectRefused(await run(w), "artifact-expired", false);
	});
	it("refuses an archive that is not a readable zip", async () => {
		const w = world();
		w.state.zip = new Uint8Array(40);
		expectRefused(await run(w), "artifact-unreadable", false);
	});
	it("refuses an oversize listing before downloading", async () => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({
			...a,
			sizeInBytes: 10_000_000,
		}));
		expectRefused(await run(w), "artifact-unreadable", false);
	});
});

describe("rule 3: the manifest", () => {
	it("blocks on a manifest that does not parse", async () => {
		const w = world();
		w.state.zip = zipOf({ schema: "dokploy.release/v1" });
		expectRefused(await run(w), "manifest-invalid", true);
	});
	it("blocks on an unknown major schema", async () => {
		const w = world();
		w.state.zip = zipOf(manifest({ schema: "dokploy.release/v2" }));
		expectRefused(await run(w), "manifest-schema", true);
	});
	it("blocks on a migration request in phase 1", async () => {
		const w = world();
		const m = manifest();
		(m.services[0] as Record<string, unknown>).migrations = { command: "x" };
		w.state.zip = zipOf(m);
		expectRefused(await run(w), "manifest-migrations", true);
	});
	it.each([
		["a sha other than the run's head", manifest({ sha: "d".repeat(40) })],
		[
			"another run id",
			manifest({
				source: {
					forge: "github",
					ref: "refs/heads/dev",
					runId: "5",
					runAttempt: 1,
				},
			}),
		],
		[
			"another branch",
			manifest({
				source: {
					forge: "github",
					ref: "refs/heads/main",
					runId: String(RUN_ID),
					runAttempt: 1,
				},
			}),
		],
		["another environment", manifest({ environment: "production" })],
	])("blocks on %s", async (_name, m) => {
		const w = world();
		w.state.zip = zipOf(m);
		expectRefused(await run(w), "manifest-binding", true);
	});
	it("ignores a release that does not include this service", async () => {
		const w = world();
		const m = manifest();
		m.release.services = ["worker"];
		(m.services[0] as { key: string }).key = "worker";
		w.state.zip = zipOf(m);
		expect(await run(w)).toMatchObject({ kind: "ignored" });
	});
});

describe("rule 4: the images", () => {
	const withRef = (ref: string) => {
		const m = manifest();
		(m.services[0] as { images: Array<{ ref: string }> }).images[0]!.ref = ref;
		return m;
	};
	it("blocks on an image outside the namespace", async () => {
		const w = world();
		w.state.zip = zipOf(withRef(`evil.example.com/voicelabs/web@${DIGEST}`));
		expectRefused(await run(w), "image-namespace", true);
	});
	it("blocks on a preview image, even before the service runs anything", async () => {
		const w = world();
		w.state.zip = zipOf(
			withRef(`registry.devino.ca/voicelabs/preview/pr-1/web@${DIGEST}`),
		);
		expectRefused(
			await run(w, facts({ currentRepositories: [] })),
			"image-namespace",
			true,
		);
	});
	it("blocks on a repository the service does not run", async () => {
		const w = world();
		w.state.zip = zipOf(
			withRef(`registry.devino.ca/voicelabs/other@${DIGEST}`),
		);
		expectRefused(await run(w), "image-repository", true);
	});
	it("blocks when the registry serves another digest, none, or nothing", async () => {
		for (const probe of [
			{ kind: "ok", digest: `sha256:${"1".repeat(64)}` },
			{ kind: "ok", digest: null },
			{ kind: "not-found" },
		] as ProbeResult[]) {
			const w = world();
			w.state.probe = probe;
			expectRefused(await run(w), "image-unverified", true);
		}
	});
	it("retries, without deciding, when the registry cannot be reached", async () => {
		const w = world();
		w.state.probe = { kind: "unreachable", status: 503 };
		expect(await run(w)).toMatchObject({ kind: "retry" });
	});
});

describe("rule 5: the environment policy", () => {
	it.each([
		[
			"every branch",
			{ customBranchPolicies: false, protectedBranches: false, policies: [] },
		],
		[
			"a second branch",
			{
				customBranchPolicies: true,
				protectedBranches: false,
				policies: [
					{ name: "dev", type: "branch" },
					{ name: "main", type: "branch" },
				],
			},
		],
		[
			"a wildcard",
			{
				customBranchPolicies: true,
				protectedBranches: false,
				policies: [{ name: "*", type: "branch" }],
			},
		],
	])(
		"blocks, and asks again later, when it allows %s",
		async (_name, policy) => {
			const w = world();
			w.state.policy = policy;
			expect(await run(w)).toMatchObject({
				kind: "refused",
				code: "policy-wider",
				block: true,
				recheck: true,
			});
		},
	);
	it("blocks when the environment does not exist or cannot be read", async () => {
		const missing = world();
		missing.state.policyResult = { kind: "not-found" };
		expect(await run(missing)).toMatchObject({
			code: "policy-unreadable",
			block: true,
			recheck: true,
		});
		const broken = world();
		broken.state.policyResult = { kind: "error", status: 500 };
		expect(await run(broken)).toMatchObject({
			code: "policy-unreadable",
			block: true,
		});
		const forbidden = world();
		forbidden.state.policyResult = { kind: "forbidden", message: "x" };
		expect(await run(forbidden)).toMatchObject({
			code: "policy-unreadable",
			block: true,
		});
	});
	it("retries, without blocking, on a rate limit or a dead token", async () => {
		const limited = world();
		limited.state.policyResult = { kind: "rate-limited", retryAt: 5 };
		expect(await run(limited)).toMatchObject({ kind: "retry" });
		const dead = world();
		dead.state.policyResult = { kind: "unauthorized" };
		expect(await run(dead)).toMatchObject({
			kind: "retry",
			cause: { kind: "unauthorized" },
		});
	});
});

describe("rule 6: ordering", () => {
	const deployed = (sha: string, runId = 100) => ({
		sha,
		runId,
		attempt: 1,
		digests: [`sha256:${"9".repeat(64)}`],
	});

	it("refuses a commit that is not on the tracked branch", async () => {
		const w = world();
		w.state.head = "f".repeat(40);
		w.state.compare.set(`${SHA}...${"f".repeat(40)}`, "diverged");
		expectRefused(await run(w), "not-on-branch", false);
	});
	it("accepts an ancestor of the branch head", async () => {
		const w = world();
		w.state.head = "f".repeat(40);
		w.state.compare.set(`${SHA}...${"f".repeat(40)}`, "ahead");
		expect((await run(w)).kind).toBe("accepted");
	});
	it("refuses a release older than the deployed commit", async () => {
		const w = world();
		w.state.compare.set(`${OLD_SHA}...${SHA}`, "behind");
		expectRefused(
			await run(w, facts({ deployed: deployed(OLD_SHA) })),
			"ordering-behind",
			false,
		);
	});
	it("accepts a release newer than the deployed commit", async () => {
		const w = world();
		w.state.compare.set(`${OLD_SHA}...${SHA}`, "ahead");
		expect((await run(w, facts({ deployed: deployed(OLD_SHA) }))).kind).toBe(
			"accepted",
		);
	});
	it("is a no-op when the same commit and digests are already deployed by an earlier run", async () => {
		const w = world();
		const same = { sha: SHA, runId: 100, attempt: 1, digests: [DIGEST] };
		expect((await run(w, facts({ deployed: same }))).kind).toBe("noop");
	});
	it("refuses an older run of the deployed commit", async () => {
		const w = world();
		const later = {
			sha: SHA,
			runId: RUN_ID + 1,
			attempt: 1,
			digests: [`sha256:${"9".repeat(64)}`],
		};
		expectRefused(
			await run(w, facts({ deployed: later })),
			"ordering-older-run",
			false,
		);
	});
	it("allows going behind only for an explicit rollback", async () => {
		const w = world();
		w.state.compare.set(`${OLD_SHA}...${SHA}`, "behind");
		const result = await run(
			w,
			facts({ deployed: deployed(OLD_SHA), allowBehind: true }),
		);
		expect(result.kind).toBe("accepted");
	});
	it("retries when GitHub cannot answer the compare", async () => {
		const w = world();
		w.api.compare = async () => ({ kind: "rate-limited", retryAt: 9 });
		expect(await run(w, facts({ deployed: deployed(OLD_SHA) }))).toMatchObject({
			kind: "retry",
		});
	});
});

describe("transient failures never decide", () => {
	it.each([
		["rate-limited", { kind: "rate-limited", retryAt: 5 }],
		["unauthorized", { kind: "unauthorized" }],
		["error", { kind: "error", status: 502 }],
	] as const)("a %s run lookup is a retry", async (_name, cause) => {
		const w = world();
		w.state.runResult = cause as ApiResult<RunInfo>;
		expect(await run(w)).toMatchObject({ kind: "retry", cause });
	});
	it("a failing artifact listing is a retry", async () => {
		const w = world();
		w.state.artifactsResult = { kind: "error", status: 500 };
		expect(await run(w)).toMatchObject({ kind: "retry" });
	});
});

describe("the tunnel mirror (localhost:5000/registry.devino.ca)", () => {
	const MIRROR = "localhost:5000/registry.devino.ca/voicelabs/web";
	const mirrored = (attempt = 1) =>
		manifest({
			source: {
				forge: "github",
				ref: "refs/heads/dev",
				runId: String(RUN_ID),
				runAttempt: attempt,
			},
			services: [
				{
					key: "web",
					images: [
						{ name: "web", composeService: "web", ref: `${MIRROR}@${DIGEST}` },
					],
				},
			],
		});
	const mirrorFacts = (over: Partial<ConnectionFacts> = {}) =>
		facts({
			registryPrefix: "localhost:5000/registry.devino.ca",
			registryProbeHost: "registry.devino.ca",
			currentRepositories: [],
			...over,
		});

	it("accepts the wrapper's real image name, checks the digest at the registry record and maps it to GHCR", async () => {
		const w = world();
		w.state.zip = zipOf(mirrored());
		const result = await run(w, mirrorFacts());
		expect(result.kind).toBe("accepted");
		if (result.kind !== "accepted") return;
		expect(w.state.probeCalls).toEqual([
			{
				host: "registry.devino.ca",
				name: "registry.devino.ca/voicelabs/web",
				digest: DIGEST,
			},
		]);
		expect(result.release.canonical).toEqual({
			[MIRROR]: "ghcr.io/devinosolutions/voicelabs/web",
		});
	});

	it("refuses the same image when the connection names no mirror prefix", async () => {
		const w = world();
		w.state.zip = zipOf(mirrored());
		expectRefused(
			await run(w, facts({ registryPrefix: null, currentRepositories: [] })),
			"image-namespace",
			true,
		);
	});

	it("refuses a mirrored image of another repository", async () => {
		const w = world();
		w.state.zip = zipOf(
			manifest({
				services: [
					{
						key: "web",
						images: [
							{
								name: "web",
								composeService: "web",
								ref: `localhost:5000/registry.devino.ca/other/web@${DIGEST}`,
							},
						],
					},
				],
			}),
		);
		expectRefused(await run(w, mirrorFacts()), "image-namespace", true);
	});
});

describe("a re-run replaces the artifact", () => {
	it("answers a Deployment of an older attempt as superseded and never blocks", async () => {
		const w = world();
		w.state.run = { ...w.state.run, attempt: 1 };
		w.state.zip = zipOf(
			manifest({
				source: {
					forge: "github",
					ref: "refs/heads/dev",
					runId: String(RUN_ID),
					runAttempt: 2,
				},
			}),
		);
		const result = await run(w, facts(), 1);
		expect(result).toMatchObject({ kind: "superseded" });
	});

	it("still refuses a manifest that claims a lower attempt than the Deployment (a binding error)", async () => {
		const w = world();
		w.state.run = { ...w.state.run, attempt: 2 };
		const result = await run(w, facts(), 2);
		expectRefused(result, "manifest-binding", true);
	});
});

describe("the manifest from the release job's log (artifact uploads blocked by the storage quota)", () => {
	type World = ReturnType<typeof world>;
	const JOB_ID = 5001;
	const releaseJob = (patch: Partial<JobInfo> = {}): JobInfo => ({
		id: JOB_ID,
		runId: RUN_ID,
		attempt: 1,
		name: "release",
		status: "completed",
		conclusion: "success",
		headSha: SHA,
		stepNames: [
			"Set up job",
			"Run DevinoSolutions/dokploy-release@v1",
			"Complete job",
		],
		...patch,
	});
	const marker = (m: unknown) =>
		`::dokploy-release::${Buffer.from(JSON.stringify(m)).toString("base64")}`;
	const logOf = (...lines: string[]) =>
		[
			"2026-11-03T12:00:00.0000000Z ##[group]Run DevinoSolutions/dokploy-release@v1",
			"2026-11-03T12:00:01.0000000Z Release gh-9876543210.1: web (pull)",
			...lines.map((line) => `2026-11-03T12:00:02.1234567Z ${line}`),
			"2026-11-03T12:00:03.0000000Z ##[endgroup]",
			"",
		].join("\n");
	/** The artifact upload failed (quota): the run lists no artifact, the job log has the line. */
	const quotaWorld = (m: unknown = manifest(), job: Partial<JobInfo> = {}) => {
		const w = world();
		w.state.artifacts = [];
		w.state.jobs = [releaseJob(job)];
		w.state.logs.set(JOB_ID, logOf(marker(m)));
		return w;
	};
	const goodArtifacts = () => world().state.artifacts;

	it("accepts the release from the job log when the run has no artifact, and says so", async () => {
		const w = quotaWorld();
		const result = await run(w);
		expect(result.kind).toBe("accepted");
		if (result.kind !== "accepted") return;
		expect(result.release.manifestSource).toBe("job-log");
		expect(digestsOf(result.release.images)).toEqual([DIGEST]);
		expect(w.state.jobCalls).toEqual([JOB_ID]);
	});

	it("prefers the artifact and never reads a log when the artifact is good", async () => {
		const w = quotaWorld();
		w.state.artifacts = goodArtifacts();
		const result = await run(w);
		expect(result.kind === "accepted" && result.release.manifestSource).toBe(
			"artifact",
		);
		expect(w.state.jobCalls).toEqual([]);
	});

	it.each([
		[
			"an artifact that expired",
			(w: World) => {
				w.state.artifacts = goodArtifacts().map((a) => ({
					...a,
					expired: true,
				}));
			},
		],
		[
			"a download that is gone (404)",
			(w: World) => {
				w.state.artifacts = goodArtifacts();
				w.state.downloadResult = { kind: "not-found" };
			},
		],
		[
			"an archive that is not a zip",
			(w: World) => {
				w.state.artifacts = goodArtifacts();
				w.state.zip = new Uint8Array(40);
			},
		],
		[
			"a failing artifact listing",
			(w: World) => {
				w.state.artifactsResult = { kind: "error", status: 500 };
			},
		],
		[
			"an artifact listing GitHub forbids (quota)",
			(w: World) => {
				w.state.artifactsResult = { kind: "forbidden", message: "quota" };
			},
		],
		[
			"a download GitHub forbids (quota)",
			(w: World) => {
				w.state.artifacts = goodArtifacts();
				w.state.downloadResult = { kind: "forbidden", message: "quota" };
			},
		],
	])("falls back to the job log after %s", async (_name, breakIt) => {
		const w = quotaWorld();
		breakIt(w);
		const result = await run(w);
		expect(result.kind === "accepted" && result.release.manifestSource).toBe(
			"job-log",
		);
	});

	it("does not fall back on a rate limit or a dead token: asks again later", async () => {
		for (const cause of [
			{ kind: "rate-limited", retryAt: 5 },
			{ kind: "unauthorized" },
		] as const) {
			const w = quotaWorld();
			w.state.artifactsResult = cause;
			expect(await run(w)).toMatchObject({ kind: "retry", cause });
			expect(w.state.jobCalls).toEqual([]);
		}
	});

	it("never falls back from an artifact bound to another run: that is an anomaly", async () => {
		const w = quotaWorld();
		w.state.artifacts = goodArtifacts().map((a) => ({
			...a,
			workflowRunId: 1,
		}));
		expectRefused(await run(w), "artifact-binding", false);
		expect(w.state.jobCalls).toEqual([]);
	});

	it("answers the artifact's refusal when the log has no manifest either", async () => {
		const w = quotaWorld();
		w.state.logs.set(JOB_ID, logOf("nothing to see"));
		expectRefused(await run(w), "artifact-missing", false);
		const noJobs = quotaWorld();
		noJobs.state.jobs = [];
		expectRefused(await run(noJobs), "artifact-missing", false);
		const expired = quotaWorld();
		expired.state.artifacts = goodArtifacts().map((a) => ({
			...a,
			expired: true,
		}));
		expired.state.jobs = [];
		expectRefused(await run(expired), "artifact-expired", false);
	});

	it("retries, without deciding, when the jobs or a log cannot be read", async () => {
		const jobs = quotaWorld();
		jobs.state.jobsResult = { kind: "error", status: 502 };
		expect(await run(jobs)).toMatchObject({ kind: "retry" });
		const log = quotaWorld();
		log.state.logResult = { kind: "rate-limited", retryAt: 9 };
		expect(await run(log)).toMatchObject({ kind: "retry" });
	});

	describe("the same rules as the artifact", () => {
		it("refuses and blocks a tampered marker: a manifest of another commit", async () => {
			const w = quotaWorld(manifest({ sha: "d".repeat(40) }));
			expectRefused(await run(w), "manifest-binding", true);
		});
		it.each([
			[
				"another run id",
				manifest({
					source: {
						forge: "github",
						ref: "refs/heads/dev",
						runId: "5",
						runAttempt: 1,
					},
				}),
			],
			[
				"another branch",
				manifest({
					source: {
						forge: "github",
						ref: "refs/heads/main",
						runId: String(RUN_ID),
						runAttempt: 1,
					},
				}),
			],
			["another environment", manifest({ environment: "production" })],
			[
				"a higher attempt than the job's (the Deployment is then superseded)",
				manifest({
					source: {
						forge: "github",
						ref: "refs/heads/dev",
						runId: String(RUN_ID),
						runAttempt: 2,
					},
				}),
			],
		])("never accepts a marker with %s", async (_name, m) => {
			const result = await run(quotaWorld(m));
			expect(["refused", "superseded"]).toContain(result.kind);
			if (result.kind === "refused")
				expect(result.code).toBe("manifest-binding");
		});
		it("blocks a digest the registry does not serve, and an image outside the namespace", async () => {
			const w = quotaWorld();
			w.state.probe = { kind: "ok", digest: `sha256:${"1".repeat(64)}` };
			expectRefused(await run(w), "image-unverified", true);
			const m = manifest();
			(m.services[0] as { images: Array<{ ref: string }> }).images[0]!.ref =
				`evil.example.com/voicelabs/web@${DIGEST}`;
			expectRefused(await run(quotaWorld(m)), "image-namespace", true);
		});
		it("keeps the environment policy re-check", async () => {
			const w = quotaWorld();
			w.state.policy = {
				customBranchPolicies: false,
				protectedBranches: false,
				policies: [],
			};
			expectRefused(await run(w), "policy-wider", true);
		});
		it("keeps the ordering rules", async () => {
			const w = quotaWorld();
			w.state.compare.set(`${OLD_SHA}...${SHA}`, "behind");
			const deployed = {
				sha: OLD_SHA,
				runId: 100,
				attempt: 1,
				digests: [`sha256:${"9".repeat(64)}`],
			};
			expectRefused(
				await run(w, facts({ deployed })),
				"ordering-behind",
				false,
			);
		});
		it("accepts a log of attempt 2 for a Deployment of attempt 2", async () => {
			const m = manifest({
				source: {
					forge: "github",
					ref: "refs/heads/dev",
					runId: String(RUN_ID),
					runAttempt: 2,
				},
			});
			const w = quotaWorld(m, { attempt: 2 });
			w.state.run = { ...w.state.run, attempt: 2 };
			const result = await run(w, facts(), 2);
			expect(result.kind === "accepted" && result.release.manifestSource).toBe(
				"job-log",
			);
		});
	});

	describe("which log is read", () => {
		it("ignores jobs that are not the release job, did not succeed, or ran another commit or attempt", async () => {
			const w = quotaWorld();
			w.state.jobs = [
				releaseJob({ id: 1, name: "build", stepNames: ["Run docker build"] }),
				releaseJob({ id: 2, conclusion: "failure" }),
				releaseJob({ id: 3, status: "in_progress", conclusion: null }),
				releaseJob({ id: 4, headSha: "d".repeat(40) }),
				releaseJob({ id: 5, runId: 12 }),
				releaseJob({ id: 6, attempt: 2 }),
			];
			for (const id of [1, 2, 3, 4, 5, 6]) {
				w.state.logs.set(id, logOf(marker(manifest())));
			}
			expectRefused(await run(w), "artifact-missing", false);
			expect(w.state.jobCalls).toEqual([]);
		});
		it("matches the release job by its exact name when the connection knows it", async () => {
			const w = quotaWorld();
			w.state.jobs = [
				releaseJob({ id: 1, name: "publish" }),
				releaseJob({ id: 2, name: "release" }),
			];
			w.state.logs.set(1, logOf(marker(manifest())));
			w.state.logs.set(2, logOf(marker(manifest())));
			const result = await run(w, facts({ releaseJobName: "publish" }));
			expect(result.kind).toBe("accepted");
			expect(w.state.jobCalls).toEqual([1]);
		});
		it("reads at most three jobs", async () => {
			const w = quotaWorld();
			w.state.jobs = [1, 2, 3, 4, 5].map((id) => releaseJob({ id }));
			await run(w);
			expect(w.state.jobCalls).toEqual([1, 2, 3]);
		});
		it("skips a log that is too large or gone and uses another job's", async () => {
			const w = quotaWorld();
			w.state.jobs = [
				releaseJob({ id: 1 }),
				releaseJob({ id: 2 }),
				releaseJob({ id: 3 }),
			];
			w.api.jobLog = async (id) =>
				id === 1
					? { kind: "error", status: 413 }
					: id === 2
						? { kind: "not-found" }
						: ok(logOf(marker(manifest())));
			const result = await run(w);
			expect(result.kind === "accepted" && result.release.manifestSource).toBe(
				"job-log",
			);
		});
	});

	describe("the marker line", () => {
		it("blocks on two different manifests (ambiguous), not on the same one printed twice", async () => {
			const w = quotaWorld();
			w.state.logs.set(
				JOB_ID,
				logOf(
					marker(manifest()),
					marker(manifest({ environment: "production" })),
				),
			);
			expectRefused(await run(w), "manifest-invalid", true);
			const twice = quotaWorld();
			twice.state.logs.set(
				JOB_ID,
				logOf(marker(manifest()), marker(manifest())),
			);
			expect((await run(twice)).kind).toBe("accepted");
		});
		it("blocks on a marker that is not valid base64, and one that is not JSON", async () => {
			const bad = quotaWorld();
			bad.state.logs.set(JOB_ID, logOf("::dokploy-release::%%%not-base64%%%"));
			expectRefused(await run(bad), "manifest-invalid", true);
			const notJson = quotaWorld();
			notJson.state.logs.set(
				JOB_ID,
				logOf(`::dokploy-release::${Buffer.from("nope").toString("base64")}`),
			);
			expectRefused(await run(notJson), "manifest-invalid", true);
		});
		it("ignores a marker that is only echoed inside a command, indented or in a debug line", async () => {
			const w = quotaWorld();
			w.state.logs.set(
				JOB_ID,
				logOf(
					`echo "${marker(manifest())}"`,
					`  ${marker(manifest())}`,
					`##[debug]${marker(manifest())}`,
				),
			);
			expectRefused(await run(w), "artifact-missing", false);
		});
		it("reads a marker line without a timestamp, with CRLF and after a byte order mark", async () => {
			const w = quotaWorld();
			w.state.logs.set(JOB_ID, `﻿runner line\r\n${marker(manifest())}\r\n`);
			expect((await run(w)).kind).toBe("accepted");
		});
	});
});
