import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type InMemoryJob,
	InMemoryQueue,
	type JobOutcome,
	type Lane,
	LOCAL_PARTITION,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

/**
 * The pull lane of the deploy queue (T-12497): pull-only deploys have their own
 * cap and do not wait behind builds. Everything here is deterministic: jobs run
 * until the test finishes them, the classifier answers from a plan or from a
 * deferred promise the test resolves, and time only moves where a test uses fake
 * timers. `settle` just drains the microtask queue.
 */

afterEach(() => {
	vi.useRealTimers();
});

/** Let every pending promise continuation of the queue run. */
const settle = async () => {
	for (let i = 0; i < 80; i++) await Promise.resolve();
};

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

/** A deploy of `service`; `label` tells two jobs of one service apart. */
const job = (
	service: string,
	label = service,
	extra: Record<string, unknown> = {},
) =>
	({
		applicationId: service,
		titleLog: label,
		descriptionLog: "",
		type: "deploy",
		applicationType: "application",
		...extra,
	}) as DeploymentJob;

const labelOf = (data: DeploymentJob) => data.titleLog;
const serviceOf = (data: DeploymentJob) =>
	(data as { applicationId: string }).applicationId;

/** What the classifier answers for a label: a lane, a throw, or a call-by-call function. */
type Plan =
	| Lane
	| "throw"
	| Promise<Lane>
	| ((call: number) => Lane | Promise<Lane>);

interface HarnessOptions {
	build: number;
	/** The pull cap; a function so a test can change it between ticks. */
	pull?: number | (() => number);
	/** Whether the queue has a classifier at all (default true). */
	classifier?: boolean;
	paused?: boolean;
	laneRecheckTimeoutMs?: number;
	/** Start the queue without a worker, so nothing ever runs. */
	noWorker?: boolean;
}

const harness = (options: HarnessOptions) => {
	const plan: Record<string, Plan> = {};
	const calls: Record<string, number> = {};
	const classify = vi.fn(async (data: DeploymentJob): Promise<Lane> => {
		const label = labelOf(data);
		calls[label] = (calls[label] ?? 0) + 1;
		const answer = plan[label];
		if (answer === undefined) return "build";
		if (answer === "throw") throw new Error("classifier failed");
		if (typeof answer === "function") return answer(calls[label] as number);
		return answer;
	});

	const started: string[] = [];
	const startedAs = new Map<string, Lane | undefined>();
	const running = new Map<
		string,
		{ lane: Lane; finish: (o?: JobOutcome) => void }
	>();
	const live: Record<Lane, number> = { build: 0, pull: 0 };
	const peak: Record<Lane, number> = { build: 0, pull: 0 };
	const liveByService = new Map<string, number>();
	let peakPerService = 0;
	const wentAheadOf = new Map<string, number | undefined>();

	const queue = new InMemoryQueue({
		resolveConcurrency: () => options.build,
		resolvePullConcurrency:
			options.pull === undefined
				? undefined
				: typeof options.pull === "function"
					? options.pull
					: () => options.pull as number,
		classifyLane: options.classifier === false ? undefined : classify,
		laneRecheckTimeoutMs: options.laneRecheckTimeoutMs,
	});
	if (options.paused) queue.pause();
	if (!options.noWorker) {
		queue.process((queued: InMemoryJob) => {
			const label = labelOf(queued.data);
			const service = serviceOf(queued.data);
			const lane = queued.lane as Lane;
			started.push(label);
			startedAs.set(label, queued.lane);
			wentAheadOf.set(label, queued.wentAheadOf);
			live[lane]++;
			peak[lane] = Math.max(peak[lane], live[lane]);
			const inService = (liveByService.get(service) ?? 0) + 1;
			liveByService.set(service, inService);
			peakPerService = Math.max(peakPerService, inService);
			return new Promise<JobOutcome | undefined>((resolve) => {
				running.set(label, {
					lane,
					finish: (outcome) => {
						live[lane]--;
						liveByService.set(service, (liveByService.get(service) ?? 1) - 1);
						resolve(outcome);
					},
				});
			});
		});
	}

	const finish = async (label: string, outcome?: JobOutcome) => {
		const entry = running.get(label);
		if (!entry) throw new Error(`${label} is not running`);
		running.delete(label);
		entry.finish(outcome);
		await settle();
	};

	const add = async (...jobs: DeploymentJob[]) => {
		for (const data of jobs) await queue.add(data);
		await settle();
	};

	const lanes = async () =>
		Object.fromEntries(
			(await queue.getJobs()).map((queued) => [
				labelOf(queued.data),
				queued.lane,
			]),
		) as Record<string, Lane>;

	const waiting = async () =>
		(await queue.getJobs(["waiting"])).map((queued) => labelOf(queued.data));

	const idOfActive = async (label: string) =>
		(await queue.getJobs(["active"])).find(
			(queued) => labelOf(queued.data) === label,
		)?.id as string;

	return {
		queue,
		plan,
		calls,
		classify,
		started,
		startedAs,
		running,
		live,
		peak,
		get peakPerService() {
			return peakPerService;
		},
		wentAheadOf,
		finish,
		add,
		lanes,
		waiting,
		idOfActive,
	};
};

describe("a pull job does not wait behind builds", () => {
	it("starts at once behind 40 build jobs, and the build cap is never exceeded", async () => {
		const h = harness({ build: 7, pull: 4 });
		h.plan.p1 = "pull";
		const builds = Array.from({ length: 40 }, (_, i) => job(`b${i}`));
		await h.add(...builds, job("p1"));

		expect(h.started).toHaveLength(8);
		expect(h.started).toContain("p1");
		expect(h.started.filter((l) => l !== "p1")).toEqual(
			builds.slice(0, 7).map(labelOf),
		);
		expect(h.live).toEqual({ build: 7, pull: 1 });

		// Drain every build: the build cap holds the whole way.
		for (let i = 0; i < 40; i++) await h.finish(`b${i}`);
		await h.finish("p1");
		expect(h.started).toHaveLength(41);
		expect(h.peak.build).toBe(7);
		expect(h.peak.pull).toBe(1);
	});

	it("runs pull jobs up to the pull cap and no more, oldest first", async () => {
		const h = harness({ build: 1, pull: 4 });
		const pulls = Array.from({ length: 10 }, (_, i) => `p${i}`);
		for (const label of pulls) h.plan[label] = "pull";
		await h.add(job("bk"), ...pulls.map((label) => job(label)));

		expect(h.started).toEqual(["bk", "p0", "p1", "p2", "p3"]);
		expect(h.live).toEqual({ build: 1, pull: 4 });

		await h.finish("p0");
		expect(h.started.at(-1)).toBe("p4");
		await h.finish("p1");
		await h.finish("p2");
		expect(h.started.slice(5)).toEqual(["p4", "p5", "p6"]);

		for (const label of ["p3", "p4", "p5", "p6", "p7", "p8", "p9"]) {
			await h.finish(label);
		}
		expect(h.started).toEqual(["bk", ...pulls]);
		expect(h.peak.pull).toBe(4);
		expect(h.peak.build).toBe(1);
	});

	it("a pull job never takes a free build slot, and a build job never takes a pull slot", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.p1 = "pull";
		h.plan.p2 = "pull";
		await h.add(job("bk"), job("p1"), job("p2"));
		expect(h.started).toEqual(["bk", "p1"]);

		// The build slot frees up: the waiting pull job still waits for a pull slot.
		await h.finish("bk");
		expect(h.started).toEqual(["bk", "p1"]);
		expect(await h.waiting()).toEqual(["p2"]);

		// A build job starts in the build slot while the pull slot is still taken.
		await h.add(job("b2"));
		expect(h.started).toEqual(["bk", "p1", "b2"]);

		await h.finish("p1");
		expect(h.started).toEqual(["bk", "p1", "b2", "p2"]);
		expect(h.peak).toEqual({ build: 1, pull: 1 });
	});

	it("reports the lane of each job in the queue list", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.p1 = "pull";
		h.plan.p2 = "pull";
		await h.add(job("bk"), job("p1"), job("p2"), job("b2"));

		expect(await h.lanes()).toEqual({
			bk: "build",
			p1: "pull",
			p2: "pull",
			b2: "build",
		});
	});
});

describe("one service stays in order across lanes", () => {
	it("a newer pull job does not pass an older build job of the same service", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.s2 = "pull";
		await h.add(job("bk"));
		await h.add(job("S", "s1"), job("S", "s2"));

		// The build lane is full, the pull lane is free, but s1 is older.
		expect(h.started).toEqual(["bk"]);
		expect(await h.waiting()).toEqual(["s1", "s2"]);

		await h.finish("bk");
		expect(h.started).toEqual(["bk", "s1"]);
		await h.finish("s1");
		expect(h.started).toEqual(["bk", "s1", "s2"]);
		await h.finish("s2");
		expect(h.peakPerService).toBe(1);
	});

	it("a newer build job waits for the running pull job of the same service", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.s1 = "pull";
		await h.add(job("bk"));
		await h.add(job("S", "s1"));
		expect(h.started).toEqual(["bk", "s1"]);
		expect(h.startedAs.get("s1")).toBe("pull");

		await h.add(job("S", "s2"));
		await h.finish("bk");
		// The build slot is free, the service is not.
		expect(h.started).toEqual(["bk", "s1"]);

		await h.finish("s1");
		expect(h.started).toEqual(["bk", "s1", "s2"]);
		expect(h.peakPerService).toBe(1);
	});

	it("holdIdleGroup sees a running pull job and blocks a service across lanes", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.s1 = "pull";
		await h.add(job("bk"));
		await h.add(job("S", "s1"));
		expect(h.startedAs.get("s1")).toBe("pull");

		expect(h.queue.holdIdleGroup(LOCAL_PARTITION, "application:S")).toEqual({
			busy: "running",
		});

		// And a hold on an idle service keeps both lanes from starting its jobs.
		const hold = h.queue.holdIdleGroup(LOCAL_PARTITION, "application:T");
		if (!("release" in hold)) throw new Error("expected the hold to be taken");
		h.plan.t1 = "pull";
		await h.add(job("T", "t1"));
		expect(h.started).not.toContain("t1");
		hold.release();
		await settle();
		expect(h.started).toContain("t1");
	});
});

describe("how the lane is learned", () => {
	it("add does not wait for the classifier: pushes keep call order", async () => {
		const h = harness({ build: 1, pull: 4, noWorker: true });
		const never = deferred<Lane>();
		h.plan.a = never.promise;
		h.plan.b = "pull";

		const first = h.queue.add(job("S", "a"));
		const second = h.queue.add(job("S", "b"));
		// Both are in the queue, in call order, before anything was awaited.
		const snapshot = await h.queue.getJobs(["waiting"]);
		expect(snapshot.map((queued) => labelOf(queued.data))).toEqual(["a", "b"]);
		await expect(first).resolves.toMatchObject({ id: expect.any(String) });
		await expect(second).resolves.toMatchObject({ id: expect.any(String) });
	});

	it("a classification that resolves late does not reorder the jobs of a service", async () => {
		const h = harness({ build: 1, pull: 4 });
		const late = deferred<Lane>();
		h.plan.a = (call) => (call === 1 ? late.promise : "pull");
		h.plan.b = "pull";
		await h.add(job("bk"));
		await h.add(job("S", "a"), job("S", "b"));

		// b is already known to be a pull job, but a, queued first, is not classified.
		expect(h.started).toEqual(["bk"]);
		expect(await h.waiting()).toEqual(["a", "b"]);

		late.resolve("pull");
		await settle();
		expect(h.started).toEqual(["bk", "a"]);
		await h.finish("a");
		expect(h.started).toEqual(["bk", "a", "b"]);
		expect(h.peakPerService).toBe(1);
	});

	it("a classifier that throws makes the job a build job", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.x = "throw";
		await h.add(job("bk"), job("x"));

		expect(await h.lanes()).toEqual({ bk: "build", x: "build" });
		expect(h.started).toEqual(["bk"]);
		await h.finish("bk");
		expect(h.started).toEqual(["bk", "x"]);
		expect(h.startedAs.get("x")).toBe("build");
	});

	it("a classifier that answers something that is not a lane makes the job a build job", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.x = (() => "weird") as unknown as Plan;
		await h.add(job("bk"), job("x"));
		expect((await h.lanes()).x).toBe("build");
	});

	it("an unclassified job may take a free build slot, and a late answer changes nothing for a running job", async () => {
		const h = harness({ build: 1, pull: 4 });
		const late = deferred<Lane>();
		h.plan.y = late.promise;
		await h.add(job("y"));
		expect(h.started).toEqual(["y"]);
		expect(h.startedAs.get("y")).toBe("build");

		late.resolve("pull");
		await settle();
		// It runs in the lane it started in, so the build slot is still taken.
		expect((await h.lanes()).y).toBe("build");
		await h.add(job("z"));
		expect(h.started).toEqual(["y"]);
		expect(h.live).toEqual({ build: 1, pull: 0 });
	});

	it("without a classifier every job is a build job, as before lanes", async () => {
		const h = harness({ build: 1, pull: 4, classifier: false });
		await h.add(job("a"), job("b"), job("c"));
		expect(h.started).toEqual(["a"]);
		expect(h.classify).not.toHaveBeenCalled();
		await h.finish("a");
		expect(h.started).toEqual(["a", "b"]);
	});
});

describe("the re-check at start", () => {
	it("sends a job back to the build lane when it no longer looks like a pull job", async () => {
		const h = harness({ build: 1, pull: 4 });
		// Queued as a pull job; edited while it waited, so the check at start says build.
		h.plan.r = (call) => (call === 1 ? "pull" : "build");
		await h.add(job("bk"), job("r"));

		expect(h.calls.r).toBe(2);
		expect(h.started).toEqual(["bk"]);
		expect((await h.lanes()).r).toBe("build");

		await h.finish("bk");
		expect(h.started).toEqual(["bk", "r"]);
		expect(h.startedAs.get("r")).toBe("build");
		expect(h.peak.pull).toBe(0);
	});

	it("a flipped job still obeys the build cap", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.r1 = (call) => (call === 1 ? "pull" : "build");
		h.plan.r2 = (call) => (call === 1 ? "pull" : "build");
		await h.add(job("bk"), job("r1"), job("r2"));
		expect(h.live).toEqual({ build: 1, pull: 0 });

		await h.finish("bk");
		expect(h.started).toEqual(["bk", "r1"]);
		await h.finish("r1");
		expect(h.started).toEqual(["bk", "r1", "r2"]);
		expect(h.peak.build).toBe(1);
	});

	it("a re-check that never answers counts as build after its time limit", async () => {
		vi.useFakeTimers();
		const h = harness({ build: 1, pull: 4, laneRecheckTimeoutMs: 5_000 });
		h.plan.j = (call) => (call === 1 ? "pull" : new Promise<Lane>(() => {}));
		await h.add(job("bk"), job("j"));
		expect(h.started).toEqual(["bk"]);
		// The re-check is still out: the job waits in the pull lane.
		expect((await h.lanes()).j).toBe("pull");

		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect((await h.lanes()).j).toBe("build");
		expect(h.started).toEqual(["bk"]);

		await h.finish("bk");
		expect(h.started).toEqual(["bk", "j"]);
	});

	it("a pull job that was re-checked starts without a build slot", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.p1 = "pull";
		await h.add(job("bk"), job("p1"));
		expect(h.started).toEqual(["bk", "p1"]);
		expect(h.calls.p1).toBe(2);
		expect(h.live).toEqual({ build: 1, pull: 1 });
	});
});

describe("the kill switch", () => {
	it("a pull cap of 0 is the queue as it was: one lane, one cap", async () => {
		const h = harness({ build: 1, pull: 0 });
		for (const label of ["a", "b", "c"]) h.plan[label] = "pull";
		await h.add(job("a"), job("b"), job("c"));

		expect(h.started).toEqual(["a"]);
		expect(await h.lanes()).toEqual({ a: "build", b: "build", c: "build" });
		await h.finish("a");
		expect(h.started).toEqual(["a", "b"]);
		await h.finish("b");
		expect(h.started).toEqual(["a", "b", "c"]);
		expect(h.peak.pull).toBe(0);
	});

	it("lowering the cap to 0 while pull jobs wait hands them to the build lane", async () => {
		let pullCap = 1;
		const h = harness({ build: 1, pull: () => pullCap });
		h.plan.p1 = "pull";
		h.plan.p2 = "pull";
		await h.add(job("bk"), job("p1"), job("p2"));
		expect(h.started).toEqual(["bk", "p1"]);

		pullCap = 0;
		await h.finish("p1");
		// p2 has no pull lane any more and the build slot is taken.
		expect(h.started).toEqual(["bk", "p1"]);
		expect((await h.lanes()).p2).toBe("build");

		await h.finish("bk");
		expect(h.started).toEqual(["bk", "p1", "p2"]);
		expect(h.startedAs.get("p2")).toBe("build");
	});

	it("a queue with no pull reader has the lane off", async () => {
		const h = harness({ build: 1 });
		h.plan.p1 = "pull";
		await h.add(job("bk"), job("p1"));
		expect(h.started).toEqual(["bk"]);
		expect((await h.lanes()).p1).toBe("build");
	});

	it("a pull reader that throws turns the lane off for that tick", async () => {
		const h = harness({
			build: 1,
			pull: () => {
				throw new Error("config unreadable");
			},
		});
		h.plan.p1 = "pull";
		await h.add(job("bk"), job("p1"));
		expect(h.started).toEqual(["bk"]);
		expect((await h.lanes()).p1).toBe("build");
	});
});

describe("running pull jobs are first-class", () => {
	it("releaseActive on a pull job frees a pull slot and starts the next pull job", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.p1 = "pull";
		h.plan.p2 = "pull";
		await h.add(job("bk"), job("p1"), job("p2"));
		expect(h.started).toEqual(["bk", "p1"]);

		const id = await h.idOfActive("p1");
		expect(h.queue.releaseActive(id)).toBe(true);
		await settle();
		expect(h.started).toEqual(["bk", "p1", "p2"]);
		expect(h.live.build).toBe(1);
	});

	it("busy() lists running pull jobs, so a restart is still refused while one runs", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.p1 = "pull";
		await h.add(job("bk"), job("p1"));

		const labels = h.queue.busy().active.map((entry) => labelOf(entry.data));
		expect(labels.sort()).toEqual(["bk", "p1"]);
		await h.finish("bk");
		expect(h.queue.busy().active.map((entry) => labelOf(entry.data))).toEqual([
			"p1",
		]);
	});

	it("a finished pull job starts the next waiting pull job", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.p1 = "pull";
		h.plan.p2 = "pull";
		await h.add(job("bk"), job("p1"), job("p2"));
		await h.finish("p1", "failed");
		expect(h.started).toEqual(["bk", "p1", "p2"]);
	});
});

describe("closeIntake", () => {
	it("stops pull starts too, and they start when the intake reopens", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.p1 = "pull";
		await h.add(job("bk"));
		const hold = h.queue.closeIntake(60_000);
		await h.add(job("p1"));
		expect(h.started).toEqual(["bk"]);
		expect(await h.waiting()).toEqual(["p1"]);

		hold.release();
		await settle();
		expect(h.started).toEqual(["bk", "p1"]);
	});

	it("a drain waiting on the lane re-check cannot start a pull job once the intake closed", async () => {
		const h = harness({ build: 1, pull: 4 });
		const recheck = deferred<Lane>();
		h.plan.p1 = (call) =>
			call === 1 ? "pull" : call === 2 ? recheck.promise : "pull";
		await h.add(job("bk"), job("p1"));
		// The drain is parked on the re-check of p1.
		expect(h.calls.p1).toBe(2);
		expect(h.started).toEqual(["bk"]);

		const hold = h.queue.closeIntake(60_000);
		recheck.resolve("pull");
		await settle();
		expect(h.started).toEqual(["bk"]);
		expect(h.live).toEqual({ build: 1, pull: 0 });

		hold.release();
		await settle();
		expect(h.started).toEqual(["bk", "p1"]);
		// It was checked again for the start that finally happened.
		expect(h.calls.p1).toBe(3);
	});
});

describe("the priority lane belongs to the build lane", () => {
	it("a jump counts only build jobs it goes ahead of, and ignores waiting pull jobs", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.pr = "pull";
		h.plan.P2 = "pull";
		await h.add(job("bk"), job("pr"), job("P2"));
		expect(h.started).toEqual(["bk", "pr"]);

		await h.add(job("a"), job("b"));
		const flagged = await h.queue.add(
			job("c", "c", { priority: true, priorityBy: "user-1" }),
		);
		// a and b are ahead of c in the build lane; the waiting pull job P2 is not.
		expect(flagged.priority).toMatchObject({ applied: true, wentAheadOf: 2 });
		await settle();

		await h.finish("bk");
		expect(h.started.slice(2)).toEqual(["c"]);
		expect(h.wentAheadOf.get("c")).toBe(2);
		// P2 never moved: it still waits for a pull slot.
		expect(await h.waiting()).toEqual(["P2", "a", "b"]);
	});

	it("prioritizing a pull job changes nothing and stores no flag", async () => {
		const h = harness({ build: 1, pull: 1 });
		h.plan.pr = "pull";
		h.plan.P2 = "pull";
		await h.add(job("bk"), job("pr"), job("P2"));
		const [waitingJob] = await h.queue.getJobs(["waiting"]);
		expect(waitingJob && labelOf(waitingJob.data)).toBe("P2");

		const outcome = h.queue.prioritize(
			(waitingJob as InMemoryJob).id,
			"user-1",
		);
		expect(outcome).toMatchObject({ requested: true, applied: false });
		const [after] = await h.queue.getJobs(["waiting"]);
		expect((after as InMemoryJob).data.priority).toBeUndefined();
	});

	it("a flagged job in the build lane still jumps while pull jobs run", async () => {
		const h = harness({ build: 1, pull: 4 });
		h.plan.p1 = "pull";
		await h.add(job("bk"), job("p1"));
		await h.add(job("a"), job("b"));
		const flagged = await h.queue.add(
			job("c", "c", { priority: true, priorityBy: "user-1" }),
		);
		expect(flagged.priority).toMatchObject({ applied: true, wentAheadOf: 2 });
		await settle();

		await h.finish("bk");
		expect(h.started).toEqual(["bk", "p1", "c"]);
		await h.finish("c");
		expect(h.started.slice(3)).toEqual(["a"]);
	});
});

describe("classifyWaiting (the boot restore)", () => {
	it("waits for the answers, then the jobs start in their lane", async () => {
		const h = harness({ build: 1, pull: 2, paused: true });
		const late = deferred<Lane>();
		h.plan.p1 = (call) => (call === 1 ? late.promise : "pull");
		h.plan.p2 = "pull";
		await h.add(job("b1"), job("p1"), job("p2"), job("b2"));
		expect(h.started).toEqual([]);

		let done = false;
		const waited = h.queue.classifyWaiting(5_000).then(() => {
			done = true;
		});
		await settle();
		// p1 is still being classified, so the wait is not over.
		expect(done).toBe(false);

		late.resolve("pull");
		await waited;
		expect(await h.lanes()).toEqual({
			b1: "build",
			p1: "pull",
			p2: "pull",
			b2: "build",
		});
		// Nothing started while the gate (the pause) held the worker.
		expect(h.started).toEqual([]);

		h.queue.resume();
		await settle();
		expect([...h.started].sort()).toEqual(["b1", "p1", "p2"]);
		expect(h.live).toEqual({ build: 1, pull: 2 });
	});

	it("gives up waiting after its time limit and leaves the job as a build job", async () => {
		vi.useFakeTimers();
		const h = harness({ build: 1, pull: 2, paused: true });
		h.plan.p1 = new Promise<Lane>(() => {});
		await h.add(job("p1"));

		let done = false;
		const waited = h.queue.classifyWaiting(1_000).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waited;
		expect(done).toBe(true);
		expect((await h.lanes()).p1).toBe("build");
	});

	it("does nothing without a classifier", async () => {
		const h = harness({ build: 1, pull: 2, classifier: false, paused: true });
		await h.add(job("a"));
		await expect(h.queue.classifyWaiting(1_000)).resolves.toBeUndefined();
	});

	it("an answer that arrives after the wait still moves the job to its lane", async () => {
		vi.useFakeTimers();
		const h = harness({ build: 1, pull: 2, paused: true });
		const late = deferred<Lane>();
		h.plan.p1 = (call) => (call === 1 ? late.promise : "pull");
		await h.add(job("p1"));
		const waited = h.queue.classifyWaiting(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await waited;

		late.resolve("pull");
		await settle();
		expect((await h.lanes()).p1).toBe("pull");
	});
});

describe("two partitions", () => {
	it("each partition has its own pull cap", async () => {
		const h = harness({ build: 1, pull: 1 });
		const onServer = (label: string, service: string, serverId: string) =>
			job(service, label, { serverId });
		for (const label of ["s1p1", "s1p2", "s2p1", "s2p2"])
			h.plan[label] = "pull";
		await h.add(
			onServer("bk1", "bk1", "srv-1"),
			onServer("bk2", "bk2", "srv-2"),
			onServer("s1p1", "s1p1", "srv-1"),
			onServer("s1p2", "s1p2", "srv-1"),
			onServer("s2p1", "s2p1", "srv-2"),
			onServer("s2p2", "s2p2", "srv-2"),
		);

		expect(h.started.sort()).toEqual(["bk1", "bk2", "s1p1", "s2p1"]);
		expect(h.live).toEqual({ build: 2, pull: 2 });
	});
});
