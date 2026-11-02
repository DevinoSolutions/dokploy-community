import {
	buildOriginJobFields,
	canonicalBuildRunUrl,
	describeGithubActionsRun,
	describeLiveGithubBuild,
	describeServiceBuild,
	isGithubActionsDeployment,
	isLiveGithubBuild,
	parseBuildRunUrl,
	pickServiceBuildOrigin,
	withGithubActionsRunDetails,
} from "@dokploy/server/services/build-origin-shared";
import { describe, expect, it } from "vitest";

/** The pure helpers behind live GitHub Actions rows (T-12686). */

const RUN = "https://github.com/acme/web/actions/runs/42";

describe("run link helpers", () => {
	it("splits a link into repository, run and attempt", () => {
		expect(parseBuildRunUrl(RUN)).toEqual({
			repository: "acme/web",
			runId: "42",
			attempt: null,
		});
		expect(parseBuildRunUrl(`${RUN}/attempts/3?x=1`)).toEqual({
			repository: "acme/web",
			runId: "42",
			attempt: "3",
		});
		expect(
			parseBuildRunUrl("https://example.com/acme/web/actions/runs/42"),
		).toBeNull();
		expect(parseBuildRunUrl(undefined)).toBeNull();
	});

	it("keeps the attempt but drops a job, the query and the fragment", () => {
		expect(canonicalBuildRunUrl(`${RUN}/job/99?pr=1#a`)).toBe(RUN);
		expect(canonicalBuildRunUrl(`${RUN}/attempts/2/`)).toBe(
			`${RUN}/attempts/2`,
		);
		expect(canonicalBuildRunUrl("nope")).toBeNull();
	});
});

describe("isLiveGithubBuild", () => {
	const live = {
		status: "running",
		buildOrigin: "github-actions",
		buildRunStatus: "in_progress",
	};

	it("is a running GitHub Actions row that still waits for its run", () => {
		expect(isLiveGithubBuild(live)).toBe(true);
		expect(isLiveGithubBuild({ ...live, buildRunStatus: "queued" })).toBe(true);
	});

	it.each([
		["a row a deploy took over", { buildRunStatus: "completed" }],
		["a row with no run state", { buildRunStatus: null }],
		["a finished row", { status: "done" }],
		["a row Dokploy built", { buildOrigin: "dokploy" }],
		["a row with no origin", { buildOrigin: null }],
	])("is not %s", (_name, overrides) => {
		expect(isLiveGithubBuild({ ...live, ...overrides })).toBe(false);
	});
});

describe("describeLiveGithubBuild", () => {
	const live = {
		status: "running",
		buildOrigin: "github-actions",
		buildRunStatus: "in_progress",
		buildRunStep: "build · Build image (3/7)",
	};

	it("says what runs now", () => {
		expect(describeLiveGithubBuild(live)).toBe(
			"Building on GitHub Actions · build · Build image (3/7)",
		);
	});

	it("falls back to the state when no step is known", () => {
		expect(describeLiveGithubBuild({ ...live, buildRunStep: null })).toBe(
			"Building on GitHub Actions",
		);
		expect(
			describeLiveGithubBuild({
				...live,
				buildRunStatus: "queued",
				buildRunStep: "  ",
			}),
		).toBe("Waiting for GitHub Actions to start");
	});

	it("says nothing for a row that does not wait for its run", () => {
		expect(describeLiveGithubBuild({ ...live, status: "done" })).toBeNull();
		// A deploy took the row over: it is a deploy row now.
		expect(
			describeLiveGithubBuild({ ...live, buildRunStatus: "completed" }),
		).toBeNull();
	});

	it("says the deploy waits in the queue once a deploy call was accepted, whatever the run did", () => {
		expect(
			describeLiveGithubBuild({
				...live,
				externalBuildOnly: true,
				deployQueuedAt: "2026-11-02T10:30:00.000Z",
			}),
		).toBe(
			"GitHub Actions build finished · deploy waiting in the Dokploy queue",
		);
		// A deploy that took the row over is a deploy row: nothing more to say.
		expect(
			describeLiveGithubBuild({
				...live,
				buildRunStatus: "completed",
				externalBuildOnly: false,
				deployQueuedAt: "2026-11-02T10:30:00.000Z",
			}),
		).toBeNull();
	});

	it("says the deploy is awaited when the run is over and nothing took the row over", () => {
		expect(
			describeLiveGithubBuild({
				...live,
				buildRunStatus: "completed",
				externalBuildOnly: true,
			}),
		).toBe("GitHub Actions run finished · waiting for the deploy");
	});
});

describe("the deploy job carries the live row", () => {
	it("keeps a trimmed deploymentId next to the origin fields", () => {
		expect(
			buildOriginJobFields({
				buildOrigin: "github-actions",
				buildRunUrl: RUN,
				deploymentId: "  dep-1 ",
			}),
		).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
			deploymentId: "dep-1",
		});
	});

	it("leaves it out when empty or absent", () => {
		expect(buildOriginJobFields({ deploymentId: "  " })).toEqual({});
		expect(buildOriginJobFields({})).toEqual({});
		expect(buildOriginJobFields({ deploymentId: null })).toEqual({});
	});
});

describe("what a row stored wins over what the link and title say", () => {
	it("uses the stored repository, commit and run when there are some", () => {
		expect(
			describeGithubActionsRun({
				title: "GHA production 1a2b3c4d: subject [run 7.1]",
				buildRunUrl: RUN,
				buildRepository: "acme/stored",
				buildCommitSha: "ABCDEF0123456789",
				buildRunId: "99",
			}),
		).toEqual({
			buildRepository: "acme/stored",
			buildCommitSha: "abcdef0123456789",
			buildEnvironment: "production",
			buildRunId: "99",
		});
	});

	it("derives them as before when nothing was stored", () => {
		expect(
			describeGithubActionsRun({
				title: "GHA production 1a2b3c4d: subject",
				buildRunUrl: RUN,
				buildRepository: null,
				buildCommitSha: null,
				buildRunId: null,
			}),
		).toEqual({
			buildRepository: "acme/web",
			buildCommitSha: "1a2b3c4d",
			buildEnvironment: "production",
			buildRunId: "42",
		});
	});

	it("reaches the deployment lists", () => {
		const [row] = withGithubActionsRunDetails([
			{
				title: "GHA production",
				buildOrigin: "github-actions",
				buildRunUrl: RUN,
				buildRepository: "acme/web",
				buildCommitSha: "abcdef0123456789",
				buildRunId: "42",
				buildRunStatus: "in_progress",
			},
		]);
		expect(row).toMatchObject({
			buildCommitSha: "abcdef0123456789",
			buildRunStatus: "in_progress",
		});
	});

	it("counts a live row as a GitHub Actions deployment whatever its title says", () => {
		expect(
			isGithubActionsDeployment({
				buildOrigin: "github-actions",
				title: "Deploy",
			}),
		).toBe(true);
	});
});

describe("rows that only follow a GitHub build say nothing about what runs", () => {
	const source = {
		kind: "application",
		sourceType: "docker",
	} as const;
	const deployed = {
		title: "GHA production 1a2b3c4d: shipped",
		status: "done",
		createdAt: "2026-11-02T09:00:00.000Z",
		buildOrigin: "github-actions",
		buildRunUrl: "https://github.com/acme/web/actions/runs/41",
		externalBuildOnly: false,
	};
	const following = {
		title: "GHA production 5e6f7a8b: newer",
		status: "running",
		createdAt: "2026-11-02T10:00:00.000Z",
		buildOrigin: "github-actions",
		buildRunUrl: RUN,
		externalBuildOnly: true,
	};

	it("keeps the service-level run link on the last deploy", () => {
		expect(pickServiceBuildOrigin([following, deployed], source)).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: "https://github.com/acme/web/actions/runs/41",
		});
	});

	it("describes the deployed run, not the one still building", () => {
		const described = describeServiceBuild([following, deployed], source);
		expect(described.buildRunUrl).toBe(
			"https://github.com/acme/web/actions/runs/41",
		);
	});

	it("counts the row once a deploy took it over", () => {
		expect(
			pickServiceBuildOrigin(
				[{ ...following, status: "done", externalBuildOnly: false }, deployed],
				source,
			).buildRunUrl,
		).toBe(RUN);
	});
});
