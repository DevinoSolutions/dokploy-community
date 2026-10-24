import { writeTraefikSetup } from "@dokploy/server/services/settings";
import {
	initializeStandaloneTraefik,
	initializeTraefikService,
	TRAEFIK_IMAGE,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Routine Traefik actions (save env, save ports, dashboard toggle) all go
// through writeTraefikSetup without an image; only updateTraefik passes one.

const mocks = vi.hoisted(() => ({
	getRemoteDocker: vi.fn(),
	execAsync: vi.fn(),
	findMany: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { compose: { findMany: mocks.findMany } } },
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
}));

// Never the pin, so keeping it can't be mistaken for falling back to it.
const OLDER = "traefik:v3.5.4";
const NEWER = "traefik:v9.9.9";

const fakeDocker = ({
	container,
	service,
}: {
	container?: string | null;
	service?: string | null;
}) => {
	const log: string[] = [];
	const containers: { id: string; name: string; image?: string }[] = [];
	if (container !== undefined && container !== null) {
		containers.push({ id: "old", name: "dokploy-traefik", image: container });
	}
	let created = 0;
	const createdImages: string[] = [];
	const serviceUpdates: Record<string, unknown>[] = [];
	const serviceCreates: Record<string, unknown>[] = [];

	const find = (ref: string) => {
		const found = containers.find((c) => c.id === ref || c.name === ref);
		if (!found) throw new Error(`No such container: ${ref}`);
		return found;
	};
	const handle = (ref: string) => ({
		inspect: async () => {
			const c = find(ref);
			return {
				Id: c.id,
				Config: { Image: c.image },
				State: { Running: true, StartedAt: "steady" },
			};
		},
		rename: async ({ name }: { name: string }) => {
			find(ref).name = name;
			log.push(`rename ${ref} -> ${name}`);
		},
		stop: async () => {
			log.push(`stop ${ref}`);
		},
		start: async () => {
			log.push(`start ${ref}`);
		},
		remove: async () => {
			const c = find(ref);
			containers.splice(containers.indexOf(c), 1);
			log.push(`remove ${ref}`);
		},
		logs: async () => Buffer.alloc(0),
	});

	const docker = {
		getImage: (name: string) => ({
			inspect: async () => {
				log.push(`image inspect ${name}`);
				return {};
			},
		}),
		getContainer: (ref: string) => handle(ref),
		createContainer: async (settings: { name: string; Image: string }) => {
			created += 1;
			const id = `new${created}`;
			containers.push({ id, name: settings.name, image: settings.Image });
			createdImages.push(settings.Image);
			log.push(`create ${settings.Image}`);
			return handle(id);
		},
		getService: () => ({
			inspect: async () => {
				if (service === undefined || service === null) {
					throw new Error("service dokploy-traefik not found");
				}
				return {
					Version: { Index: "7" },
					Spec: {
						TaskTemplate: { ContainerSpec: { Image: service }, ForceUpdate: 0 },
					},
				};
			},
			update: async (options: Record<string, unknown>) => {
				serviceUpdates.push(options);
				log.push("service update");
			},
		}),
		createService: async (options: Record<string, unknown>) => {
			serviceCreates.push(options);
			log.push("service create");
		},
	};

	const serviceImage = (options: Record<string, unknown> | undefined) =>
		(
			options?.TaskTemplate as
				| { ContainerSpec?: { Image?: string } }
				| undefined
		)?.ContainerSpec?.Image;

	return {
		docker,
		log,
		createdImages,
		serviceUpdates,
		serviceCreates,
		serviceImage,
		resourceType: () =>
			service !== undefined && service !== null
				? "service"
				: containers.some((c) => c.name === "dokploy-traefik")
					? "standalone"
					: "unknown",
	};
};

const use = (fake: ReturnType<typeof fakeDocker>) => {
	mocks.getRemoteDocker.mockResolvedValue(fake.docker);
	mocks.execAsync.mockImplementation(async () => ({
		stdout: fake.resourceType(),
		stderr: "",
	}));
};

const settle = async <T>(promise: Promise<T>) => {
	const result = promise.then(
		() => null,
		(error: Error) => error,
	);
	await vi.runAllTimersAsync();
	return result;
};

describe("routine Traefik recreates keep the running image", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		mocks.findMany.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("the pin is the 3.6.25 this release keeps", () => {
		expect(TRAEFIK_IMAGE).toBe("traefik:v3.6.25");
	});

	it.each([OLDER, NEWER, `${OLDER}@sha256:abc123`, "registry.local:5000/traefik:v3.5.4"])(
		"a routine action on a container running %s recreates it with that image",
		async (running) => {
			const fake = fakeDocker({ container: running });
			use(fake);

			const error = await settle(
				writeTraefikSetup({
					env: ["A=1"],
					additionalPorts: [
						{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
					],
				}),
			);

			expect(error).toBeNull();
			expect(fake.createdImages).toEqual([running]);
			expect(fake.log).toContain(`image inspect ${running}`);
			expect(fake.log).not.toContain(`image inspect ${TRAEFIK_IMAGE}`);
		},
	);

	it("a recreate on a remote server keeps that server's image too", async () => {
		const fake = fakeDocker({ container: OLDER });
		use(fake);

		const error = await settle(
			initializeStandaloneTraefik({ serverId: "server-a" }),
		);

		expect(error).toBeNull();
		expect(mocks.getRemoteDocker).toHaveBeenCalledWith("server-a");
		expect(fake.createdImages).toEqual([OLDER]);
	});

	it("the explicit update recreates with the image it names", async () => {
		const fake = fakeDocker({ container: OLDER });
		use(fake);

		const error = await settle(writeTraefikSetup({ image: TRAEFIK_IMAGE }));

		expect(error).toBeNull();
		expect(fake.createdImages).toEqual([TRAEFIK_IMAGE]);
	});

	it("a fresh install with no Traefik uses the pin", async () => {
		const fake = fakeDocker({ container: null });
		use(fake);

		const error = await settle(initializeStandaloneTraefik());

		expect(error).toBeNull();
		expect(fake.createdImages).toEqual([TRAEFIK_IMAGE]);
	});

	it.each(["traefik", "localhost:5000/traefik", "sha256:0123abcd", ""])(
		"refuses a routine action when the running image %j has no readable tag, touching nothing",
		async (running) => {
			const fake = fakeDocker({ container: running });
			use(fake);

			const error = await settle(writeTraefikSetup({ env: ["A=1"] }));

			expect(error?.message).toContain(
				"Can't read the version tag of the running Traefik image",
			);
			expect(fake.createdImages).toEqual([]);
			expect(fake.log).toEqual([]);
		},
	);
});

describe("routine Traefik updates of a Swarm service keep its image", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		mocks.findMany.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("a routine action keeps the service image, digest included", async () => {
		const running = `${OLDER}@sha256:abc123`;
		const fake = fakeDocker({ service: running });
		use(fake);

		const error = await settle(writeTraefikSetup({ env: ["A=1"] }));

		expect(error).toBeNull();
		expect(fake.serviceUpdates).toHaveLength(1);
		expect(fake.serviceImage(fake.serviceUpdates[0])).toBe(running);
		expect(fake.serviceCreates).toEqual([]);
	});

	it("the explicit update changes the service image", async () => {
		const fake = fakeDocker({ service: OLDER });
		use(fake);

		const error = await settle(writeTraefikSetup({ image: TRAEFIK_IMAGE }));

		expect(error).toBeNull();
		expect(fake.serviceImage(fake.serviceUpdates[0])).toBe(TRAEFIK_IMAGE);
	});

	it("a first setup with no service creates it from the pin", async () => {
		const fake = fakeDocker({ service: null });
		use(fake);

		await initializeTraefikService({});

		expect(fake.serviceImage(fake.serviceCreates[0])).toBe(TRAEFIK_IMAGE);
	});

	it("refuses when the service image has no readable tag", async () => {
		const fake = fakeDocker({ service: "traefik@sha256:abc123" });
		use(fake);

		const error = await settle(writeTraefikSetup({ env: ["A=1"] }));

		expect(error?.message).toContain(
			"Can't read the version tag of the running Traefik image",
		);
		expect(fake.serviceUpdates).toEqual([]);
		expect(fake.serviceCreates).toEqual([]);
	});
});
