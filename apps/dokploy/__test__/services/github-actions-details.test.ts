import {
	type BuildOriginDeploymentRow,
	describeGithubActionsRun,
	describeImageReference,
	describeServiceBuild,
	extractComposeImages,
	githubCommitUrl,
	parseGithubActionsTitle,
	withGithubActionsRunDetails,
} from "@dokploy/server/services/build-origin";
import { describe, expect, test } from "vitest";

const RUN =
	"https://github.com/DevinoSolutions/caly-mcp/actions/runs/41376332164";
const TITLE = "GHA production b4f509d2 [run 41376332164]";

const row = (
	overrides: Partial<BuildOriginDeploymentRow>,
): BuildOriginDeploymentRow => ({
	title: "Manual deployment",
	status: "done",
	createdAt: "2026-11-02T10:00:00.000Z",
	buildOrigin: null,
	buildRunUrl: null,
	...overrides,
});

describe("parseGithubActionsTitle", () => {
	test("reads environment, commit and run id from the action's title", () => {
		expect(parseGithubActionsTitle(TITLE)).toEqual({
			buildEnvironment: "production",
			buildCommitSha: "b4f509d2",
			buildRunId: "41376332164",
		});
	});

	test("reads a title with a subject and a run attempt", () => {
		expect(
			parseGithubActionsTitle(
				"GHA staging 0A1B2C3D: fix the login redirect [run 99.2]",
			),
		).toEqual({
			buildEnvironment: "staging",
			buildCommitSha: "0a1b2c3d",
			buildRunId: "99",
		});
	});

	test("keeps the environment when the title has no commit", () => {
		expect(parseGithubActionsTitle("GHA production")).toEqual({
			buildEnvironment: "production",
			buildCommitSha: null,
			buildRunId: null,
		});
	});

	test("does not take a word after the environment for a commit", () => {
		expect(parseGithubActionsTitle("GHA production deadbeefcafe1234x")).toEqual(
			{
				buildEnvironment: "production",
				buildCommitSha: null,
				buildRunId: null,
			},
		);
		expect(parseGithubActionsTitle("GHA production release 1")).toEqual({
			buildEnvironment: "production",
			buildCommitSha: null,
			buildRunId: null,
		});
	});

	test("a title that is only a commit has no environment", () => {
		expect(parseGithubActionsTitle("GHA b4f509d2")).toEqual({
			buildEnvironment: null,
			buildCommitSha: "b4f509d2",
			buildRunId: null,
		});
	});

	test("a rollback names the environment and no commit", () => {
		expect(
			parseGithubActionsTitle("GHA rollback production to a1b2c3d4 [run 7]"),
		).toEqual({
			buildEnvironment: "production",
			buildCommitSha: null,
			buildRunId: "7",
		});
	});

	test.each([
		["a manual deployment", "Manual deployment"],
		["a git commit title", "Commit: b4f509d2aa"],
		["no marker, lower case", "gha-ish production b4f509d2"],
		["empty", ""],
		["null", null],
		["undefined", undefined],
	])("returns nothing for %s", (_name, title) => {
		expect(parseGithubActionsTitle(title)).toEqual({
			buildEnvironment: null,
			buildCommitSha: null,
			buildRunId: null,
		});
	});
});

describe("describeGithubActionsRun", () => {
	test("takes the repository and run id from the run link, the rest from the title", () => {
		expect(
			describeGithubActionsRun({ title: TITLE, buildRunUrl: RUN }),
		).toEqual({
			buildRepository: "DevinoSolutions/caly-mcp",
			buildCommitSha: "b4f509d2",
			buildEnvironment: "production",
			buildRunId: "41376332164",
		});
	});

	test("an older row without a run link has no repository but keeps the title's run id", () => {
		expect(describeGithubActionsRun({ title: TITLE })).toEqual({
			buildRepository: null,
			buildCommitSha: "b4f509d2",
			buildEnvironment: "production",
			buildRunId: "41376332164",
		});
	});

	test("the run link wins over a run id in the title", () => {
		expect(
			describeGithubActionsRun({
				title: "GHA production b4f509d2 [run 1]",
				buildRunUrl: `${RUN}/attempts/2`,
			}).buildRunId,
		).toBe("41376332164");
	});

	test("ignores a run link that is not a GitHub Actions run", () => {
		expect(
			describeGithubActionsRun({
				title: TITLE,
				buildRunUrl: "https://evil.example/o/r/actions/runs/1",
			}).buildRepository,
		).toBeNull();
	});
});

describe("withGithubActionsRunDetails", () => {
	test("fills the details of GitHub Actions rows and nulls the others", () => {
		const rows = withGithubActionsRunDetails([
			{
				title: TITLE,
				buildOrigin: "github-actions",
				buildRunUrl: RUN,
				id: 1,
			},
			{ title: TITLE, buildOrigin: null, buildRunUrl: null, id: 2 },
			{ title: TITLE, buildOrigin: "external", buildRunUrl: null, id: 3 },
			{
				title: "Manual deployment",
				buildOrigin: null,
				buildRunUrl: null,
				id: 4,
			},
		]);
		expect(rows[0]).toMatchObject({
			id: 1,
			buildRepository: "DevinoSolutions/caly-mcp",
			buildCommitSha: "b4f509d2",
			buildEnvironment: "production",
			buildRunId: "41376332164",
		});
		// A row from before the column existed: read from its title.
		expect(rows[1]).toMatchObject({
			id: 2,
			buildRepository: null,
			buildCommitSha: "b4f509d2",
			buildRunId: "41376332164",
		});
		// A stored non-GitHub origin is respected even with a "GHA " title.
		expect(rows[2]).toMatchObject({
			id: 3,
			buildRepository: null,
			buildCommitSha: null,
			buildEnvironment: null,
			buildRunId: null,
		});
		expect(rows[3]).toMatchObject({ id: 4, buildCommitSha: null });
	});

	test("keeps every other column of the row", () => {
		const [out] = withGithubActionsRunDetails([
			{
				title: TITLE,
				buildOrigin: "github-actions",
				buildRunUrl: RUN,
				status: "done",
			},
		]);
		expect(out?.status).toBe("done");
		expect(out?.buildRunUrl).toBe(RUN);
	});
});

describe("describeServiceBuild", () => {
	const app = { kind: "application", sourceType: "docker" } as const;

	test("describes the latest done GitHub Actions deployment", () => {
		const out = describeServiceBuild(
			[
				row({
					title: "GHA production 11111111 [run 1]",
					createdAt: "2026-11-01T10:00:00.000Z",
					finishedAt: "2026-11-01T10:05:00.000Z",
					buildOrigin: "github-actions",
					buildRunUrl:
						"https://github.com/DevinoSolutions/caly-mcp/actions/runs/1",
				}),
				row({
					title: TITLE,
					createdAt: "2026-11-02T10:00:00.000Z",
					finishedAt: "2026-11-02T10:02:00.000Z",
					buildOrigin: "github-actions",
					buildRunUrl: RUN,
				}),
				row({
					title: "GHA production 33333333 [run 3]",
					status: "error",
					createdAt: "2026-11-02T11:00:00.000Z",
					buildOrigin: "github-actions",
				}),
			],
			app,
		);
		expect(out).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
			buildRepository: "DevinoSolutions/caly-mcp",
			buildCommitSha: "b4f509d2",
			buildEnvironment: "production",
			buildRunId: "41376332164",
			buildDeployedAt: "2026-11-02T10:02:00.000Z",
		});
	});

	test("falls back to the creation time while the deployment has not finished", () => {
		const out = describeServiceBuild(
			[row({ title: TITLE, status: "running", buildOrigin: "github-actions" })],
			app,
		);
		expect(out.buildDeployedAt).toBe("2026-11-02T10:00:00.000Z");
	});

	test("skips the action's rollback deploy for the details", () => {
		const out = describeServiceBuild(
			[
				row({
					title: TITLE,
					createdAt: "2026-11-02T10:00:00.000Z",
					buildOrigin: "github-actions",
					buildRunUrl: RUN,
				}),
				row({
					title: "GHA rollback production to 11111111",
					createdAt: "2026-11-02T12:00:00.000Z",
					buildOrigin: "github-actions",
				}),
			],
			app,
		);
		expect(out.buildCommitSha).toBe("b4f509d2");
		expect(out.buildRunUrl).toBe(RUN);
	});

	test("reads an older row that has only the title", () => {
		const out = describeServiceBuild([row({ title: TITLE })], app);
		expect(out.buildOrigin).toBe("github-actions");
		expect(out.buildRepository).toBeNull();
		expect(out.buildCommitSha).toBe("b4f509d2");
		expect(out.buildRunId).toBe("41376332164");
	});

	test("has no details for a service that is not built in GitHub Actions", () => {
		const empty = {
			buildRepository: null,
			buildCommitSha: null,
			buildEnvironment: null,
			buildRunId: null,
			buildDeployedAt: null,
		};
		expect(
			describeServiceBuild([row({ title: "Manual deployment" })], app),
		).toEqual({ buildOrigin: "external", buildRunUrl: null, ...empty });
		expect(describeServiceBuild([], app)).toEqual({
			buildOrigin: "external",
			buildRunUrl: null,
			...empty,
		});
		// A git-source application is built by Dokploy whatever its old titles say.
		expect(
			describeServiceBuild([row({ title: TITLE })], {
				kind: "application",
				sourceType: "github",
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null, ...empty });
	});

	test("works for a raw compose without a build section", () => {
		const out = describeServiceBuild(
			[row({ title: TITLE, buildOrigin: "github-actions", buildRunUrl: RUN })],
			{ kind: "compose", sourceType: "raw", hasBuildSection: false },
		);
		expect(out.buildRepository).toBe("DevinoSolutions/caly-mcp");
	});
});

describe("githubCommitUrl", () => {
	test("links a commit of a known repository", () => {
		expect(githubCommitUrl("DevinoSolutions/caly-mcp", "b4f509d2")).toBe(
			"https://github.com/DevinoSolutions/caly-mcp/commit/b4f509d2",
		);
	});

	test("is null without a repository or with a bad sha", () => {
		expect(githubCommitUrl(null, "b4f509d2")).toBeNull();
		expect(githubCommitUrl("o/r", null)).toBeNull();
		expect(githubCommitUrl("o/r", "../../etc")).toBeNull();
	});
});

describe("describeImageReference", () => {
	const DIGEST =
		"e31c0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d";

	test("shortens a digest-pinned image behind a local registry path", () => {
		const reference = `localhost:5000/registry.devino.ca/caly-mcp@sha256:${DIGEST}`;
		expect(describeImageReference(reference)).toEqual({
			name: "caly-mcp",
			shortDigest: "sha256:e31c0a1b2c3d",
			tag: null,
			label: "caly-mcp @ sha256:e31c0a1b2c3d",
			reference,
		});
	});

	test("keeps a tag when there is no digest", () => {
		expect(
			describeImageReference("ghcr.io/devinosolutions/caly-mcp:1.4.2")?.label,
		).toBe("caly-mcp:1.4.2");
	});

	test("does not take a registry port for a tag", () => {
		expect(describeImageReference("localhost:5000/app")?.label).toBe("app");
		expect(describeImageReference("registry:5000/team/app")?.tag).toBeNull();
	});

	test("a tag plus a digest shows the digest", () => {
		expect(describeImageReference(`caly-mcp:1.0@sha256:${DIGEST}`)?.label).toBe(
			"caly-mcp @ sha256:e31c0a1b2c3d",
		);
	});

	test("a bare name stays as it is, a malformed digest is not shortened", () => {
		expect(describeImageReference("nginx")?.label).toBe("nginx");
		expect(describeImageReference("app@sha256:xyz")?.shortDigest).toBeNull();
	});

	test("is null for nothing", () => {
		expect(describeImageReference("")).toBeNull();
		expect(describeImageReference("   ")).toBeNull();
		expect(describeImageReference(null)).toBeNull();
	});
});

describe("extractComposeImages", () => {
	test("lists the image of each service once", () => {
		const file = [
			"services:",
			"  web:",
			"    image: ghcr.io/o/web@sha256:abc",
			"  worker:",
			'    image: "ghcr.io/o/worker:1"',
			"  web2:",
			"    image: ghcr.io/o/web@sha256:abc # same",
			"",
		].join("\n");
		expect(extractComposeImages(file)).toEqual([
			"ghcr.io/o/web@sha256:abc",
			"ghcr.io/o/worker:1",
		]);
	});

	test("is empty for no compose file or no image", () => {
		expect(extractComposeImages(null)).toEqual([]);
		expect(extractComposeImages("services:\n  web:\n    build: .\n")).toEqual(
			[],
		);
	});
});
