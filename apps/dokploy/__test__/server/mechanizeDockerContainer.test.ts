import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockCreateServiceOptions = {
	TaskTemplate?: {
		ContainerSpec?: {
			StopGracePeriod?: number;
			Ulimits?: Array<{ Name: string; Soft: number; Hard: number }>;
		};
	};
	[key: string]: unknown;
};

const {
	inspectMock,
	getServiceMock,
	createServiceMock,
	listTasksMock,
	getRemoteDockerMock,
} = vi.hoisted(() => {
	const inspect = vi.fn<() => Promise<never>>();
	const getService = vi.fn(() => ({ inspect }));
	const createService = vi.fn<
		(auth: unknown, opts: MockCreateServiceOptions) => Promise<void>
	>(async () => undefined);
	const listTasks = vi.fn(async (): Promise<unknown[]> => []);
	const getRemoteDocker = vi.fn(async () => ({
		getService,
		createService,
		listTasks,
	}));
	return {
		inspectMock: inspect,
		getServiceMock: getService,
		createServiceMock: createService,
		listTasksMock: listTasks,
		getRemoteDockerMock: getRemoteDocker,
	};
});

const { findRegistryMock, ghcrAuthMock } = vi.hoisted(() => ({
	findRegistryMock: vi.fn(),
	ghcrAuthMock: vi.fn(),
}));

vi.mock(
	"@dokploy/server/services/github-deployments/registry-auth",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@dokploy/server/services/github-deployments/registry-auth")
		>()),
		ghcrAuthConfigForApplication: ghcrAuthMock,
	}),
);

vi.mock("@dokploy/server/services/registry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/registry")
	>()),
	findRegistryByIdWithCredentials: findRegistryMock,
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	sleep: vi.fn(async () => undefined),
}));

const createApplication = (
	overrides: Partial<ApplicationNested> = {},
): ApplicationNested =>
	({
		appName: "test-app",
		buildType: "dockerfile",
		env: null,
		mounts: [],
		cpuLimit: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuReservation: null,
		command: null,
		ports: [],
		sourceType: "docker",
		dockerImage: "example:latest",
		registry: null,
		environment: {
			project: { env: null },
			env: null,
		},
		replicas: 1,
		stopGracePeriodSwarm: 0,
		ulimitsSwarm: null,
		serverId: "server-id",
		...overrides,
	}) as unknown as ApplicationNested;

describe("mechanizeDockerContainer", () => {
	beforeEach(() => {
		inspectMock.mockReset();
		inspectMock.mockRejectedValue(new Error("service not found"));
		getServiceMock.mockClear();
		createServiceMock.mockClear();
		getRemoteDockerMock.mockClear();
		listTasksMock.mockReset();
		// Swarm reports the old and the new task as running.
		listTasksMock.mockResolvedValue([
			{ Spec: { ForceUpdate: 0 }, Status: { State: "running" } },
			{ Spec: { ForceUpdate: 3 }, Status: { State: "running" } },
		]);
		getRemoteDockerMock.mockResolvedValue({
			getService: getServiceMock,
			createService: createServiceMock,
			listTasks: listTasksMock,
		});
	});

	it("fails when Swarm can't schedule the new task", async () => {
		listTasksMock.mockResolvedValue([
			{ Status: { State: "running" } },
			{
				Status: {
					State: "pending",
					Err: "no suitable node (insufficient resources on 1 node)",
				},
			},
		]);

		await expect(mechanizeDockerContainer(createApplication())).rejects.toThrow(
			/insufficient resources/,
		);
	});

	it("passes stopGracePeriodSwarm as a number and keeps zero values", async () => {
		const application = createApplication({ stopGracePeriodSwarm: 0 });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [unknown, MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [, settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(0);
		expect(typeof settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(
			"number",
		);
	});

	it("omits StopGracePeriod when stopGracePeriodSwarm is null", async () => {
		const application = createApplication({ stopGracePeriodSwarm: null });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [unknown, MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [, settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty(
			"StopGracePeriod",
		);
	});

	it("passes ulimits to ContainerSpec when ulimitsSwarm is defined", async () => {
		const ulimits = [
			{ Name: "nofile", Soft: 10000, Hard: 20000 },
			{ Name: "nproc", Soft: 4096, Hard: 8192 },
		];
		const application = createApplication({ ulimitsSwarm: ulimits });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [, settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.Ulimits).toEqual(ulimits);
	});

	it("omits Ulimits when ulimitsSwarm is null", async () => {
		const application = createApplication({ ulimitsSwarm: null });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [, settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("omits Ulimits when ulimitsSwarm is an empty array", async () => {
		const application = createApplication({ ulimitsSwarm: [] });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [, settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	describe("when the service already exists", () => {
		const updateMock = vi.fn<(opts: MockCreateServiceOptions) => Promise<void>>(
			async () => undefined,
		);

		const mockExistingService = (spec: Record<string, unknown>) => {
			updateMock.mockClear();
			inspectMock.mockResolvedValue({
				Version: { Index: 7 },
				Spec: { TaskTemplate: { ForceUpdate: 2 }, ...spec },
			} as never);
			getServiceMock.mockReturnValue({
				inspect: inspectMock,
				update: updateMock,
			} as never);
		};

		it("keeps service labels that were added outside Dokploy", async () => {
			const labels = {
				"traefik.enable": "true",
				"traefik.http.routers.app-web.rule": "Host(`app.example.com`)",
			};
			mockExistingService({ Labels: labels });

			await mechanizeDockerContainer(createApplication());

			expect(createServiceMock).not.toHaveBeenCalled();
			expect(updateMock).toHaveBeenCalledTimes(1);
			expect(updateMock.mock.calls[0]?.[0].Labels).toEqual(labels);
		});

		it("sends empty labels when the service has none", async () => {
			mockExistingService({});

			await mechanizeDockerContainer(createApplication());

			expect(updateMock).toHaveBeenCalledTimes(1);
			expect(updateMock.mock.calls[0]?.[0].Labels).toEqual({});
		});
	});

	// T-15783: swarm keeps the registry auth stored on a service when an update
	// carries no X-Registry-Auth header, so an image without credentials must
	// still send an explicit anonymous auth.
	describe("registry auth on service update", () => {
		const updateMock = vi.fn<(opts: MockCreateServiceOptions) => Promise<void>>(
			async () => undefined,
		);

		beforeEach(() => {
			updateMock.mockClear();
			findRegistryMock.mockReset();
			ghcrAuthMock.mockReset();
			ghcrAuthMock.mockResolvedValue(undefined);
			inspectMock.mockResolvedValue({
				Version: { Index: 7 },
				Spec: { TaskTemplate: { ForceUpdate: 2 } },
			} as never);
			getServiceMock.mockReturnValue({
				inspect: inspectMock,
				update: updateMock,
			} as never);
		});

		const sentAuth = () => updateMock.mock.calls[0]?.[0].authconfig;

		it("sends an anonymous auth for the image host when there are no credentials", async () => {
			await mechanizeDockerContainer(
				createApplication({
					dockerImage: "ghcr.io/devinosolutions/app@sha256:abc",
				}),
			);

			expect(updateMock).toHaveBeenCalledTimes(1);
			expect(sentAuth()).toEqual({ serveraddress: "ghcr.io" });
			expect(sentAuth()).not.toHaveProperty("username");
			expect(sentAuth()).not.toHaveProperty("password");
		});

		it("defaults the host to docker.io for an image without a registry host", async () => {
			await mechanizeDockerContainer(
				createApplication({ dockerImage: "nginx:1.27" }),
			);

			expect(sentAuth()).toEqual({ serveraddress: "docker.io" });
		});

		it("keeps the real credentials when getAuthConfig returns them", async () => {
			await mechanizeDockerContainer(
				createApplication({
					dockerImage: "registry.example.com:8443/team/app:1",
					username: "deploy",
					password: "s3cret",
					registryUrl: "registry.example.com:8443",
				}),
			);

			expect(sentAuth()).toEqual({
				username: "deploy",
				password: "s3cret",
				serveraddress: "registry.example.com:8443",
			});
		});

		it("uses the build registry credentials for a docker image with no registry", async () => {
			// A pinned digest deploy passes { registry: null, buildRegistry }.
			findRegistryMock.mockResolvedValue({
				username: "pusher",
				password: "reg-secret",
				registryUrl: "localhost:5000",
			});

			await mechanizeDockerContainer(
				createApplication({
					dockerImage: "localhost:5000/registry.devino.ca/app@sha256:abc",
					registry: null,
					buildRegistry: {
						registryId: "reg-1",
						registryType: "cloud",
						registryUrl: "localhost:5000",
					} as never,
				}),
			);

			expect(findRegistryMock).toHaveBeenCalledWith("reg-1");
			expect(sentAuth()).toEqual({
				username: "pusher",
				password: "reg-secret",
				serveraddress: "localhost:5000",
			});
		});

		const staleBuildRegistry = {
			registryId: "reg-1",
			registryType: "cloud",
			registryUrl: "localhost:5000",
		} as never;

		it("does not offer a stale build registry to an image on another host", async () => {
			await mechanizeDockerContainer(
				createApplication({
					dockerImage: "ghcr.io/x/y@sha256:abc",
					registry: null,
					buildRegistry: staleBuildRegistry,
				}),
			);

			expect(findRegistryMock).not.toHaveBeenCalled();
			expect(sentAuth()).toEqual({ serveraddress: "ghcr.io" });
		});

		it("uses the GitHub login for ghcr.io when the build registry is another host", async () => {
			const creds = {
				username: "gh-user",
				password: "gh-token",
				serveraddress: "ghcr.io",
			};
			ghcrAuthMock.mockResolvedValue(creds);

			await mechanizeDockerContainer(
				createApplication({
					applicationId: "app-1",
					dockerImage: "ghcr.io/x/y@sha256:abc",
					registry: null,
					buildRegistry: staleBuildRegistry,
				}),
			);

			expect(findRegistryMock).not.toHaveBeenCalled();
			expect(ghcrAuthMock).toHaveBeenCalledWith(
				"app-1",
				"ghcr.io/x/y@sha256:abc",
			);
			expect(sentAuth()).toEqual(creds);
		});

		it("matches a build registry URL written with a scheme and a trailing slash", async () => {
			findRegistryMock.mockResolvedValue({
				username: "pusher",
				password: "reg-secret",
				registryUrl: "https://localhost:5000/",
			});

			await mechanizeDockerContainer(
				createApplication({
					dockerImage: "localhost:5000/registry.devino.ca/app@sha256:abc",
					registry: null,
					buildRegistry: {
						registryId: "reg-1",
						registryType: "cloud",
						registryUrl: "https://localhost:5000/",
					} as never,
				}),
			);

			expect(findRegistryMock).toHaveBeenCalledWith("reg-1");
			expect(sentAuth()).toMatchObject({ username: "pusher" });
		});

		it("passes the same auth to createService when the service does not exist yet", async () => {
			inspectMock.mockRejectedValue(new Error("service not found"));

			await mechanizeDockerContainer(
				createApplication({
					dockerImage: "ghcr.io/devinosolutions/app@sha256:abc",
				}),
			);

			expect(createServiceMock).toHaveBeenCalledTimes(1);
			const [auth, settings] = createServiceMock.mock.calls[0] ?? [];
			expect(auth).toEqual({ serveraddress: "ghcr.io" });
			expect(settings?.authconfig).toEqual({ serveraddress: "ghcr.io" });
		});
	});
});
