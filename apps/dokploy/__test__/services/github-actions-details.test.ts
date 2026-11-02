import {
	type BuildOriginDeploymentRow,
	describeGithubActionsRollback,
	describeGithubActionsRun,
	describeImageReference,
	describeServiceBuild,
	extractComposeImages,
	githubActionsPushTarget,
	githubCommitUrl,
	parseGithubActionsTitle,
	renderBuildStartMarker,
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

	test("a rollback names the environment and the commit it goes back to", () => {
		expect(
			parseGithubActionsTitle("GHA rollback production to A1B2C3D4 [run 7]"),
		).toEqual({
			buildEnvironment: "production",
			buildCommitSha: "a1b2c3d4",
			buildRunId: "7",
		});
	});

	test("a rollback without a named commit has none", () => {
		expect(parseGithubActionsTitle("GHA rollback production")).toEqual({
			buildEnvironment: "production",
			buildCommitSha: null,
			buildRunId: null,
		});
	});

	test("a rollback title without an environment does not read 'rollback' or 'to' as one", () => {
		expect(
			parseGithubActionsTitle("GHA rollback: redeploy the last good image"),
		).toEqual({
			buildEnvironment: null,
			buildCommitSha: null,
			buildRunId: null,
		});
		expect(parseGithubActionsTitle("GHA rollback to a1b2c3d4")).toEqual({
			buildEnvironment: null,
			buildCommitSha: "a1b2c3d4",
			buildRunId: null,
		});
	});

	test("a title that only looks like a rollback is read as a deploy", () => {
		// Same case rules as isGithubActionsRollbackTitle: lower-case "rollback" after "GHA " only.
		expect(
			parseGithubActionsTitle("GHA Rollback production to a1b2c3d4"),
		).toEqual({
			buildEnvironment: "Rollback",
			buildCommitSha: null,
			buildRunId: null,
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
			buildRolledBack: false,
		});
	});

	test("falls back to the creation time while the deployment has not finished", () => {
		const out = describeServiceBuild(
			[row({ title: TITLE, status: "running", buildOrigin: "github-actions" })],
			app,
		);
		expect(out.buildDeployedAt).toBe("2026-11-02T10:00:00.000Z");
	});

	describe("after the action's rollback deploy", () => {
		// A deployed and ran, B deployed and finished "done" but failed its health check, then the action
		// deployed "GHA rollback production to A": A is what runs now.
		const A = row({
			title: "GHA production 11111111 [run 1]",
			createdAt: "2026-11-02T09:00:00.000Z",
			finishedAt: "2026-11-02T09:02:00.000Z",
			buildOrigin: "github-actions",
			buildRunUrl: "https://github.com/DevinoSolutions/caly-mcp/actions/runs/1",
		});
		const B = row({
			title: TITLE,
			createdAt: "2026-11-02T10:00:00.000Z",
			finishedAt: "2026-11-02T10:02:00.000Z",
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
		});
		const rollback = (overrides: Partial<BuildOriginDeploymentRow> = {}) =>
			row({
				title: "GHA rollback production to 11111111",
				createdAt: "2026-11-02T12:00:00.000Z",
				finishedAt: "2026-11-02T12:01:00.000Z",
				buildOrigin: "github-actions",
				...overrides,
			});

		test("shows the rolled-back commit and time, and keeps the build row's run link", () => {
			const out = describeServiceBuild([A, B, rollback()], app);
			expect(out.buildOrigin).toBe("github-actions");
			expect(out.buildCommitSha).toBe("11111111");
			expect(out.buildDeployedAt).toBe("2026-11-02T12:01:00.000Z");
			expect(out.buildEnvironment).toBe("production");
			expect(out.buildRunUrl).toBe(RUN);
			expect(out.buildRepository).toBe("DevinoSolutions/caly-mcp");
			expect(out.buildRunId).toBe("41376332164");
			expect(out.buildRolledBack).toBe(true);
		});

		test("has no commit when the rollback title names none", () => {
			const out = describeServiceBuild(
				[
					A,
					B,
					rollback({ title: "GHA rollback: redeploy the last good image" }),
				],
				app,
			);
			expect(out.buildCommitSha).toBeNull();
			expect(out.buildDeployedAt).toBe("2026-11-02T12:01:00.000Z");
			// 'rollback' is not an environment; the build row's is kept.
			expect(out.buildEnvironment).toBe("production");
			expect(out.buildRolledBack).toBe(true);
		});

		test("ignores a rollback that has not finished", () => {
			const out = describeServiceBuild(
				[A, B, rollback({ status: "running", finishedAt: null })],
				app,
			);
			expect(out.buildCommitSha).toBe("b4f509d2");
			expect(out.buildDeployedAt).toBe("2026-11-02T10:02:00.000Z");
			expect(out.buildRolledBack).toBe(false);
		});

		test("a deploy after the rollback takes over again", () => {
			const C = row({
				title: "GHA production 33333333 [run 3]",
				createdAt: "2026-11-02T13:00:00.000Z",
				finishedAt: "2026-11-02T13:02:00.000Z",
				buildOrigin: "github-actions",
				buildRunUrl:
					"https://github.com/DevinoSolutions/caly-mcp/actions/runs/3",
			});
			const out = describeServiceBuild([A, B, rollback(), C], app);
			expect(out.buildCommitSha).toBe("33333333");
			expect(out.buildDeployedAt).toBe("2026-11-02T13:02:00.000Z");
			expect(out.buildRolledBack).toBe(false);
		});

		test("a failed rollback deploy does not count as rolled back", () => {
			const out = describeServiceBuild(
				[A, B, rollback({ status: "error" })],
				app,
			);
			expect(out.buildCommitSha).toBe("b4f509d2");
			expect(out.buildRolledBack).toBe(false);
		});

		test("a deploy that never rolled back is not flagged", () => {
			expect(describeServiceBuild([A, B], app).buildRolledBack).toBe(false);
		});

		test("a service with only a rollback describes that rollback", () => {
			const out = describeServiceBuild([rollback()], app);
			expect(out.buildOrigin).toBe("github-actions");
			expect(out.buildCommitSha).toBe("11111111");
			expect(out.buildDeployedAt).toBe("2026-11-02T12:01:00.000Z");
			expect(out.buildRolledBack).toBe(true);
		});
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
			buildRolledBack: false,
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

describe("describeGithubActionsRollback", () => {
	test("names the commit and the run", () => {
		expect(
			describeGithubActionsRollback({
				buildCommitSha: "11111111",
				buildRunId: "41376332164",
			}),
		).toBe(
			"Rolled back to 1111111 after run #41376332164 failed its checks. The run has the details.",
		);
	});

	test("leaves out the commit when the rollback title names none", () => {
		expect(
			describeGithubActionsRollback({
				buildCommitSha: null,
				buildRunId: "7",
			}),
		).toBe(
			"Rolled back after run #7 failed its checks. The run has the details.",
		);
	});

	test("does not invent a run number", () => {
		expect(describeGithubActionsRollback({ buildCommitSha: "abcdef12" })).toBe(
			"Rolled back to abcdef1 after the latest run failed its checks. The run has the details.",
		);
	});
});

describe("renderBuildStartMarker", () => {
	const STORED = "--- Dokploy: the build of dep-8f3a2c starts here ---";

	test("reads 'Dokploy: pull and start' for a deployment built in GitHub Actions", () => {
		expect(renderBuildStartMarker(STORED, true)).toBe(
			"Dokploy: pull and start",
		);
	});

	test("keeps a marker without the internal id for any other deployment", () => {
		const out = renderBuildStartMarker(STORED, false);
		expect(out).toBe("--- Dokploy: the build starts here ---");
		expect(out).not.toContain("dep-8f3a2c");
	});

	test("still reads a stored log with leading or trailing whitespace", () => {
		expect(renderBuildStartMarker(`  ${STORED}  `, true)).toBe(
			"Dokploy: pull and start",
		);
	});

	test.each([
		"Cloning repository",
		"--- Dokploy: the build of  starts here ---",
		"echo '--- Dokploy: the build of dep-1 starts here ---'",
		"--- Dokploy: the build of dep-1 starts here --- and more",
	])("leaves other lines alone: %s", (line) => {
		expect(renderBuildStartMarker(line, true)).toBe(line);
		expect(renderBuildStartMarker(line, false)).toBe(line);
	});
});

describe("githubActionsPushTarget", () => {
	test("prefers the branch the service was set up with", () => {
		expect(
			githubActionsPushTarget({
				branch: " main ",
				buildRepository: "DevinoSolutions/caly-mcp",
			}),
		).toBe("main");
	});

	test("falls back to the repository, never to an environment", () => {
		expect(
			githubActionsPushTarget({
				branch: null,
				buildRepository: "DevinoSolutions/caly-mcp",
			}),
		).toBe("DevinoSolutions/caly-mcp");
		expect(
			githubActionsPushTarget({
				branch: "  ",
				buildRepository: "DevinoSolutions/caly-mcp",
			}),
		).toBe("DevinoSolutions/caly-mcp");
	});

	test("is null when nothing is known", () => {
		expect(githubActionsPushTarget({})).toBeNull();
		expect(
			githubActionsPushTarget({ branch: "", buildRepository: null }),
		).toBeNull();
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

	// T-12502: the panel would show the placeholder, not what runs.
	test("leaves out an image written with a variable", () => {
		const file = [
			"services:",
			"  web:",
			"    image: ghcr.io/o/web:${TAG}",
			"  api:",
			"    image: $API_IMAGE",
			'    image: "${REGISTRY:-ghcr.io}/o/api:1"',
			"  worker:",
			"    image: ghcr.io/o/worker:1",
			"",
		].join("\n");
		expect(extractComposeImages(file)).toEqual(["ghcr.io/o/worker:1"]);
	});

	test("is empty for no compose file or no image", () => {
		expect(extractComposeImages(null)).toEqual([]);
		expect(extractComposeImages("services:\n  web:\n    build: .\n")).toEqual(
			[],
		);
	});
});
