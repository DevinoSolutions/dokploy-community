import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A deploy or redeploy that carries the deploymentId of a live GitHub Actions row (deployment.registerExternalBuild)
 * continues that row: the flow uses the row it claimed and creates no second one. When the row does not fit, or no
 * deploymentId came, it creates its own row exactly as before.
 */

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	createDeployment: vi.fn(),
	createDeploymentCompose: vi.fn(),
	claimLiveGithubBuild: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
	getDeploymentErrorMessage: vi.fn(),
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

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(async () => "https://dokploy.test"),
}));

vi.mock("@dokploy/server/services/deployment", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/deployment")
	>("@dokploy/server/services/deployment");
	return {
		...actual,
		createDeployment: mocks.createDeployment,
		createDeploymentCompose: mocks.createDeploymentCompose,
		updateDeploymentStatus: mocks.updateDeploymentStatus,
		updateDeployment: mocks.updateDeployment,
		getDeploymentErrorMessage: mocks.getDeploymentErrorMessage,
	};
});

vi.mock("@dokploy/server/services/live-build-claim", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/live-build-claim")
	>("@dokploy/server/services/live-build-claim");
	return { ...actual, claimLiveGithubBuild: mocks.claimLiveGithubBuild };
});

import {
	deployApplication,
	rebuildApplication,
} from "@dokploy/server/services/application";
import {
	deployCompose,
	rebuildCompose,
} from "@dokploy/server/services/compose";

const application = (serverId: string | null = null) => ({
	applicationId: "app-1",
	appName: "web-abc123",
	name: "Web",
	sourceType: "docker",
	dockerImage: "localhost:5000/web@sha256:abc",
	serverId,
	buildServerId: null,
	environmentId: "env-1",
	environment: {
		name: "production",
		projectId: "proj-1",
		project: { organizationId: "org-1", name: "P" },
	},
	domains: [],
	registry: null,
});

// A path the compose path rules refuse: the flow stops right after the deployment row is settled, which is all
// this test looks at.
const compose = (serverId: string | null = null) => ({
	composeId: "compose-1",
	appName: "stack",
	name: "Stack",
	sourceType: "raw",
	composeType: "docker-compose",
	composeFile: "services:\n  web:\n    image: ghcr.io/o/r@sha256:abc\n",
	composePath: "../other-app/code/docker-compose.yml",
	serverId,
	environmentId: "env-1",
	environment: {
		name: "production",
		projectId: "proj-1",
		project: { organizationId: "org-1", name: "P" },
	},
	domains: [],
});

const liveRow = {
	deploymentId: "live-1",
	logPath: "/var/log/live-1.log",
	buildServerId: null,
	serverId: null,
	status: "running",
};

const useApplication = async (row: ReturnType<typeof application>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.applications.findFirst).mockResolvedValue(row as never);
};
const useCompose = async (row: ReturnType<typeof compose>) => {
	const { db } = await import("@dokploy/server/db");
	vi.mocked(db.query.compose.findFirst).mockResolvedValue(row as never);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	mocks.getDeploymentErrorMessage.mockResolvedValue("failed");
	mocks.createDeployment.mockResolvedValue({
		deploymentId: "own-1",
		logPath: "/var/log/own-1.log",
		buildServerId: null,
		serverId: null,
	});
	mocks.createDeploymentCompose.mockResolvedValue({
		deploymentId: "own-1",
		logPath: "/var/log/own-1.log",
	});
	mocks.claimLiveGithubBuild.mockResolvedValue(liveRow);
});

describe.each([
	["deployApplication", deployApplication],
	["rebuildApplication", rebuildApplication],
])("%s", (_name, run) => {
	const go = (extra: { deploymentId?: string } = {}) =>
		run({
			applicationId: "app-1",
			titleLog: "GHA production abc12345: ship it",
			descriptionLog: "note",
			...extra,
		}).catch(() => undefined);

	it("continues the live row it is given and creates no row of its own", async () => {
		await useApplication(application());
		await go({ deploymentId: "live-1" });

		expect(mocks.claimLiveGithubBuild).toHaveBeenCalledWith(
			{
				deploymentId: "live-1",
				kind: "application",
				serviceId: "app-1",
				logHost: null,
			},
			{ title: "GHA production abc12345: ship it", description: "note" },
		);
		expect(mocks.createDeployment).not.toHaveBeenCalled();
	});

	it("names the host the deploy writes its log on, so a log elsewhere is not claimed", async () => {
		await useApplication(application("srv-1"));
		await go({ deploymentId: "live-1" });
		expect(mocks.claimLiveGithubBuild.mock.calls[0]?.[0]).toMatchObject({
			logHost: "srv-1",
		});
	});

	it("creates its own row when the live row does not fit", async () => {
		await useApplication(application());
		mocks.claimLiveGithubBuild.mockResolvedValue(null);
		await go({ deploymentId: "live-1" });
		expect(mocks.claimLiveGithubBuild).toHaveBeenCalledTimes(1);
		expect(mocks.createDeployment).toHaveBeenCalledTimes(1);
	});

	it("never looks for a live row when no deploymentId came", async () => {
		await useApplication(application());
		await go();
		expect(mocks.claimLiveGithubBuild).not.toHaveBeenCalled();
		expect(mocks.createDeployment).toHaveBeenCalledTimes(1);
	});
});

describe.each([
	["deployCompose", deployCompose],
	["rebuildCompose", rebuildCompose],
])("%s", (_name, run) => {
	const go = (extra: { deploymentId?: string } = {}) =>
		run({
			composeId: "compose-1",
			titleLog: "GHA production abc12345: ship it",
			descriptionLog: "note",
			...extra,
		}).catch(() => undefined);

	it("continues the live row it is given and creates no row of its own", async () => {
		await useCompose(compose());
		await go({ deploymentId: "live-1" });

		expect(mocks.claimLiveGithubBuild).toHaveBeenCalledWith(
			{
				deploymentId: "live-1",
				kind: "compose",
				serviceId: "compose-1",
				logHost: null,
			},
			{ title: "GHA production abc12345: ship it", description: "note" },
		);
		expect(mocks.createDeploymentCompose).not.toHaveBeenCalled();
	});

	it("names the serving host as the log host of a remote compose", async () => {
		await useCompose(compose("srv-9"));
		await go({ deploymentId: "live-1" });
		expect(mocks.claimLiveGithubBuild.mock.calls[0]?.[0]).toMatchObject({
			logHost: "srv-9",
		});
	});

	it("creates its own row when the live row does not fit", async () => {
		await useCompose(compose());
		mocks.claimLiveGithubBuild.mockResolvedValue(null);
		await go({ deploymentId: "live-1" });
		expect(mocks.createDeploymentCompose).toHaveBeenCalledTimes(1);
	});

	it("never looks for a live row when no deploymentId came", async () => {
		await useCompose(compose());
		await go();
		expect(mocks.claimLiveGithubBuild).not.toHaveBeenCalled();
		expect(mocks.createDeploymentCompose).toHaveBeenCalledTimes(1);
	});
});
