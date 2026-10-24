import { writeTraefikSetup } from "@dokploy/server/services/settings";
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

const fakeDocker = (
	initial: { id: string; name: string; running: boolean }[],
) => {
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
			return { Id: c.id, State: { Running: c.running, StartedAt: "steady" } };
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
		getImage: () => ({ inspect: async () => ({}) }),
		getContainer: (ref: string) => container(ref),
		createContainer: async (settings: Record<string, unknown>) => {
			const name = settings.name as string;
			if (containers.some((c) => c.name === name)) {
				throw new Error(`Conflict: ${name} is already in use`);
			}
			created += 1;
			const id = created === 1 ? "new" : `new${created}`;
			containers.push({ id, name, running: false });
			log.push(`create ${id}`);
			return container(id);
		},
	};

	// getDockerResourceType asks the shell; answer from the fake containers.
	const resourceType = () =>
		containers.some((c) => c.name === "dokploy-traefik")
			? "standalone"
			: "unknown";

	return { docker, log, containers, resourceType };
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
			{ id: "old", name: "dokploy-traefik", running: true },
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
		expect(fake.containers).toEqual([
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
		expect(fake.containers).toEqual([
			{ id: "new2", name: "dokploy-traefik", running: true },
		]);
	});

	it("a startup restore queued behind an in-flight recreate waits for it", async () => {
		const fake = fakeDocker([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);
		mocks.execAsync.mockImplementation(async () => ({
			stdout: fake.resourceType(),
			stderr: "",
		}));

		const action = writeTraefikSetup({ env: ["A=1"] });
		await vi.advanceTimersByTimeAsync(1000);
		expect(fake.containers).toEqual([
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
		expect(fake.containers).toEqual([
			{ id: "new", name: "dokploy-traefik", running: true },
		]);
	});

	it("restores a backup left by an interrupted recreate inside its own queued job", async () => {
		const fake = fakeDocker([
			{ id: "stale", name: "dokploy-traefik-previous", running: false },
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
		expect(fake.containers).toEqual([
			{ id: "new", name: "dokploy-traefik", running: true },
		]);
	});
});
