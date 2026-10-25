import path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	apiSaveBitbucketProvider,
	apiSaveBuildType,
	apiSaveGiteaProvider,
	apiSaveGithubProvider,
	apiSaveGitlabProvider,
	apiSaveGitProvider,
	apiUpdateApplication,
} from "@dokploy/server/db/schema";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { getCheckoutPathError } from "@dokploy/server/utils/compose-path";
import {
	getBuildAppDirectory,
	getDockerContextPath,
	getPublishDirectoryPath,
} from "@dokploy/server/utils/filesystem/directory";
import { describe, expect, it } from "vitest";

// The build settings of an application that name a place inside its checkout
// (T-8282): the build path of each provider, the Dockerfile, the Docker
// context and the publish directory. What the API accepts, and what a row
// saved before the rules may hold at deploy time.

const { APPLICATIONS_PATH } = paths(false);
const CODE = path.join(APPLICATIONS_PATH, "test-app", "code");

const application = (overrides: Partial<ApplicationNested>) =>
	({
		appName: "test-app",
		sourceType: "github",
		buildType: "nixpacks",
		buildPath: "/",
		dockerfile: "Dockerfile",
		dockerContextPath: null,
		publishDirectory: null,
		serverId: null,
		buildServerId: null,
		...overrides,
	}) as unknown as ApplicationNested;

// Accepted when saved and at deploy time. A leading `/` is the top of the
// repository (the default build path is "/").
const ACCEPTED = [
	"",
	"/",
	".",
	"./",
	"apps/web",
	"./apps/web",
	"/apps/web",
	"/apps/web/",
	"apps/my web",
	"a..b/c",
	"..hidden",
	"apps/@scope/web",
];

// Refused when saved and at deploy time.
const REFUSED = [
	"..",
	"../other",
	"/..",
	"/../other",
	"./../other",
	"apps/../../other",
	"../../..",
	"apps\\web",
	"apps/\u0000web",
	"apps/\nweb",
];

describe("build path rules at the API", () => {
	const BUILD_PATH_INPUTS = [
		["github", apiSaveGithubProvider, "buildPath"],
		["gitlab", apiSaveGitlabProvider, "gitlabBuildPath"],
		["bitbucket", apiSaveBitbucketProvider, "bitbucketBuildPath"],
		["gitea", apiSaveGiteaProvider, "giteaBuildPath"],
		["git", apiSaveGitProvider, "customGitBuildPath"],
	] as const;

	it.each(BUILD_PATH_INPUTS)(
		"the %s provider accepts build paths inside the repository",
		(_, schema, field) => {
			for (const value of ACCEPTED) {
				const result = schema.safeParse({ [field]: value });
				const issues = result.success
					? []
					: result.error.issues.filter((issue) => issue.path[0] === field);
				expect(issues, JSON.stringify(value)).toEqual([]);
			}
		},
	);

	it.each(BUILD_PATH_INPUTS)(
		"the %s provider refuses build paths outside the repository",
		(_, schema, field) => {
			for (const value of REFUSED) {
				const result = schema.safeParse({ [field]: value });
				expect(result.success, JSON.stringify(value)).toBe(false);
				const issues = result.success
					? []
					: result.error.issues.filter((issue) => issue.path[0] === field);
				expect(issues.length, JSON.stringify(value)).toBeGreaterThan(0);
			}
		},
	);

	it("an application update checks every build path field", () => {
		for (const field of [
			"buildPath",
			"gitlabBuildPath",
			"bitbucketBuildPath",
			"giteaBuildPath",
			"customGitBuildPath",
			"dropBuildPath",
			"dockerContextPath",
			"publishDirectory",
		]) {
			expect(
				apiUpdateApplication.safeParse({
					applicationId: "app-1",
					[field]: "../other",
				}).success,
				field,
			).toBe(false);
			expect(
				apiUpdateApplication.safeParse({
					applicationId: "app-1",
					[field]: "/apps/web",
				}).success,
				field,
			).toBe(true);
		}
	});

	it("an application update still accepts null build settings", () => {
		expect(
			apiUpdateApplication.safeParse({
				applicationId: "app-1",
				dockerContextPath: null,
				gitlabBuildPath: null,
				publishDirectory: null,
			}).success,
		).toBe(true);
	});

	const buildType = (overrides: Record<string, unknown>) =>
		apiSaveBuildType.safeParse({
			applicationId: "app-1",
			buildType: "dockerfile",
			dockerfile: "Dockerfile",
			dockerContextPath: "",
			dockerBuildStage: "",
			herokuVersion: "24",
			railpackVersion: "0.15.4",
			publishDirectory: "",
			isStaticSpa: false,
			...overrides,
		});

	it("the build type form accepts its usual values", () => {
		expect(buildType({}).success).toBe(true);
		expect(buildType({ dockerContextPath: null }).success).toBe(true);
		expect(buildType({ dockerContextPath: "./apps/web" }).success).toBe(true);
		expect(buildType({ dockerfile: "docker/web.Dockerfile" }).success).toBe(
			true,
		);
		expect(buildType({ publishDirectory: "dist" }).success).toBe(true);
	});

	it("the build type form refuses a context or publish directory outside the repository", () => {
		expect(buildType({ dockerContextPath: "../../.." }).success).toBe(false);
		expect(buildType({ dockerContextPath: "a\\b" }).success).toBe(false);
		expect(buildType({ publishDirectory: "../dist" }).success).toBe(false);
		expect(buildType({ dockerfile: "Docker\u0000file" }).success).toBe(false);
		expect(buildType({ dockerfile: "docker\\Dockerfile" }).success).toBe(false);
	});

	it("the Dockerfile path may name a parent of the build path", () => {
		// It is relative to the build path; the deploy checks where it lands.
		expect(buildType({ dockerfile: "../../Dockerfile" }).success).toBe(true);
	});

	it("getCheckoutPathError names the setting", () => {
		expect(getCheckoutPathError("../x", "the build path")).toBe(
			"the build path leaves the repository",
		);
		expect(getCheckoutPathError("a\\b", "the build path")).toBe(
			"the build path contains a backslash",
		);
		expect(
			getCheckoutPathError("../x", "the Dockerfile path", {
				parentSegments: true,
			}),
		).toBeNull();
	});
});

describe("build path rules at deploy time", () => {
	it("joins the build paths it always joined", () => {
		for (const value of ACCEPTED) {
			expect(
				getBuildAppDirectory(application({ buildPath: value })),
				JSON.stringify(value),
			).toBe(path.join(APPLICATIONS_PATH, "test-app", "code", value));
		}
		expect(
			getBuildAppDirectory(
				application({ buildType: "dockerfile", buildPath: "/apps/web" }),
			),
		).toBe(path.join(CODE, "apps/web", "Dockerfile"));
		expect(
			getDockerContextPath(application({ dockerContextPath: "./apps" })),
		).toBe(path.join(CODE, "apps"));
		expect(getDockerContextPath(application({}))).toBeNull();
	});

	it.each([
		["github", "buildPath"],
		["gitlab", "gitlabBuildPath"],
		["bitbucket", "bitbucketBuildPath"],
		["gitea", "giteaBuildPath"],
		["drop", "dropBuildPath"],
		["git", "customGitBuildPath"],
	])(
		"refuses a stored %s build path outside the code directory",
		(sourceType, field) => {
			for (const value of ["..", "../other", "/../../x", "a/../../b"]) {
				expect(
					() =>
						getBuildAppDirectory(
							application({
								sourceType,
								buildPath: "/",
								[field]: value,
							} as Partial<ApplicationNested>),
						),
					`${field} ${JSON.stringify(value)}`,
				).toThrow(/Build refused: the build path leaves the repository/);
			}
		},
	);

	it("refuses a stored build path with a control character or a backslash", () => {
		expect(() =>
			getBuildAppDirectory(application({ buildPath: "apps/\u0000web" })),
		).toThrow(/control character/);
		expect(() =>
			getBuildAppDirectory(application({ buildPath: "apps\\web" })),
		).toThrow(/backslash/);
	});

	it("allows a stored build path that only climbs inside the checkout", () => {
		expect(
			getBuildAppDirectory(application({ buildPath: "apps/web/../api" })),
		).toBe(path.join(CODE, "apps/api"));
	});

	it("refuses a stored Docker context outside the code directory", () => {
		for (const value of ["..", "../../..", "/../other", "apps/../.."]) {
			expect(
				() => getDockerContextPath(application({ dockerContextPath: value })),
				JSON.stringify(value),
			).toThrow(/Build refused: the Docker context path leaves the repository/);
		}
	});

	it("checks the Dockerfile path from the build path", () => {
		expect(
			getBuildAppDirectory(
				application({
					buildType: "dockerfile",
					buildPath: "apps/web",
					dockerfile: "../../Dockerfile",
				}),
			),
		).toBe(path.join(CODE, "Dockerfile"));
		expect(() =>
			getBuildAppDirectory(
				application({
					buildType: "dockerfile",
					buildPath: "apps/web",
					dockerfile: "../../../Dockerfile",
				}),
			),
		).toThrow(/Build refused: the Dockerfile path leaves the repository/);
	});

	it("refuses a stored publish directory outside the code directory", () => {
		expect(
			getPublishDirectoryPath(application({ publishDirectory: "dist" })),
		).toBe(path.join(CODE, "dist"));
		expect(getPublishDirectoryPath(application({}))).toBeNull();
		expect(() =>
			getPublishDirectoryPath(application({ publishDirectory: "../../x" })),
		).toThrow(/Build refused: the publish directory leaves the repository/);
	});

	it("uses the build server's directory when the build runs there", () => {
		const { APPLICATIONS_PATH: REMOTE } = paths(true);
		expect(
			getBuildAppDirectory(
				application({ buildServerId: "build-1", buildPath: "/apps/web" }),
			),
		).toBe(path.join(REMOTE, "test-app", "code", "/apps/web"));
		expect(() =>
			getBuildAppDirectory(
				application({ buildServerId: "build-1", buildPath: "../x" }),
			),
		).toThrow(/leaves the repository/);
	});
});
