import {
	type BuildOriginDeploymentRow,
	canRedeployFromGithubActionsRun,
	deploymentImageReference,
	describeDeploymentDuration,
	describeGithubActionsAttempt,
	describeGithubActionsRollback,
	describeGithubActionsRun,
	describeGithubActionsRunState,
	describeGithubActionsSource,
	describeGithubActionsTitle,
	describeImageReference,
	describeServiceBuild,
	displayDeploymentTitle,
	extractComposeImages,
	githubActionsBranch,
	githubActionsPushTarget,
	githubCommitUrl,
	parseGithubActionsTitle,
	pickNewerLiveGithubDeployment,
	pickServingDeployment,
	presentGithubActionsTitle,
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
			buildRollbackRunId: null,
			buildRollbackFailure: null,
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

		describe("which run the rollback line blames", () => {
			const failedB = (overrides: Partial<BuildOriginDeploymentRow> = {}) =>
				row({
					title: TITLE,
					status: "error",
					createdAt: "2026-11-02T10:00:00.000Z",
					finishedAt: "2026-11-02T10:01:00.000Z",
					buildOrigin: "github-actions",
					buildRunUrl: RUN,
					...overrides,
				});

			test("blames the run that deployed and then failed its checks", () => {
				const out = describeServiceBuild([A, B, rollback()], app);
				expect(out.buildRollbackRunId).toBe("41376332164");
				expect(out.buildRollbackFailure).toBe("checks");
			});

			test("blames the run whose deploy errored, not the healthy run before it", () => {
				const out = describeServiceBuild([A, failedB(), rollback()], app);
				expect(out.buildRolledBack).toBe(true);
				expect(out.buildRollbackRunId).toBe("41376332164");
				expect(out.buildRollbackFailure).toBe("deploy");
				// The commit is the rollback's and the run link stays the newest done build row's.
				expect(out.buildCommitSha).toBe("11111111");
				expect(out.buildRunId).toBe("1");
			});

			test("blames a cancelled deploy the same way", () => {
				const out = describeServiceBuild(
					[A, failedB({ status: "cancelled" }), rollback()],
					app,
				);
				expect(out.buildRollbackRunId).toBe("41376332164");
				expect(out.buildRollbackFailure).toBe("deploy");
			});

			test("names no run when the refused deploy left no row and the rollback title has none", () => {
				const out = describeServiceBuild([A, rollback()], app);
				expect(out.buildRolledBack).toBe(true);
				expect(out.buildRollbackRunId).toBeNull();
				expect(out.buildRollbackFailure).toBe("deploy");
			});

			test("reads the run from the rollback title when no failed row exists", () => {
				const out = describeServiceBuild(
					[
						A,
						rollback({
							title: "GHA rollback production to 11111111 [run 77.1]",
						}),
					],
					app,
				);
				expect(out.buildRollbackRunId).toBe("77");
				expect(out.buildRollbackFailure).toBe("deploy");
			});

			test("the failed deployment's row wins over the rollback title", () => {
				const out = describeServiceBuild(
					[
						A,
						failedB(),
						rollback({ title: "GHA rollback production to 11111111 [run 77]" }),
					],
					app,
				);
				expect(out.buildRollbackRunId).toBe("41376332164");
			});

			test("a rollback title that names no commit blames the newest earlier GitHub Actions run", () => {
				const out = describeServiceBuild(
					[
						A,
						B,
						rollback({ title: "GHA rollback: redeploy the last good image" }),
					],
					app,
				);
				expect(out.buildRollbackRunId).toBe("41376332164");
				expect(out.buildRollbackFailure).toBe("checks");
			});

			test("a row created after the rollback is not blamed", () => {
				const later = row({
					title: "GHA production 33333333 [run 9]",
					status: "error",
					createdAt: "2026-11-02T13:00:00.000Z",
					buildOrigin: "github-actions",
				});
				const out = describeServiceBuild([A, B, rollback(), later], app);
				expect(out.buildRollbackRunId).toBe("41376332164");
			});

			test("has no cause when nothing was rolled back", () => {
				const out = describeServiceBuild([A, B], app);
				expect(out.buildRollbackRunId).toBeNull();
				expect(out.buildRollbackFailure).toBeNull();
			});
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
			buildRollbackRunId: null,
			buildRollbackFailure: null,
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
				buildRollbackRunId: "41376332164",
				buildRollbackFailure: "checks",
			}),
		).toBe(
			"Rolled back to 1111111 after run #41376332164 failed its checks. The run has the details.",
		);
	});

	test("leaves out the commit when the rollback title names none", () => {
		expect(
			describeGithubActionsRollback({
				buildCommitSha: null,
				buildRollbackRunId: "7",
				buildRollbackFailure: "checks",
			}),
		).toBe(
			"Rolled back after run #7 failed its checks. The run has the details.",
		);
	});

	test("says the deploy failed when it never reached its checks", () => {
		expect(
			describeGithubActionsRollback({
				buildCommitSha: "11111111",
				buildRollbackRunId: "41376332164",
				buildRollbackFailure: "deploy",
			}),
		).toBe(
			"Rolled back to 1111111 after run #41376332164 failed to deploy. The run has the details.",
		);
		expect(
			describeGithubActionsRollback({
				buildCommitSha: null,
				buildRollbackRunId: null,
				buildRollbackFailure: "deploy",
			}),
		).toBe(
			"Rolled back after the latest run failed to deploy. The run has the details.",
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
				sourceType: "github",
				buildRepository: "DevinoSolutions/caly-mcp",
			}),
		).toBe("main");
	});

	test.each(["github", "gitlab", "bitbucket", "gitea", "git"])(
		"uses the branch of a %s source",
		(sourceType) => {
			expect(
				githubActionsPushTarget({
					branch: "release",
					sourceType,
					buildRepository: "o/r",
				}),
			).toBe("release");
		},
	);

	// T-12502: a docker-source service keeps the branch of an earlier git setup; it must not win.
	test.each(["docker", "drop", "raw", null, undefined])(
		"ignores a leftover branch when the source is %s",
		(sourceType) => {
			expect(
				githubActionsPushTarget({
					branch: "main",
					sourceType,
					buildRepository: "DevinoSolutions/caly-mcp",
				}),
			).toBe("DevinoSolutions/caly-mcp");
		},
	);

	test("is null for a leftover branch when the repository is unknown", () => {
		expect(
			githubActionsPushTarget({ branch: "main", sourceType: "docker" }),
		).toBeNull();
	});

	test("falls back to the repository, never to an environment", () => {
		expect(
			githubActionsPushTarget({
				branch: null,
				sourceType: "github",
				buildRepository: "DevinoSolutions/caly-mcp",
			}),
		).toBe("DevinoSolutions/caly-mcp");
		expect(
			githubActionsPushTarget({
				branch: "  ",
				sourceType: "github",
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

describe("describeGithubActionsTitle", () => {
	test("reads the commit subject and the run attempt", () => {
		expect(
			describeGithubActionsTitle(
				"GHA production b4f509d2: fix: login redirect [run 41376332164.2]",
			),
		).toEqual({ subject: "fix: login redirect", attempt: "2" });
	});

	test("has no subject for a bare title and no attempt without one", () => {
		expect(describeGithubActionsTitle(TITLE)).toEqual({
			subject: null,
			attempt: null,
		});
		expect(
			describeGithubActionsTitle("GHA production b4f509d2: ship it"),
		).toEqual({ subject: "ship it", attempt: null });
	});

	test("reads only the first line", () => {
		expect(
			describeGithubActionsTitle("GHA staging aaaaaaaa: first\nsecond: line"),
		).toEqual({ subject: "first", attempt: null });
	});

	test("is empty for a title without the marker and for no title", () => {
		const none = { subject: null, attempt: null };
		expect(describeGithubActionsTitle("Manual deployment: x")).toEqual(none);
		expect(describeGithubActionsTitle(null)).toEqual(none);
		expect(describeGithubActionsTitle(undefined)).toEqual(none);
	});
});

describe("describeGithubActionsRunState", () => {
	const base = { buildOrigin: "github-actions" };

	test("names the outcome of a finished row", () => {
		expect(
			describeGithubActionsRunState({ ...base, status: "done" }),
		).toMatchObject({ label: "Deployed", tone: "success", detail: null });
		expect(
			describeGithubActionsRunState({ ...base, status: "error" }),
		).toMatchObject({ label: "Failed", tone: "failed" });
		expect(
			describeGithubActionsRunState({ ...base, status: "cancelled" }),
		).toMatchObject({ label: "Cancelled", tone: "cancelled" });
		expect(
			describeGithubActionsRunState({ ...base, status: "running" }),
		).toMatchObject({ label: "Deploying", tone: "running" });
	});

	test("a finished row nothing deployed is a finished build, not a deploy", () => {
		expect(
			describeGithubActionsRunState({
				...base,
				status: "done",
				externalBuildOnly: true,
			}),
		).toMatchObject({ label: "Build finished", tone: "success" });
	});

	test("a row the deploy call took over is Deploying", () => {
		expect(
			describeGithubActionsRunState({
				...base,
				status: "running",
				buildRunStatus: "completed",
				externalBuildOnly: false,
			}),
		).toMatchObject({ label: "Deploying", tone: "running" });
	});

	test("a row that still waits for its run carries the live step", () => {
		expect(
			describeGithubActionsRunState({
				...base,
				status: "running",
				buildRunStatus: "in_progress",
				buildRunStep: "build · Build image (3/7)",
			}),
		).toEqual({
			label: "In progress",
			tone: "running",
			detail: "Building on GitHub Actions · build · Build image (3/7)",
		});
	});

	test("keeps an unknown status readable", () => {
		expect(describeGithubActionsRunState({ status: "weird" })).toMatchObject({
			label: "weird",
			tone: "unknown",
		});
		expect(describeGithubActionsRunState({})).toMatchObject({
			label: "Unknown",
			tone: "unknown",
		});
	});
});

describe("pickServingDeployment", () => {
	test("is the newest finished deployment, a rollback included", () => {
		const rows = [
			row({
				title: "GHA rollback production to 1111111",
				createdAt: "2026-11-02T12:00:00.000Z",
			}),
			row({
				title: "newest, failed",
				status: "error",
				createdAt: "2026-11-02T13:00:00.000Z",
			}),
			row({ title: "older", createdAt: "2026-11-02T09:00:00.000Z" }),
		];
		expect(pickServingDeployment(rows)?.title).toBe(
			"GHA rollback production to 1111111",
		);
	});

	test("ignores rows that only follow a GitHub build and non-deploy runs", () => {
		const rows = [
			row({
				title: "following",
				externalBuildOnly: true,
				createdAt: "2026-11-02T13:00:00.000Z",
			}),
			row({
				title: "backup",
				backupId: "b1",
				createdAt: "2026-11-02T12:00:00.000Z",
			}),
			row({ title: "deploy", createdAt: "2026-11-02T10:00:00.000Z" }),
		];
		expect(pickServingDeployment(rows)?.title).toBe("deploy");
	});

	test("is null when nothing finished", () => {
		expect(pickServingDeployment([])).toBeNull();
		expect(pickServingDeployment([row({ status: "running" })])).toBeNull();
	});
});

describe("deploymentImageReference", () => {
	const digest = `sha256:${"a".repeat(64)}`;

	test("joins the repository of the pushed tag with the pinned digest", () => {
		expect(
			deploymentImageReference({
				imageTag: "localhost:5000/devino/app:abc123",
				imageDigest: digest,
			}),
		).toBe(`localhost:5000/devino/app@${digest}`);
		expect(
			deploymentImageReference({ imageTag: "app", imageDigest: digest }),
		).toBe(`app@${digest}`);
	});

	test("is null without a valid digest or without a tag", () => {
		expect(
			deploymentImageReference({ imageTag: "app:1", imageDigest: null }),
		).toBeNull();
		expect(
			deploymentImageReference({ imageTag: "app:1", imageDigest: "latest" }),
		).toBeNull();
		expect(
			deploymentImageReference({ imageTag: null, imageDigest: digest }),
		).toBeNull();
	});
});

describe("githubActionsBranch", () => {
	test("is the branch only for a git provider source", () => {
		expect(
			githubActionsBranch({ branch: " main ", sourceType: "github" }),
		).toBe("main");
		expect(
			githubActionsBranch({ branch: "main", sourceType: "docker" }),
		).toBeNull();
		expect(githubActionsBranch({ branch: "", sourceType: "git" })).toBeNull();
		expect(githubActionsBranch({})).toBeNull();
	});
});

describe("describeDeploymentDuration", () => {
	test("reads seconds and minutes", () => {
		expect(
			describeDeploymentDuration(
				"2026-11-02T10:00:00.000Z",
				"2026-11-02T10:00:45.900Z",
			),
		).toBe("45s");
		expect(
			describeDeploymentDuration(
				"2026-11-02T10:00:00.000Z",
				"2026-11-02T10:03:12.000Z",
			),
		).toBe("3m 12s");
	});

	test("is null until the deployment finished and for bad times", () => {
		expect(
			describeDeploymentDuration("2026-11-02T10:00:00.000Z", null),
		).toBeNull();
		expect(
			describeDeploymentDuration(null, "2026-11-02T10:00:00.000Z"),
		).toBeNull();
		expect(
			describeDeploymentDuration("nope", "2026-11-02T10:00:00.000Z"),
		).toBeNull();
		expect(
			describeDeploymentDuration(
				"2026-11-02T10:05:00.000Z",
				"2026-11-02T10:00:00.000Z",
			),
		).toBeNull();
	});
});

describe("canRedeployFromGithubActionsRun", () => {
	const base = {
		canDeploy: true,
		isServing: true,
		serviceBuildOrigin: "github-actions",
	};

	test("is offered on the serving row of a GitHub Actions service for a user who may deploy", () => {
		expect(canRedeployFromGithubActionsRun(base)).toBe(true);
	});

	test("is not offered once the service is built by Dokploy again, whatever its old rows say", () => {
		// A service switched back to a git provider keeps its finished GitHub Actions rows.
		expect(
			canRedeployFromGithubActionsRun({
				...base,
				serviceBuildOrigin: "dokploy",
			}),
		).toBe(false);
		expect(
			canRedeployFromGithubActionsRun({
				...base,
				serviceBuildOrigin: "external",
			}),
		).toBe(false);
		expect(
			canRedeployFromGithubActionsRun({ ...base, serviceBuildOrigin: null }),
		).toBe(false);
		expect(
			canRedeployFromGithubActionsRun({
				...base,
				serviceBuildOrigin: undefined,
			}),
		).toBe(false);
	});

	test("is not offered without deploy permission or on an older row", () => {
		expect(canRedeployFromGithubActionsRun({ ...base, canDeploy: false })).toBe(
			false,
		);
		expect(canRedeployFromGithubActionsRun({ ...base, isServing: false })).toBe(
			false,
		);
	});
});

describe("describeGithubActionsAttempt", () => {
	test("names only a re-run", () => {
		expect(describeGithubActionsAttempt("2")).toBe(" · attempt 2");
		expect(describeGithubActionsAttempt("12")).toBe(" · attempt 12");
		expect(describeGithubActionsAttempt("1")).toBe("");
		expect(describeGithubActionsAttempt(null)).toBe("");
		expect(describeGithubActionsAttempt(undefined)).toBe("");
		expect(describeGithubActionsAttempt("x")).toBe("");
	});
});

describe("describeGithubActionsSource", () => {
	test("says what happened to the image by how the row stands", () => {
		const text = (
			label: string,
			tone: Parameters<typeof describeGithubActionsSource>[0]["tone"],
		) => describeGithubActionsSource({ label, tone });
		expect(text("Deployed", "success")).toBe(
			"Built by GitHub Actions. Dokploy pulled the image and started it.",
		);
		expect(text("In progress", "running")).toBe(
			"Built by GitHub Actions. Dokploy will pull the image when the run finishes.",
		);
		expect(text("Deploying", "running")).toBe(
			"Built by GitHub Actions. Dokploy is pulling the image and starting it.",
		);
		expect(text("Failed", "failed")).toBe(
			"Built by GitHub Actions. The deployment ended in error.",
		);
		expect(text("Cancelled", "cancelled")).toBe(
			"Built by GitHub Actions. The deployment was cancelled.",
		);
		expect(text("Build finished", "success")).toBe(
			"Built by GitHub Actions. No deploy took this run over.",
		);
		expect(text("weird", "unknown")).toBe("Built by GitHub Actions.");
		expect(
			describeGithubActionsSource({
				label: "In progress",
				tone: "running",
				externalBuildOnly: true,
				deployQueuedAt: "2026-11-02T10:30:00.000Z",
			}),
		).toBe(
			"Build finished. Dokploy will pull the image when the deploy reaches the front of the queue.",
		);
		expect(
			describeGithubActionsSource({
				label: "In progress",
				tone: "running",
				externalBuildOnly: true,
				buildRunStatus: "completed",
			}),
		).toBe(
			"Build finished. Dokploy is waiting for the workflow's deploy call.",
		);
		// Still building: the run has not finished.
		expect(
			describeGithubActionsSource({
				label: "In progress",
				tone: "running",
				externalBuildOnly: true,
				buildRunStatus: "in_progress",
			}),
		).toBe(
			"Built by GitHub Actions. Dokploy will pull the image when the run finishes.",
		);
	});
});

describe("pickNewerLiveGithubDeployment", () => {
	const live = (id: string, createdAt: string) => ({
		deploymentId: id,
		createdAt,
		status: "running",
		buildOrigin: "github-actions",
		buildRunStatus: "in_progress",
		buildRunStep: "build",
	});
	const serving = {
		deploymentId: "serving",
		createdAt: "2026-11-02T10:00:00.000Z",
	};

	test("is a live row created after what runs now", () => {
		const rows = [
			live("newer", "2026-11-02T11:00:00.000Z"),
			{ ...serving, status: "done" },
		];
		expect(pickNewerLiveGithubDeployment(rows, serving)?.deploymentId).toBe(
			"newer",
		);
	});

	test("is not a live row older than what runs now, nor the row itself", () => {
		const rows = [
			live("older", "2026-11-02T09:00:00.000Z"),
			live("serving", "2026-11-02T10:00:00.000Z"),
		];
		expect(pickNewerLiveGithubDeployment(rows, serving)).toBeNull();
	});

	test("takes the newest of several, and any live row when nothing runs yet", () => {
		const rows = [
			live("a", "2026-11-02T11:00:00.000Z"),
			live("b", "2026-11-02T12:00:00.000Z"),
		];
		expect(pickNewerLiveGithubDeployment(rows, serving)?.deploymentId).toBe(
			"b",
		);
		// The modal passes the row it shows: a service whose only deployment is that live run has no newer one.
		const only = { deploymentId: "b", createdAt: "2026-11-02T12:00:00.000Z" };
		expect(pickNewerLiveGithubDeployment(rows, only)).toBeNull();
		expect(pickNewerLiveGithubDeployment(rows, null)?.deploymentId).toBe("b");
	});

	test("skips rows that are not live", () => {
		const rows = [{ ...live("x", "2026-11-02T12:00:00.000Z"), status: "done" }];
		expect(pickNewerLiveGithubDeployment(rows, serving)).toBeNull();
	});
});

describe("presentGithubActionsTitle (T-13877)", () => {
	test("drops the run suffix of a stored title", () => {
		const presented = presentGithubActionsTitle(
			"GHA production 61c3c874: Flag bulk-import rows whose time has passed as publish [run 41729774159.1]",
		);
		expect(presented?.text).toBe(
			"Flag bulk-import rows whose time has passed as publish (61c3c874)",
		);
		expect(presented).toMatchObject({
			environment: "production",
			sha: "61c3c874",
			run: "[run 41729774159.1]",
			rollback: false,
		});
	});

	test("a title without a subject, an uppercase sha and a subject's own brackets", () => {
		expect(
			presentGithubActionsTitle("GHA development 59F1F166 [run 41726493887.1]")
				?.text,
		).toBe("Deployed from GitHub Actions (59f1f166)");
		expect(
			presentGithubActionsTitle("GHA production b4f509d2: fix (#83)")?.text,
		).toBe("fix (#83) (b4f509d2)");
		expect(
			presentGithubActionsTitle("GHA production b4f509d2: fix (#83) [run 1.2]")
				?.text,
		).toBe("fix (#83) (b4f509d2)");
		expect(
			presentGithubActionsTitle("GHA production b4f509dxyz: x")?.text,
		).toBeUndefined();
	});

	test("only a numeric [run N.M] suffix is plumbing; a subject's own [run ...] stays", () => {
		expect(
			presentGithubActionsTitle("GHA production b4f509d2: ship [run 12.3]")
				?.text,
		).toBe("ship (b4f509d2)");
		expect(
			presentGithubActionsTitle("GHA production b4f509d2: ship [run 12]")?.text,
		).toBe("ship (b4f509d2)");
		expect(
			presentGithubActionsTitle("GHA production b4f509d2: ship [run tests]")
				?.text,
		).toBe("ship [run tests] (b4f509d2)");
	});

	test("the commit sha ends at a colon, a space or the end of the title", () => {
		expect(presentGithubActionsTitle("GHA production b4f509d2:ship")?.sha).toBe(
			"b4f509d2",
		);
		expect(presentGithubActionsTitle("GHA production b4f509d2")?.sha).toBe(
			"b4f509d2",
		);
		expect(
			presentGithubActionsTitle("GHA production b4f509d2-rc1: x")?.text,
		).toBeUndefined();
	});

	test("poller titles, with or without environment and sha, either suffix order", () => {
		expect(
			presentGithubActionsTitle("GHA staging abcdef12 [deployment #7]")?.text,
		).toBe("Deployed from GitHub Actions (abcdef12)");
		expect(
			presentGithubActionsTitle("GHA abcdef12 [deployment #7]")?.text,
		).toBe("Deployed from GitHub Actions (abcdef12)");
		expect(
			presentGithubActionsTitle("GHA production [deployment #7]")?.text,
		).toBe("Deployed from GitHub Actions");
		expect(
			presentGithubActionsTitle(
				"GHA production abcdef12: ship [deployment #7] [run 9.1]",
			),
		).toMatchObject({
			text: "ship (abcdef12)",
			run: "[deployment #7] [run 9.1]",
		});
		expect(
			presentGithubActionsTitle(
				"GHA production abcdef12: ship [run 9.1] [deployment #7]",
			)?.text,
		).toBe("ship (abcdef12)");
	});

	test("rollback titles", () => {
		expect(
			presentGithubActionsTitle(
				"GHA rollback production to 61c3c874 [run 41729774159.1]",
			),
		).toMatchObject({ text: "Rolled back to 61c3c874", rollback: true });
		expect(
			presentGithubActionsTitle("GHA rollback: redeploy the last image")?.text,
		).toBe("Rolled back");
	});

	test("leaves other titles alone", () => {
		expect(presentGithubActionsTitle("play: reads (#83) (390a3b6)")).toBeNull();
		expect(presentGithubActionsTitle("GHA production old")).toBeNull();
		expect(presentGithubActionsTitle(null)).toBeNull();
		expect(displayDeploymentTitle("Manual deploy")).toBe("Manual deploy");
		expect(displayDeploymentTitle(null)).toBeNull();
		expect(
			displayDeploymentTitle("GHA production b4f509d2: ship it [run 1.1]"),
		).toBe("ship it (b4f509d2)");
	});
});
