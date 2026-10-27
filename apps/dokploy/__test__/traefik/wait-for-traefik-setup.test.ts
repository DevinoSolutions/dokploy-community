import { describe, expect, it, vi } from "vitest";
import {
	firstErrorLine,
	newTraefikSetupJobId,
	type TraefikSetupStatus,
	waitForTraefikSetup,
} from "@/utils/wait-for-traefik-setup";

const setup = (
	statuses: (TraefikSetupStatus | Error)[],
	health: boolean[] = [true],
) => {
	let clock = 0;
	const status = [...statuses];
	const healthy = [...health];
	const getStatus = vi.fn(async () => {
		const next = status.length > 1 ? status.shift()! : status[0]!;
		if (next instanceof Error) {
			throw next;
		}
		return next;
	});
	const isHealthy = vi.fn(async () =>
		healthy.length > 1 ? healthy.shift()! : healthy[0]!,
	);
	const sleep = vi.fn(async (ms: number) => {
		clock += ms;
	});
	return {
		getStatus,
		isHealthy,
		sleep,
		run: (options: { timeoutMs?: number } = {}) =>
			waitForTraefikSetup({
				getStatus,
				isHealthy,
				sleep,
				now: () => clock,
				...options,
			}),
	};
};

const pending: TraefikSetupStatus = { state: "pending", error: null };
const done: TraefikSetupStatus = { state: "done", error: null };
const unknown: TraefikSetupStatus = { state: "unknown", error: null };

describe("waitForTraefikSetup", () => {
	it("succeeds once the run is done and the dashboard answers", async () => {
		const t = setup([pending, pending, done]);

		await expect(t.run()).resolves.toEqual({ status: "applied" });
		expect(t.getStatus).toHaveBeenCalledTimes(3);
		expect(t.isHealthy).toHaveBeenCalledTimes(1);
	});

	it("does not ask the dashboard before the run is done", async () => {
		const t = setup([pending, pending, done]);

		await t.run();
		const lastStatusCall = t.getStatus.mock.invocationCallOrder.at(-1)!;
		expect(t.isHealthy.mock.invocationCallOrder[0]).toBeGreaterThan(
			lastStatusCall,
		);
	});

	it("waits through unreachable polls while Traefik is replaced", async () => {
		const t = setup([new Error("fetch failed"), new Error("502"), done]);

		await expect(t.run()).resolves.toEqual({ status: "applied" });
	});

	it("keeps polling the dashboard until it answers", async () => {
		const t = setup([done], [false, false, true]);

		await expect(t.run()).resolves.toEqual({ status: "applied" });
		expect(t.isHealthy).toHaveBeenCalledTimes(3);
	});

	it("returns the first line of a failure, without asking the dashboard", async () => {
		const t = setup([
			pending,
			{ state: "failed", error: "\n  Cannot rename container  \nmore detail" },
		]);

		await expect(t.run()).resolves.toEqual({
			status: "failed",
			error: "Cannot rename container",
		});
		expect(t.isHealthy).not.toHaveBeenCalled();
	});

	it("reports a failure without a message as failed, not unconfirmed", async () => {
		const t = setup([{ state: "failed", error: "" }]);

		await expect(t.run()).resolves.toEqual({ status: "failed", error: null });
	});

	it("gives up when the server does not know the run", async () => {
		const t = setup([unknown]);

		await expect(t.run()).resolves.toEqual({ status: "unconfirmed" });
		expect(t.getStatus).toHaveBeenCalledTimes(10);
		expect(t.isHealthy).not.toHaveBeenCalled();
	});

	it("does not count unknown polls that are not in a row", async () => {
		const nine = Array<TraefikSetupStatus>(9).fill(unknown);
		const t = setup([...nine, pending, ...nine, done]);

		await expect(t.run()).resolves.toEqual({ status: "applied" });
	});

	it("times out as unconfirmed when the run never ends", async () => {
		const t = setup([pending]);

		await expect(t.run({ timeoutMs: 20_000 })).resolves.toEqual({
			status: "unconfirmed",
		});
		expect(t.isHealthy).not.toHaveBeenCalled();
	});

	it("times out as unconfirmed when the dashboard never answers", async () => {
		const t = setup([done], [false]);

		await expect(t.run({ timeoutMs: 20_000 })).resolves.toEqual({
			status: "unconfirmed",
		});
	});
});

describe("waitForTraefikSetup with hung requests", () => {
	const hang = () => new Promise<never>(() => {});

	it("treats a status request that never answers as unreachable", async () => {
		let calls = 0;
		const result = await waitForTraefikSetup({
			getStatus: () => (++calls === 1 ? hang() : Promise.resolve(done)),
			isHealthy: async () => true,
			sleep: async () => {},
			now: () => 0,
			requestTimeoutMs: 5,
		});

		expect(result).toEqual({ status: "applied" });
		expect(calls).toBe(2);
	});

	it("treats a health request that never answers as not healthy yet", async () => {
		let calls = 0;
		const result = await waitForTraefikSetup({
			getStatus: async () => done,
			isHealthy: () => (++calls === 1 ? hang() : Promise.resolve(true)),
			sleep: async () => {},
			now: () => 0,
			requestTimeoutMs: 5,
		});

		expect(result).toEqual({ status: "applied" });
		expect(calls).toBe(2);
	});
});

describe("firstErrorLine", () => {
	it("returns the first non-empty line, trimmed", () => {
		expect(firstErrorLine("\r\n  a \r\nb")).toBe("a");
	});

	it("caps a very long line", () => {
		expect(firstErrorLine("x".repeat(500))).toHaveLength(300);
	});

	it("returns null for a blank message", () => {
		expect(firstErrorLine(" \n ")).toBeNull();
	});
});

describe("newTraefikSetupJobId", () => {
	it("is hex, short enough for the API, and differs per call", () => {
		const a = newTraefikSetupJobId();
		expect(a).toMatch(/^[0-9a-f]{24}$/);
		expect(newTraefikSetupJobId()).not.toBe(a);
	});
});
