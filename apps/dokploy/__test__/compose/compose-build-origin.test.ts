import { beforeEach, describe, expect, it, vi } from "vitest";

// T-12149: a compose deployment records where its image was built. The
// request's buildOrigin / buildRunUrl are used when present (the run link only
// when it is a GitHub Actions run link); otherwise it is inferred from the
// source and the "GHA " title the dokploy-deploy action sends.
const mocks = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	createDeploymentCompose: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: mocks.execAsync,
		execAsyncRemote: mocks.execAsyncRemote,
	};
});

vi.mock("@dokploy/server/services/deployment", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment")
	>("@dokploy/server/services/deployment");
	return {
		...actual,
		createDeploymentCompose: mocks.createDeploymentCompose,
		updateDeploymentStatus: mocks.updateDeploymentStatus,
	};
});

import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";

const RUN = "https://github.com/DevinoSolutions/postify/actions/runs/42";

const IMAGE_ONLY = "services:\n  web:\n    image: ghcr.io/o/r@sha256:abc\n";
const WITH_BUILD = "services:\n  web:\n    build: .\n";

// A path the compose path rules refuse: the run stops right after the
// deployment row is created, which is all this test looks at.
const compose = (sourceType: string, composeFile: string) => ({
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType,
	composeType: "docker-compose",
	composeFile,
	composePath: "../other-app/code/docker-compose.yml",
	owner: "me",
	repository: "repo",
	customGitUrl: null,
	serverId: null,
	environment: { project: { organizationId: "org-1" } },
});

const useCompose = async (row: ReturnType<typeof compose>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(row as never);
};

const originPassed = () => mocks.createDeploymentCompose.mock.calls[0]?.[1];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "dep-1",
		logPath: "/var/log/dep-1.log",
	});
});

describe.each([
	["deployCompose", deployCompose],
	["rebuildCompose", rebuildCompose],
])("%s records the build origin", (_name, run) => {
	const go = (
		extra: { buildOrigin?: string; buildRunUrl?: string } = {},
		titleLog = "Deploy",
	) =>
		run({
			composeId: "compose-1",
			titleLog,
			descriptionLog: "",
			...extra,
		}).catch(() => undefined);

	it("a raw compose without build sections is a prebuilt image", async () => {
		await useCompose(compose("raw", IMAGE_ONLY));
		await go();
		expect(originPassed()).toEqual({
			buildOrigin: "external",
			buildRunUrl: null,
		});
	});

	it("a raw compose with a build section is built on Dokploy", async () => {
		await useCompose(compose("raw", WITH_BUILD));
		await go();
		expect(originPassed()).toEqual({
			buildOrigin: "dokploy",
			buildRunUrl: null,
		});
	});

	it("a git compose is built on Dokploy", async () => {
		await useCompose(compose("github", ""));
		await go();
		expect(originPassed()?.buildOrigin).toBe("dokploy");
	});

	it("the 'GHA ' title of the action marks a prebuilt image as GitHub Actions", async () => {
		await useCompose(compose("raw", IMAGE_ONLY));
		await go({}, "GHA production 1a2b3c4d: ship it [run 42.1]");
		expect(originPassed()).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: null,
		});
	});

	it("uses the origin and run link the request sent", async () => {
		await useCompose(compose("raw", IMAGE_ONLY));
		await go({ buildOrigin: "github-actions", buildRunUrl: `${RUN}?x=1#y` });
		expect(originPassed()).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: RUN,
		});
	});

	it("drops a run link that is not a GitHub Actions run, and still deploys", async () => {
		await useCompose(compose("raw", IMAGE_ONLY));
		await go({
			buildOrigin: "github-actions",
			buildRunUrl: "https://evil.example/o/r/actions/runs/1",
		});
		expect(originPassed()).toEqual({
			buildOrigin: "github-actions",
			buildRunUrl: null,
		});
	});
});
