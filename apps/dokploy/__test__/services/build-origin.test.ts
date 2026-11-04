import {
	type BuildOriginDeploymentRow,
	buildOriginJobFields,
	composeFileHasBuildSection,
	computeServiceBuildOrigins,
	describeGithubActionsOriginPill,
	describeServiceBuild,
	hasGithubActionsTitleMarker,
	inferBuildOriginFromSource,
	isGithubActionsDeployment,
	isGithubActionsRollbackTitle,
	normalizeBuildRunUrl,
	pickServiceBuildOrigin,
	resolveDeploymentBuildOrigin,
} from "@dokploy/server/services/build-origin";
import { describe, expect, test } from "vitest";

const RUN = "https://github.com/DevinoSolutions/postify/actions/runs/123456789";

const row = (
	overrides: Partial<BuildOriginDeploymentRow>,
): BuildOriginDeploymentRow => ({
	title: "Manual deployment",
	status: "done",
	createdAt: "2026-10-31T10:00:00.000Z",
	buildOrigin: null,
	buildRunUrl: null,
	...overrides,
});

describe("normalizeBuildRunUrl", () => {
	test("accepts a GitHub Actions run link, with attempt or job suffix", () => {
		expect(normalizeBuildRunUrl(RUN)).toBe(RUN);
		expect(normalizeBuildRunUrl(`${RUN}/attempts/2`)).toBe(`${RUN}/attempts/2`);
		expect(normalizeBuildRunUrl(`${RUN}/job/987`)).toBe(`${RUN}/job/987`);
		expect(normalizeBuildRunUrl(`  ${RUN}/  `)).toBe(RUN);
	});

	test("drops the query string and the fragment", () => {
		expect(normalizeBuildRunUrl(`${RUN}?pr=12#step:3:1`)).toBe(RUN);
	});

	test.each([
		["http scheme", RUN.replace("https", "http")],
		["another host", "https://gitlab.com/o/r/actions/runs/1"],
		["a look-alike host", "https://github.com.evil.example/o/r/actions/runs/1"],
		["a subdomain", "https://api.github.com/o/r/actions/runs/1"],
		["userinfo", "https://user:pw@github.com/o/r/actions/runs/1"],
		["a port", "https://github.com:8443/o/r/actions/runs/1"],
		["not a run path", "https://github.com/o/r/actions/workflows/ci.yml"],
		["a pull request link", "https://github.com/o/r/pull/12"],
		["a non-numeric run id", "https://github.com/o/r/actions/runs/abc"],
		["an extra path segment", `${RUN}/extra/segment`],
		["a backslash", "https://github.com/o/r/actions/runs/1\\evil"],
		["embedded whitespace", "https://github.com/o/r/actions/runs/1 2"],
		["a javascript url", "javascript:alert(1)"],
		["an empty string", ""],
		["text", "not a url"],
		["too long", `https://github.com/o/r/actions/runs/${"1".repeat(400)}`],
	])("drops %s", (_name, value) => {
		expect(normalizeBuildRunUrl(value)).toBeNull();
	});

	test("drops a value that is not a string", () => {
		expect(normalizeBuildRunUrl(undefined)).toBeNull();
		expect(normalizeBuildRunUrl(null)).toBeNull();
		expect(normalizeBuildRunUrl(42)).toBeNull();
	});
});

describe("composeFileHasBuildSection", () => {
	test("finds a build key under a service", () => {
		expect(
			composeFileHasBuildSection("services:\n  web:\n    build: .\n"),
		).toBe(true);
		expect(
			composeFileHasBuildSection(
				"services:\n  web:\n    build:\n      context: .\n",
			),
		).toBe(true);
	});

	test("ignores an image-only compose and a commented build", () => {
		expect(
			composeFileHasBuildSection(
				"services:\n  web:\n    image: ghcr.io/o/r@sha256:abc\n    # build: .\n",
			),
		).toBe(false);
		expect(composeFileHasBuildSection("")).toBe(false);
		expect(composeFileHasBuildSection(null)).toBe(false);
	});
});

describe("inferBuildOriginFromSource", () => {
	test("an application: docker source is external, every other source is built by Dokploy", () => {
		expect(
			inferBuildOriginFromSource({ kind: "application", sourceType: "docker" }),
		).toBe("external");
		for (const sourceType of [
			"github",
			"gitlab",
			"gitea",
			"bitbucket",
			"git",
			"drop",
		]) {
			expect(
				inferBuildOriginFromSource({ kind: "application", sourceType }),
			).toBe("dokploy");
		}
	});

	test("a compose: raw with build is Dokploy, raw without is external, git sources are Dokploy", () => {
		expect(
			inferBuildOriginFromSource({
				kind: "compose",
				sourceType: "raw",
				hasBuildSection: true,
			}),
		).toBe("dokploy");
		expect(
			inferBuildOriginFromSource({
				kind: "compose",
				sourceType: "raw",
				hasBuildSection: false,
			}),
		).toBe("external");
		expect(
			inferBuildOriginFromSource({
				kind: "compose",
				sourceType: "github",
				hasBuildSection: false,
			}),
		).toBe("dokploy");
	});
});

describe("hasGithubActionsTitleMarker", () => {
	test("matches the titles the dokploy-deploy action sends", () => {
		expect(
			hasGithubActionsTitleMarker(
				"GHA production 1a2b3c4d: fix login [run 123.1]",
			),
		).toBe(true);
		expect(
			hasGithubActionsTitleMarker(
				"GHA rollback production to 0f9e8d7c [run 122.1]",
			),
		).toBe(true);
	});

	test("does not match other titles", () => {
		expect(hasGithubActionsTitleMarker("Manual deployment")).toBe(false);
		expect(hasGithubActionsTitleMarker("GHAx production")).toBe(false);
		expect(hasGithubActionsTitleMarker("my GHA deploy")).toBe(false);
		expect(hasGithubActionsTitleMarker(null)).toBe(false);
	});
});

describe("isGithubActionsRollbackTitle", () => {
	test("matches only the action's rollback deploy title", () => {
		expect(
			isGithubActionsRollbackTitle(
				"GHA rollback production to 0f9e8d7c [run 122.1]",
			),
		).toBe(true);
		expect(
			isGithubActionsRollbackTitle("GHA production 1a2b3c4d: rollback login"),
		).toBe(false);
		expect(isGithubActionsRollbackTitle("Rollback")).toBe(false);
		expect(isGithubActionsRollbackTitle(null)).toBe(false);
	});
});

describe("resolveDeploymentBuildOrigin", () => {
	test("a build Dokploy runs is 'dokploy', whatever the title says", () => {
		expect(
			resolveDeploymentBuildOrigin({
				title: "GHA production abc [run 1.1]",
				inferred: "dokploy",
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("a pulled image is 'external'", () => {
		expect(
			resolveDeploymentBuildOrigin({
				title: "Manual deployment",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "external", buildRunUrl: null });
	});

	test("the legacy 'GHA ' title marks a pulled image as github-actions, without a run link", () => {
		expect(
			resolveDeploymentBuildOrigin({
				title: "GHA production 1a2b3c4d [run 9.1]",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: null });
	});

	test("a valid run link alone marks a pulled image as github-actions", () => {
		expect(
			resolveDeploymentBuildOrigin({
				requestedRunUrl: RUN,
				title: "Manual deployment",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: RUN });
	});

	test("a build Dokploy runs cannot be claimed as GitHub Actions or a prebuilt image", () => {
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "github-actions",
				requestedRunUrl: RUN,
				title: "GHA production abc [run 1.1]",
				inferred: "dokploy",
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "external",
				inferred: "dokploy",
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("an explicit origin wins over inference for a pulled image", () => {
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "github-actions",
				requestedRunUrl: RUN,
				title: "Manual deployment",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: RUN });
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "external",
				title: "GHA production x",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "external", buildRunUrl: null });
	});

	test("an invalid run link is dropped, not an error", () => {
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "github-actions",
				requestedRunUrl: "https://evil.example/o/r/actions/runs/1",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: null });
	});

	test("the run link is kept only for github-actions", () => {
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "dokploy",
				requestedRunUrl: RUN,
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("an unknown origin string is ignored and inference applies", () => {
		expect(
			resolveDeploymentBuildOrigin({
				requestedOrigin: "jenkins",
				inferred: "external",
			}),
		).toEqual({ buildOrigin: "external", buildRunUrl: null });
	});
});

describe("buildOriginJobFields", () => {
	test("keeps a valid origin and a normalised run link", () => {
		expect(
			buildOriginJobFields({
				buildOrigin: "github-actions",
				buildRunUrl: `${RUN}?x=1`,
			}),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: RUN });
	});

	test("drops what is invalid and adds nothing when absent", () => {
		expect(
			buildOriginJobFields({ buildOrigin: "nope", buildRunUrl: "https://x.y" }),
		).toEqual({});
		expect(buildOriginJobFields({})).toEqual({});
	});
});

describe("pickServiceBuildOrigin", () => {
	const app = { kind: "application", sourceType: "docker" } as const;

	test("uses the latest deployment with status done, not a newer failed one", () => {
		expect(
			pickServiceBuildOrigin(
				[
					row({
						status: "error",
						createdAt: "2026-10-31T12:00:00.000Z",
						buildOrigin: "dokploy",
					}),
					row({
						status: "done",
						createdAt: "2026-10-31T11:00:00.000Z",
						buildOrigin: "github-actions",
						buildRunUrl: RUN,
					}),
					row({
						status: "done",
						createdAt: "2026-10-30T11:00:00.000Z",
						buildOrigin: "external",
					}),
				],
				app,
			),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: RUN });
	});

	test("falls back to the latest deployment of any status when none is done", () => {
		expect(
			pickServiceBuildOrigin(
				[
					row({
						status: "error",
						createdAt: "2026-10-30T12:00:00.000Z",
						buildOrigin: "external",
					}),
					row({
						status: "running",
						createdAt: "2026-10-31T12:00:00.000Z",
						buildOrigin: "dokploy",
					}),
				],
				app,
			),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("orders by createdAt itself, not by the order of the list", () => {
		const older = row({
			createdAt: "2026-10-01T00:00:00.000Z",
			buildOrigin: "external",
		});
		const newer = row({
			createdAt: "2026-10-02T00:00:00.000Z",
			buildOrigin: "dokploy",
		});
		expect(pickServiceBuildOrigin([newer, older], app).buildOrigin).toBe(
			"dokploy",
		);
		expect(pickServiceBuildOrigin([older, newer], app).buildOrigin).toBe(
			"dokploy",
		);
	});

	test("a row written before the column existed is inferred like a new deploy", () => {
		expect(
			pickServiceBuildOrigin(
				[row({ title: "GHA production 1a2b3c4d [run 5.1]" })],
				app,
			),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: null });
		expect(
			pickServiceBuildOrigin([row({ title: "Manual deployment" })], app),
		).toEqual({ buildOrigin: "external", buildRunUrl: null });
		expect(
			pickServiceBuildOrigin([row({ title: "GHA production x" })], {
				kind: "application",
				sourceType: "github",
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("skips the action's rollback deploy: the run link stays the one that built the image", () => {
		expect(
			pickServiceBuildOrigin(
				[
					row({
						title: "GHA rollback production to 0f9e8d7c",
						createdAt: "2026-10-31T12:00:00.000Z",
						buildOrigin: "github-actions",
					}),
					row({
						title: "GHA production 0f9e8d7c: ship it [run 5.1]",
						createdAt: "2026-10-31T11:00:00.000Z",
						buildOrigin: "github-actions",
						buildRunUrl: RUN,
					}),
				],
				app,
			),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: RUN });
	});

	test("a rollback title does not turn a prebuilt image into GitHub Actions when other deploys exist", () => {
		expect(
			pickServiceBuildOrigin(
				[
					row({
						title: "GHA rollback production to 0f9e8d7c",
						createdAt: "2026-10-31T12:00:00.000Z",
					}),
					row({
						title: "Manual deployment",
						createdAt: "2026-10-31T11:00:00.000Z",
					}),
				],
				app,
			),
		).toEqual({ buildOrigin: "external", buildRunUrl: null });
	});

	test("uses the rollback deploy when it is the only one", () => {
		expect(
			pickServiceBuildOrigin(
				[row({ title: "GHA rollback production to 0f9e8d7c" })],
				app,
			),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: null });
	});

	test("a git-source application is 'dokploy' even with GitHub Actions rows and titles", () => {
		const github = { kind: "application", sourceType: "github" } as const;
		expect(
			pickServiceBuildOrigin(
				[
					row({
						title: "GHA production abc [run 1.1]",
						buildOrigin: "github-actions",
						buildRunUrl: RUN,
					}),
				],
				github,
			),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
		expect(
			pickServiceBuildOrigin(
				[row({ title: "GHA production abc [run 1.1]" })],
				github,
			),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("a raw compose with a build section is 'dokploy' even with a GHA title", () => {
		expect(
			pickServiceBuildOrigin([row({ title: "GHA production abc [run 1.1]" })], {
				kind: "compose",
				sourceType: "raw",
				hasBuildSection: true,
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("a service never deployed gets the source inference", () => {
		expect(pickServiceBuildOrigin([], app)).toEqual({
			buildOrigin: "external",
			buildRunUrl: null,
		});
		expect(
			pickServiceBuildOrigin([], {
				kind: "compose",
				sourceType: "raw",
				hasBuildSection: true,
			}),
		).toEqual({ buildOrigin: "dokploy", buildRunUrl: null });
	});

	test("ignores schedule, backup, volume backup and preview runs", () => {
		expect(
			pickServiceBuildOrigin(
				[
					row({
						createdAt: "2026-10-31T12:00:00.000Z",
						buildOrigin: "dokploy",
						scheduleId: "s1",
					}),
					row({
						createdAt: "2026-10-31T11:00:00.000Z",
						buildOrigin: "dokploy",
						previewDeploymentId: "p1",
					}),
					row({
						createdAt: "2026-10-30T11:00:00.000Z",
						buildOrigin: "github-actions",
					}),
				],
				app,
			).buildOrigin,
		).toBe("github-actions");
	});

	test("a stored run link that is not valid is not returned", () => {
		expect(
			pickServiceBuildOrigin(
				[
					row({
						buildOrigin: "github-actions",
						buildRunUrl: "https://evil.example/x",
					}),
				],
				app,
			),
		).toEqual({ buildOrigin: "github-actions", buildRunUrl: null });
	});

	test("a run link on a non-github-actions row is not returned", () => {
		expect(
			pickServiceBuildOrigin(
				[row({ buildOrigin: "dokploy", buildRunUrl: RUN })],
				app,
			).buildRunUrl,
		).toBeNull();
	});
});

describe("computeServiceBuildOrigins", () => {
	test("computes each application and compose from its own deployments", () => {
		const origins = computeServiceBuildOrigins({
			applications: [
				{ id: "app-gha", sourceType: "docker" },
				{ id: "app-git", sourceType: "github" },
				{ id: "app-img", sourceType: "docker" },
			],
			composes: [
				{ id: "cmp-raw", sourceType: "raw", hasBuildSection: false },
				{ id: "cmp-build", sourceType: "raw", hasBuildSection: true },
			],
			deployments: [
				{
					...row({ buildOrigin: "github-actions", buildRunUrl: RUN }),
					applicationId: "app-gha",
					composeId: null,
				},
				{
					...row({ title: "GHA production x [run 7.1]" }),
					applicationId: null,
					composeId: "cmp-raw",
				},
				{
					...row({
						buildOrigin: "external",
						createdAt: "2026-10-01T00:00:00.000Z",
					}),
					applicationId: "app-img",
					composeId: null,
				},
			],
		});
		expect(origins.get("app-gha")).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
		});
		expect(origins.get("app-git")?.buildOrigin).toBe("dokploy");
		expect(origins.get("app-img")?.buildOrigin).toBe("external");
		expect(origins.get("cmp-raw")?.buildOrigin).toBe("github-actions");
		expect(origins.get("cmp-build")?.buildOrigin).toBe("dokploy");
	});
});

describe("isGithubActionsDeployment", () => {
	test("a row with a stored origin says so itself", () => {
		expect(
			isGithubActionsDeployment({ buildOrigin: "github-actions", title: "x" }),
		).toBe(true);
		expect(
			isGithubActionsDeployment(
				{ buildOrigin: "dokploy", title: "GHA production x" },
				"github-actions",
			),
		).toBe(false);
	});

	test("an old row counts only with the GHA title on a GitHub Actions service", () => {
		const old = { buildOrigin: null, title: "GHA production x [run 1.1]" };
		expect(isGithubActionsDeployment(old, "github-actions")).toBe(true);
		expect(isGithubActionsDeployment(old, "dokploy")).toBe(false);
		expect(isGithubActionsDeployment(old)).toBe(false);
		expect(
			isGithubActionsDeployment(
				{ buildOrigin: null, title: "Manual deployment" },
				"github-actions",
			),
		).toBe(false);
	});
});

describe("a service that follows GitHub Actions (source type github-actions)", () => {
	const application = { kind: "application", sourceType: "github-actions" } as const;
	const composeService = {
		kind: "compose",
		sourceType: "github-actions",
		hasBuildSection: false,
	} as const;

	test("is built in GitHub Actions before any release arrived, not on Dokploy", () => {
		expect(pickServiceBuildOrigin([], application)).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: null,
		});
		expect(pickServiceBuildOrigin([], composeService).buildOrigin).toBe(
			"github-actions",
		);
		// A compose file with build: sections is no reason to call it a Dokploy build once it is connected.
		expect(
			pickServiceBuildOrigin([], { ...composeService, hasBuildSection: true })
				.buildOrigin,
		).toBe("github-actions");
	});

	test("rows from before it was connected (built by Dokploy) do not count", () => {
		const before = row({ buildOrigin: "dokploy", title: "Manual deployment" });
		expect(pickServiceBuildOrigin([before], application)).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: null,
		});
	});

	test("takes the run link of the newest release", () => {
		const release = row({
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
			title: "GHA production abcdef12 [run 5.1]",
			createdAt: "2026-11-03T10:00:00.000Z",
		});
		const before = row({
			buildOrigin: "dokploy",
			createdAt: "2026-11-04T10:00:00.000Z",
		});
		expect(pickServiceBuildOrigin([before, release], application)).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
		});
	});

	test("describeServiceBuild has no run details and no deploy time while waiting", () => {
		const described = describeServiceBuild([], application);
		expect(described.buildOrigin).toBe("github-actions");
		expect(described.buildDeployedAt).toBeNull();
		expect(described.buildRunId).toBeNull();
	});
});

describe("describeGithubActionsOriginPill", () => {
	test("a connected service with no release yet waits for the first release", () => {
		expect(describeGithubActionsOriginPill({ buildOrigin: "github-actions" })).toEqual({
			label: "GitHub Actions · waiting for the first release",
			waitingForFirstRelease: true,
		});
		expect(
			describeGithubActionsOriginPill({
				buildOrigin: "github-actions",
				buildDeployedAt: null,
				buildRunUrl: null,
				buildCommitSha: null,
				buildRunId: null,
			}).waitingForFirstRelease,
		).toBe(true);
	});

	test.each([
		["a deploy time", { buildDeployedAt: "2026-11-03T10:00:00.000Z" }],
		["a run link", { buildRunUrl: RUN }],
		["a commit", { buildCommitSha: "abcdef12" }],
		["a run id", { buildRunId: "123456789" }],
	])("says just GitHub Actions once there is %s", (_name, fields) => {
		expect(
			describeGithubActionsOriginPill({ buildOrigin: "github-actions", ...fields }),
		).toEqual({ label: "GitHub Actions", waitingForFirstRelease: false });
	});

	test("never waits for any other origin", () => {
		for (const buildOrigin of ["dokploy", "external", null, undefined]) {
			expect(
				describeGithubActionsOriginPill({ buildOrigin }).waitingForFirstRelease,
			).toBe(false);
		}
	});
});
