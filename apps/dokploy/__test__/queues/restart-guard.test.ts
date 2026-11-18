import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({ db: {} }));

import {
	closeIntakeForRestart,
	DEPLOY_INTAKE_HOLD_MS,
	type RestartGuardQueue,
} from "../../server/queues/restart-guard";

const makeQueue = (
	busy: ReturnType<RestartGuardQueue["busy"]> = { active: [], heldGroups: [] },
) => {
	const hold = { release: vi.fn(), extend: vi.fn() };
	const queue: RestartGuardQueue = {
		closeIntake: vi.fn(() => hold),
		busy: vi.fn(() => busy),
	};
	return { queue, hold };
};

const names = (
	apps: Record<string, string> = {},
	composes: Record<string, string> = {},
) =>
	vi.fn(async () => ({
		applications: new Map(Object.entries(apps)),
		composes: new Map(Object.entries(composes)),
	}));

describe("closeIntakeForRestart", () => {
	it("returns the hold when nothing runs, closed for the hold time", async () => {
		const { queue, hold } = makeQueue();

		await expect(closeIntakeForRestart(queue, "update", names())).resolves.toBe(
			hold,
		);

		expect(queue.closeIntake).toHaveBeenCalledWith(DEPLOY_INTAKE_HOLD_MS);
		expect(hold.release).not.toHaveBeenCalled();
	});

	it("names the running services (never ids or payload) and reopens", async () => {
		const { queue, hold } = makeQueue({
			active: [
				{
					group: "application:a1",
					data: { env: "TOKEN=abc", titleLog: "t" } as never,
				},
				{ group: "compose:c1", data: {} as never },
			],
			heldGroups: [],
		});

		const error = await closeIntakeForRestart(
			queue,
			"update",
			names({ a1: "Landing" }, { c1: "billing-stack" }),
		).catch((e) => e);

		expect(error).toMatchObject({ code: "CONFLICT" });
		expect(error.message).toBe(
			"Not updating: 2 services have a deployment running (Landing, billing-stack). Restarting Dokploy now would interrupt them. Wait for them to finish, then try again.",
		);
		expect(error.message).not.toContain("abc");
		expect(error.message).not.toContain("a1");
		expect(hold.release).toHaveBeenCalledTimes(1);
	});

	it("counts the services once however many jobs run, caps the list, and says reload for a reload", async () => {
		const active = Array.from({ length: 7 }, (_, i) => ({
			group: `application:s${i}`,
			data: {} as never,
		}));
		active.push({ group: "application:s0", data: {} as never });
		const { queue } = makeQueue({ active, heldGroups: [] });

		const error = await closeIntakeForRestart(
			queue,
			"reload",
			names(Object.fromEntries(active.map((_, i) => [`s${i}`, `svc${i}`]))),
		).catch((e) => e);

		expect(error.message).toContain("Not reloading: 7 services have");
		expect(error.message).toContain("svc0, svc1, svc2, svc3, svc4, and 2 more");
		expect(error.message).not.toContain("svc5");
	});

	it("treats a service lock held outside a job (compose Fetch) as busy", async () => {
		const { queue, hold } = makeQueue({
			active: [],
			heldGroups: ["compose:c1"],
		});

		const error = await closeIntakeForRestart(
			queue,
			"update",
			names({}, { c1: "stack" }),
		).catch((e) => e);

		expect(error.message).toContain(
			"1 service has a deployment running (stack)",
		);
		expect(error.message).toContain("interrupt it");
		expect(hold.release).toHaveBeenCalled();
	});

	it("still refuses, with the count, when the names cannot be read", async () => {
		const { queue } = makeQueue({
			active: [{ group: "application:a1", data: {} as never }],
			heldGroups: [],
		});

		const error = await closeIntakeForRestart(queue, "update", async () => {
			throw new Error("db down");
		}).catch((e) => e);

		expect(error).toMatchObject({ code: "CONFLICT" });
		expect(error.message).toContain("1 service has a deployment running.");
		expect(error.message).not.toContain("db down");
	});
});
