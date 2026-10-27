import {
	initializeStandaloneTraefik,
	lastLogLine,
	restoreInterruptedTraefik,
	TRAEFIK_VERSION,
} from "@dokploy/server/setup/traefik-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRemoteDocker: vi.fn() }));

vi.mock("@dokploy/server/db", () => ({ db: {} }));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

const PREVIOUS_NAME = "dokploy-traefik-previous";

const RENAME_RUNNING_ERROR =
	"could not add service state for endpoint dokploy-traefik-previous to cluster on UpdateDNSNames: cannot create entry in table endpoint_table, already exists";

const frame = (text: string) => {
	const payload = Buffer.from(text);
	const header = Buffer.alloc(8);
	header.writeUInt8(2, 0);
	header.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, payload]);
};

const CRASH_LOG = frame(
	"\u001b[90m2026-10-23T05:00:00Z\u001b[0m ERR field not found, node: bogus\n",
);

interface FakeOptions {
	oldRunning?: boolean | null;
	staleBackup?: boolean;
	imagePresent?: boolean;
	pullEvents?: { error?: string }[];
	startError?: Error;
	crashLoop?: boolean;
	restoreError?: Error;
	renameError?: Error;
	stopError?: Error;
	startOldError?: Error;
	restartOnRename?: boolean;
	backupRunning?: boolean;
	oldImage?: string;
}

// An image ID that is a pure function of the reference, so every tag here
// still names the image its container runs.
const imageId = (reference: string) =>
	reference.startsWith("sha256:")
		? reference
		: `sha256:${Buffer.from(reference).toString("hex")}`;

const fakeDocker = ({
	oldRunning = true,
	staleBackup = false,
	imagePresent = true,
	pullEvents = [],
	startError,
	crashLoop = false,
	restoreError,
	renameError,
	stopError,
	startOldError,
	restartOnRename = false,
	backupRunning = false,
	oldImage = `traefik:v${TRAEFIK_VERSION}`,
}: FakeOptions = {}) => {
	const log: string[] = [];
	const containers: {
		id: string;
		name: string;
		running: boolean;
		image?: string;
	}[] = [];
	if (oldRunning !== null) {
		containers.push({
			id: "old",
			name: "dokploy-traefik",
			running: oldRunning,
			image: oldImage,
		});
	}
	if (staleBackup) {
		containers.push({
			id: "stale",
			name: "dokploy-traefik-previous",
			running: backupRunning,
			image: oldImage,
		});
	}
	let hasImage = imagePresent;
	let restarts = 0;
	let created = 0;
	let createdWith: Record<string, unknown> | undefined;

	const find = (ref: string) => {
		const found = containers.find((c) => c.id === ref || c.name === ref);
		if (!found) throw new Error(`No such container: ${ref}`);
		return found;
	};

	const container = (ref: string) => ({
		inspect: async () => {
			const c = find(ref);
			const startedAt =
				c.id === "new" && crashLoop ? `crash-${++restarts}` : "steady";
			return {
				Id: c.id,
				Image: imageId(c.image ?? ""),
				Config: { Image: c.image },
				State: { Running: c.running, StartedAt: startedAt },
			};
		},
		rename: async ({ name }: { name: string }) => {
			const c = find(ref);
			// Docker refuses this for a container on a swarm overlay network.
			if (c.running) throw new Error(RENAME_RUNNING_ERROR);
			if (renameError && c.id === "old" && name === PREVIOUS_NAME) {
				throw renameError;
			}
			if (
				restoreError &&
				(c.id === "old" || c.id === "stale") &&
				name === "dokploy-traefik"
			) {
				throw restoreError;
			}
			log.push(`rename ${c.id} -> ${name}`);
			c.name = name;
			// The restart policy brings it back once it has its name again.
			if (restartOnRename && c.id === "old" && name === "dokploy-traefik") {
				c.running = true;
			}
		},
		stop: async () => {
			const c = find(ref);
			log.push(`stop ${c.id}`);
			if (stopError && c.id === "old") throw stopError;
			c.running = false;
		},
		start: async () => {
			const c = find(ref);
			log.push(`start ${c.id}`);
			// What Docker answers for a container that already runs.
			if (c.running) throw new Error("container already started");
			if (startError && c.id === "new") throw startError;
			if (startOldError && c.id === "old") throw startOldError;
			c.running = true;
		},
		remove: async () => {
			const c = find(ref);
			log.push(`remove ${c.id}`);
			containers.splice(containers.indexOf(c), 1);
		},
		logs: async () => CRASH_LOG,
	});

	const docker = {
		getImage: (reference: string) => ({
			inspect: async () => {
				if (!hasImage) throw new Error("No such image");
				return { Id: imageId(reference) };
			},
		}),
		pull: async () => {
			log.push("pull");
			return "stream";
		},
		modem: {
			followProgress: (
				_stream: unknown,
				done: (error: Error | null, events: unknown[]) => void,
			) => {
				hasImage = !pullEvents.some((event) => event.error);
				done(null, pullEvents);
			},
		},
		getContainer: (ref: string) => container(ref),
		createContainer: async (settings: Record<string, unknown>) => {
			const name = settings.name as string;
			if (containers.some((c) => c.name === name)) {
				throw new Error(`Conflict: ${name} is already in use`);
			}
			createdWith = settings;
			created += 1;
			const id = created === 1 ? "new" : `new${created}`;
			containers.push({
				id,
				name,
				running: false,
				image: settings.Image as string,
			});
			log.push(`create ${id}`);
			return container(id);
		},
	};

	return {
		docker,
		log,
		containers,
		createdWith: () => createdWith,
	};
};

const recreate = async (
	fake: ReturnType<typeof fakeDocker>,
	options: Parameters<typeof initializeStandaloneTraefik>[0] = {},
) => {
	mocks.getRemoteDocker.mockResolvedValue(fake.docker);
	const result = initializeStandaloneTraefik(options).then(
		() => null,
		(error: Error) => error,
	);
	await vi.runAllTimersAsync();
	return result;
};

describe("initializeStandaloneTraefik", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps the old container until the new one stays up, then removes it", async () => {
		const fake = fakeDocker();

		const error = await recreate(fake, {
			additionalPorts: [
				{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
			],
		});

		expect(error).toBeNull();
		expect(fake.log).toEqual([
			"stop old",
			"rename old -> dokploy-traefik-previous",
			"create new",
			"start new",
			"remove old",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "new", name: "dokploy-traefik", running: true },
		]);
		expect(fake.createdWith()).toMatchObject({
			name: "dokploy-traefik",
			Image: `traefik:v${TRAEFIK_VERSION}`,
			HostConfig: { PortBindings: { "8080/tcp": [{ HostPort: "8080" }] } },
		});
	});

	// Only the explicit update (and a first install) downloads an image.
	it("downloads the image first and touches nothing when the download fails", async () => {
		const fake = fakeDocker({
			imagePresent: false,
			pullEvents: [{ error: "toomanyrequests: pull rate limit reached" }],
		});

		const error = await recreate(fake, {
			image: `traefik:v${TRAEFIK_VERSION}`,
		});

		expect(error?.message).toContain("toomanyrequests");
		expect(fake.log).toEqual(["pull"]);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
	});

	it("downloads a missing image before recreating", async () => {
		const fake = fakeDocker({ imagePresent: false });

		const error = await recreate(fake, {
			image: `traefik:v${TRAEFIK_VERSION}`,
		});

		expect(error).toBeNull();
		expect(fake.log[0]).toBe("pull");
		expect(fake.log).toContain("remove old");
	});

	it("puts the old container back when the new one cannot start", async () => {
		const fake = fakeDocker({
			startError: new Error("port is already allocated"),
		});

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"port is already allocated. The previous Traefik was restored.",
		);
		expect(fake.log).toEqual([
			"stop old",
			"rename old -> dokploy-traefik-previous",
			"create new",
			"start new",
			"remove new",
			"rename old -> dokploy-traefik",
			"start old",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
	});

	it("puts the old container back when the new one exits right after starting, with its last log line", async () => {
		const fake = fakeDocker({ crashLoop: true });

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"The new Traefik container stopped right after starting: 2026-10-23T05:00:00Z ERR field not found, node: bogus. The previous Traefik was restored.",
		);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
	});

	it("leaves a Traefik that was stopped stopped when putting it back", async () => {
		const fake = fakeDocker({
			oldRunning: false,
			startError: new Error("port is already allocated"),
		});

		const error = await recreate(fake);

		expect(error?.message).toContain("The previous Traefik was restored");
		expect(fake.log).not.toContain("start old");
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: false },
		]);
	});

	it("clears a backup left by an interrupted recreate before renaming", async () => {
		const fake = fakeDocker({ staleBackup: true });

		const error = await recreate(fake);

		expect(error).toBeNull();
		expect(fake.log.slice(0, 3)).toEqual([
			"remove stale",
			"stop old",
			"rename old -> dokploy-traefik-previous",
		]);
	});

	it("says so when putting the old container back also fails", async () => {
		const fake = fakeDocker({
			startError: new Error("port is already allocated"),
			restoreError: new Error("name already in use"),
		});

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"port is already allocated. Restoring the previous Traefik also failed: name already in use",
		);
	});

	it("never renames a running Traefik: Docker refuses that on the overlay network", async () => {
		const fake = fakeDocker();

		const error = await recreate(fake);

		expect(error).toBeNull();
		expect(fake.log.slice(0, 2)).toEqual([
			"stop old",
			"rename old -> dokploy-traefik-previous",
		]);
	});

	it("starts the old Traefik again when it cannot be renamed", async () => {
		const fake = fakeDocker({
			renameError: new Error("name is already in use"),
		});

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"Could not rename the Traefik container: name is already in use. The previous Traefik was started again.",
		);
		expect(fake.log).toEqual(["stop old", "start old"]);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
	});

	it("leaves a stopped Traefik stopped when it cannot be renamed", async () => {
		const fake = fakeDocker({
			oldRunning: false,
			renameError: new Error("name is already in use"),
		});

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"Could not rename the Traefik container: name is already in use. The previous Traefik was left as it was.",
		);
		expect(fake.log).not.toContain("start old");
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: false },
		]);
	});

	it("keeps the running Traefik when it cannot be stopped, and fails with the rename error", async () => {
		const fake = fakeDocker({ stopError: new Error("cannot stop container") });

		const error = await recreate(fake);

		expect(error?.message).toBe(
			`Could not rename the Traefik container: ${RENAME_RUNNING_ERROR}. The previous Traefik was left running.`,
		);
		// It never stopped, so it is not started again.
		expect(fake.log).toEqual(["stop old"]);
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
	});

	it("does not fail the put-back when the old Traefik is already running again", async () => {
		const fake = fakeDocker({
			startError: new Error("port is already allocated"),
			restartOnRename: true,
		});

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"port is already allocated. The previous Traefik was restored.",
		);
		expect(fake.log).not.toContain("start old");
		expect(fake.containers).toMatchObject([
			{ id: "old", name: "dokploy-traefik", running: true },
		]);
	});

	it("says so when the old Traefik cannot be started again after a failed rename", async () => {
		const fake = fakeDocker({
			renameError: new Error("name is already in use"),
			startOldError: new Error("port is already allocated"),
		});

		const error = await recreate(fake);

		expect(error?.message).toBe(
			"Could not rename the Traefik container: name is already in use. Starting it again also failed: port is already allocated",
		);
	});

	it("runs overlapping recreates of the same server one after another", async () => {
		const fake = fakeDocker();
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		const first = initializeStandaloneTraefik({
			additionalPorts: [
				{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
			],
		});
		const second = initializeStandaloneTraefik();
		await vi.runAllTimersAsync();

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		expect(fake.log).toEqual([
			"stop old",
			"rename old -> dokploy-traefik-previous",
			"create new",
			"start new",
			"remove old",
			"stop new",
			"rename new -> dokploy-traefik-previous",
			"create new2",
			"start new2",
			"remove new",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "new2", name: "dokploy-traefik", running: true },
		]);
	});

	it("still runs the next recreate after one fails", async () => {
		const fake = fakeDocker({
			startError: new Error("port is already allocated"),
		});
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		const first = initializeStandaloneTraefik().then(
			() => null,
			(error: Error) => error,
		);
		const second = initializeStandaloneTraefik().then(
			() => null,
			(error: Error) => error,
		);
		await vi.runAllTimersAsync();

		expect((await first)?.message).toContain(
			"The previous Traefik was restored",
		);
		expect(await second).toBeNull();
		expect(fake.containers).toMatchObject([
			{ id: "new2", name: "dokploy-traefik", running: true },
		]);
	});

	it("creates Traefik when none exists yet, as on a fresh setup", async () => {
		const fake = fakeDocker({ oldRunning: null });

		const error = await recreate(fake);

		expect(error).toBeNull();
		expect(fake.log).toEqual(["create new", "start new"]);
	});

	it("keeps the old behaviour on a fresh setup that fails: logs instead of throwing", async () => {
		const fake = fakeDocker({
			oldRunning: null,
			startError: new Error("port is already allocated"),
		});

		const error = await recreate(fake);

		expect(error).toBeNull();
		expect(fake.log).toEqual(["create new", "start new"]);
	});
});

describe("restoreInterruptedTraefik", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("brings back the backup when an interrupted recreate left only it", async () => {
		const fake = fakeDocker({ oldRunning: null, staleBackup: true });
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		await restoreInterruptedTraefik();

		expect(fake.log).toEqual([
			"rename stale -> dokploy-traefik",
			"start stale",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "stale", name: "dokploy-traefik", running: true },
		]);
	});

	it("leaves things alone when Traefik exists", async () => {
		const fake = fakeDocker({ staleBackup: true });
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		await restoreInterruptedTraefik();

		expect(fake.log).toEqual([]);
	});

	it("does nothing when there is no backup", async () => {
		const fake = fakeDocker({ oldRunning: null });
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		await restoreInterruptedTraefik();

		expect(fake.log).toEqual([]);
	});

	it("stops a running backup before renaming it, then starts it again", async () => {
		const fake = fakeDocker({
			oldRunning: null,
			staleBackup: true,
			backupRunning: true,
		});
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		await restoreInterruptedTraefik();

		expect(fake.log).toEqual([
			"stop stale",
			"rename stale -> dokploy-traefik",
			"start stale",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "stale", name: "dokploy-traefik", running: true },
		]);
	});

	it("starts a running backup again when it cannot be renamed", async () => {
		const fake = fakeDocker({
			oldRunning: null,
			staleBackup: true,
			backupRunning: true,
			restoreError: new Error("name is already in use"),
		});
		mocks.getRemoteDocker.mockResolvedValue(fake.docker);

		await expect(restoreInterruptedTraefik()).rejects.toThrow(
			"name is already in use",
		);

		expect(fake.log).toEqual(["stop stale", "start stale"]);
		expect(fake.containers).toMatchObject([
			{ id: "stale", name: "dokploy-traefik-previous", running: true },
		]);
	});

	it("restores the backup before recreating", async () => {
		const fake = fakeDocker({ oldRunning: null, staleBackup: true });

		const error = await recreate(fake);

		expect(error).toBeNull();
		expect(fake.log).toEqual([
			"rename stale -> dokploy-traefik",
			"start stale",
			"stop stale",
			"rename stale -> dokploy-traefik-previous",
			"create new",
			"start new",
			"remove stale",
		]);
		expect(fake.containers).toMatchObject([
			{ id: "new", name: "dokploy-traefik", running: true },
		]);
	});
});

describe("lastLogLine", () => {
	it("returns the last line across frames without colour codes", () => {
		const logs = Buffer.concat([
			frame("first line\n"),
			frame("\u001b[31mERR\u001b[0m second line\n"),
		]);

		expect(lastLogLine(logs)).toBe("ERR second line");
	});

	it("caps very long lines", () => {
		expect(lastLogLine(frame(`${"x".repeat(500)}\n`))).toHaveLength(300);
	});

	it("handles empty logs", () => {
		expect(lastLogLine(Buffer.alloc(0))).toBe("");
	});
});
