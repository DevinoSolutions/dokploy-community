import {
	reloadDockerResource,
	writeTraefikSetup,
} from "@dokploy/server/services/settings";
import {
	queueTraefikRecreate,
	restoreInterruptedTraefik,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

type FakeContainer = {
	id: string;
	name: string;
	running: boolean;
	image?: string;
	env?: string[];
	ports?: Record<string, { HostPort: string }[]>;
};

const fakeDocker = (initial: FakeContainer[]) => {
	const log: string[] = [];
	const containers = initial.map((c) => ({ ...c }));
	let created = 0;

	const find = (ref: string) => {
		const found = containers.find((c) => c.id === ref || c.name === ref);
		if (!found) throw new Error(`No such container: ${ref}`);
		return found;
	};

	const container = (ref: string) => ({
		inspect: async () => {
			const c = find(ref);
			return {
				Id: c.id,
				Image: `id:${c.image}`,
				Config: { Image: c.image, Env: c.env },
				State: { Running: c.running, StartedAt: "steady" },
			};
		},
		rename: async ({ name }: { name: string }) => {
			const c = find(ref);
			log.push(`rename ${c.id} -> ${name}`);
			c.name = name;
		},
		stop: async () => {
			const c = find(ref);
			log.push(`stop ${c.id}`);
			c.running = false;
		},
		start: async () => {
			const c = find(ref);
			log.push(`start ${c.id}`);
			c.running = true;
		},
		remove: async () => {
			const c = find(ref);
			log.push(`remove ${c.id}`);
			containers.splice(containers.indexOf(c), 1);
		},
		logs: async () => Buffer.alloc(0),
	});

	const docker = {
		// Every tag still names the image its container runs.
		getImage: (reference: string) => ({
			inspect: async () => ({ Id: `id:${reference}` }),
		}),
		getContainer: (ref: string) => container(ref),
		createContainer: async (settings: Record<string, unknown>) => {
			const name = settings.name as string;
			if (containers.some((c) => c.name === name)) {
				throw new Error(`Conflict: ${name} is already in use`);
			}
			created += 1;
			const id = created === 1 ? "new" : `new${created}`;
			containers.push({
				id,
				name,
				running: false,
				image: settings.Image as string,
				env: settings.Env as string[] | undefined,
				ports: (settings.HostConfig as { PortBindings: FakeContainer["ports"] })
					.PortBindings,
			});
			log.push(`create ${id}`);
			return container(id);
		},
	};

	// getDockerResourceType asks the shell; answer from the fake containers.
	const resourceType = () =>
		containers.some((c) => c.name === "dokploy-traefik")
			? "standalone"
			: "unknown";

	// What the shell commands that read the live container would print.
	const shell = (command: string) => {
		if (command.includes("RESOURCE_NAME")) return resourceType();
		const live = containers.find((c) => c.name === "dokploy-traefik");
		if (command.includes(".Config.Env")) {
			return JSON.stringify(live?.env ?? null);
		}
		if (command.includes(".NetworkSettings.Ports")) {
			return JSON.stringify(live?.ports ?? {});
		}
		log.push(`exec ${command}`);
		return "";
	};

	return {
		docker,
		log,
		containers,
		resourceType,
		shell,
		images: () => containers.map((c) => [c.id, c.image]),
	};
};

describe("writeTraefikSetup", () => {
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

	it("never restores the backup of a recreate that is still in flight", async () => {
		const fake = fakeDocker([
			{
				id: "old",
				name: "dokploy-traefik",
				running: true,
				image: "traefik:v3.6.25",
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async () => ({
			stdout: fake.resourceType(),
			stderr: "",
		}));

		const first = writeTraefikSetup({ env: ["A=1"] });
		// Let the first recreate rename the old container away and sit in its
		// stop delay before the second action starts.
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik-previous", running: false },
		]);
		const second = writeTraefikSetup({ env: ["A=2"] });
		await vi.runAllTimersAsync();

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		expect(fake.log).not.toContain("rename old -> dokploy-traefik");
		expect(fake.log).toEqual([
			"rename old -> dokploy-traefik-previous",
			"stop old",
			"create new",
			"start new",
			"remove old",
			"rename new -> dokploy-traefik-previous",
			"stop new",
			"create new2",
			"start new2",
			"remove new",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "new2", name: "dokploy-traefik", running: true },
		]);
	});

	it("a startup restore queued behind an in-flight recreate waits for it", async () => {
		const fake = fakeDocker([
			{
				id: "old",
				name: "dokploy-traefik",
				running: true,
				image: "traefik:v3.6.25",
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async () => ({
			stdout: fake.resourceType(),
			stderr: "",
		}));

		const action = writeTraefikSetup({ env: ["A=1"] });
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik-previous", running: false },
		]);
		// What server.ts does on startup for the local host.
		const startup = queueTraefikRecreate(undefined, () =>
			restoreInterruptedTraefik(),
		);
		await vi.runAllTimersAsync();

		await expect(action).resolves.toBeUndefined();
		await expect(startup).resolves.toBeUndefined();
		expect(fake.log).toEqual([
			"rename old -> dokploy-traefik-previous",
			"stop old",
			"create new",
			"start new",
			"remove old",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "new", name: "dokploy-traefik", running: true },
		]);
	});

	it("reads env and ports when the job runs, so an earlier queued action isn't undone", async () => {
		const fake = fakeDocker([
			{
				id: "old",
				name: "dokploy-traefik",
				running: true,
				image: "traefik:v3.6.25",
				env: ["A=0"],
				ports: {},
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: fake.shell(command),
			stderr: "",
		}));

		// Save env, then save ports: the ports action was prepared before the
		// env action had recreated Traefik.
		const saveEnv = writeTraefikSetup({
			env: ["A=1"],
			additionalPorts: (current) => current,
		});
		await vi.advanceTimersByTimeAsync(1000);
		const savePorts = writeTraefikSetup({
			env: (current) => current,
			additionalPorts: () => [
				{ targetPort: 9000, publishedPort: 9000, protocol: "tcp" },
			],
		});
		await vi.runAllTimersAsync();

		await expect(saveEnv).resolves.toBeUndefined();
		await expect(savePorts).resolves.toBeUndefined();
		expect(fake.containers).toMatchObject([
			{
				name: "dokploy-traefik",
				running: true,
				env: ["A=1"],
				ports: expect.objectContaining({ "9000/tcp": expect.anything() }),
			},
		]);
	});

	it("hands the live env and ports to the functions", async () => {
		const fake = fakeDocker([
			{
				id: "old",
				name: "dokploy-traefik",
				running: true,
				image: "traefik:v3.6.25",
				env: ["A=0", "B=#kept"],
				ports: {
					"80/tcp": [{ HostPort: "80" }],
					"8080/tcp": [{ HostPort: "8080" }],
				},
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: fake.shell(command),
			stderr: "",
		}));
		const env = vi.fn((current: string[]) => current);
		const additionalPorts = vi.fn((current: unknown[]) => current);

		const run = writeTraefikSetup({
			env,
			additionalPorts: additionalPorts as never,
		});
		await vi.runAllTimersAsync();
		await run;

		expect(env).toHaveBeenCalledWith(["A=0", "B=#kept"]);
		expect(additionalPorts).toHaveBeenCalledWith([
			{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
		]);
	});

	it("a reload waits for a recreate in flight instead of restarting inside it", async () => {
		const fake = fakeDocker([
			{
				id: "old",
				name: "dokploy-traefik",
				running: true,
				image: "traefik:v3.6.25",
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: fake.shell(command),
			stderr: "",
		}));

		const action = writeTraefikSetup({ env: ["A=1"] });
		await vi.advanceTimersByTimeAsync(1000);
		const reload = reloadDockerResource("dokploy-traefik");
		await vi.runAllTimersAsync();

		await action;
		await reload;
		expect(fake.log).toEqual([
			"rename old -> dokploy-traefik-previous",
			"stop old",
			"create new",
			"start new",
			"remove old",
			"exec docker restart dokploy-traefik",
		]);
	});

	it("a reload restores the backup of an interrupted recreate first", async () => {
		const fake = fakeDocker([
			{
				id: "stale",
				name: "dokploy-traefik-previous",
				running: false,
				image: "traefik:v3.6.25",
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async (command: string) => ({
			stdout: fake.shell(command),
			stderr: "",
		}));

		await reloadDockerResource("dokploy-traefik");

		expect(fake.log).toEqual([
			"rename stale -> dokploy-traefik",
			"start stale",
			"exec docker restart dokploy-traefik",
		]);
	});

	it("restores a backup left by an interrupted recreate inside its own queued job", async () => {
		const fake = fakeDocker([
			{
				id: "stale",
				name: "dokploy-traefik-previous",
				running: false,
				image: "traefik:v3.6.25",
			},
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async () => ({
			stdout: fake.resourceType(),
			stderr: "",
		}));

		const run = writeTraefikSetup({});
		await vi.runAllTimersAsync();

		await expect(run).resolves.toBeUndefined();
		expect(fake.log).toEqual([
			"rename stale -> dokploy-traefik",
			"start stale",
			"rename stale -> dokploy-traefik-previous",
			"stop stale",
			"create new",
			"start new",
			"remove stale",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "new", name: "dokploy-traefik", running: true },
		]);
	});
});
