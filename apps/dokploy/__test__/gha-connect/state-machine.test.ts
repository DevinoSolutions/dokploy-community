import {
	type ConnectionEvent,
	describeState,
	reduceConnection,
	type StateView,
} from "@dokploy/server/services/gha-connect/state-machine";
import { describe, expect, it } from "vitest";

const at = (
	state: StateView["state"],
	detail: string | null = null,
): StateView => ({
	state,
	detail,
});
const step = (from: StateView, ...events: ConnectionEvent[]) =>
	events.reduce(reduceConnection, from);

describe("reduceConnection", () => {
	it("walks the happy path of phase 1", () => {
		const connected = step(
			at("not_connected"),
			{ type: "connect" },
			{ type: "release-deployed" },
		);
		expect(connected).toEqual(at("connected"));
	});

	it("walks the wizard path of phase 2", () => {
		expect(
			step(
				at("not_connected"),
				{ type: "proposed" },
				{ type: "workflow-detected" },
				{ type: "connect" },
			),
		).toEqual(at("waiting"));
		expect(step(at("proposed"), { type: "proposal-closed" })).toEqual(
			at("not_connected"),
		);
	});

	it("blocks on a blocking refusal and not on a harmless one", () => {
		const refused = (block: boolean): ConnectionEvent => ({
			type: "release-refused",
			message: "The environment allows every branch",
			block,
		});
		expect(step(at("connected"), refused(true))).toEqual(
			at("blocked", "The environment allows every branch"),
		);
		expect(step(at("connected"), refused(false))).toEqual(at("connected"));
		expect(step(at("waiting"), refused(true)).state).toBe("blocked");
	});

	it("a deployed release clears blocked and stale", () => {
		expect(step(at("blocked", "x"), { type: "release-deployed" })).toEqual(
			at("connected"),
		);
		expect(step(at("stale", "x"), { type: "release-deployed" })).toEqual(
			at("connected"),
		);
	});

	it("goes stale from waiting or connected only, and recovers to where it was", () => {
		const stale: ConnectionEvent = {
			type: "stale",
			reason: "queued for 40 minutes",
		};
		expect(step(at("connected"), stale)).toEqual(
			at("stale", "queued for 40 minutes"),
		);
		expect(step(at("waiting"), stale).state).toBe("stale");
		expect(step(at("blocked", "x"), stale).state).toBe("blocked");
		expect(step(at("disconnected"), stale).state).toBe("disconnected");
		expect(step(at("stale", "x"), { type: "fresh", hasRelease: true })).toEqual(
			at("connected"),
		);
		expect(
			step(at("stale", "x"), { type: "fresh", hasRelease: false }),
		).toEqual(at("waiting"));
		expect(step(at("connected"), { type: "fresh", hasRelease: true })).toEqual(
			at("connected"),
		);
	});

	it("a lost token disconnects any connection, and a restored one returns it", () => {
		for (const state of ["waiting", "connected", "stale", "blocked"] as const) {
			expect(step(at(state), { type: "token-revoked" })).toEqual(
				at("disconnected"),
			);
		}
		expect(step(at("not_connected"), { type: "token-revoked" }).state).toBe(
			"not_connected",
		);
		expect(
			step(at("disconnected"), { type: "token-restored", hasRelease: true }),
		).toEqual(at("connected"));
		expect(
			step(at("disconnected"), { type: "token-restored", hasRelease: false }),
		).toEqual(at("waiting"));
	});

	it("a disconnected connection ignores releases until the token is back", () => {
		expect(step(at("disconnected"), { type: "release-deployed" }).state).toBe(
			"disconnected",
		);
		expect(
			step(at("disconnected"), {
				type: "release-refused",
				message: "x",
				block: true,
			}).state,
		).toBe("disconnected");
	});

	it("unblock leads to connected or waiting by whether a release ever ran", () => {
		expect(
			step(at("blocked", "x"), { type: "unblock", hasRelease: true }),
		).toEqual(at("connected"));
		expect(
			step(at("blocked", "x"), { type: "unblock", hasRelease: false }),
		).toEqual(at("waiting"));
		expect(
			step(at("connected"), { type: "unblock", hasRelease: true }),
		).toEqual(at("connected"));
	});

	it("connect does nothing once connected", () => {
		expect(step(at("connected"), { type: "connect" })).toEqual(at("connected"));
	});
});

describe("describeState", () => {
	const now = new Date("2026-11-03T12:00:00Z");
	const context = {
		expectedSha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
		deployedSha: null,
		lastReleaseAt: null,
		now,
	};

	it.each([
		[at("not_connected"), null],
		[at("proposed"), "Waiting for you to merge the pull request."],
		[at("detected"), "Workflow found. Waiting for a release."],
		[
			at("waiting"),
			"Waiting for GitHub Actions to publish 3f9c2a1. Git autodeploy is off.",
		],
		[at("connected"), "Deployed from GitHub Actions."],
		[
			at("blocked", "The registry does not serve web."),
			"The registry does not serve web.",
		],
		[at("disconnected"), "GitHub access was lost. Reconnect."],
	])("%j", (state, expected) => {
		expect(describeState(state, context)).toBe(expected);
	});

	it("names the pull request", () => {
		expect(describeState(at("proposed"), { ...context, pullRequest: 12 })).toBe(
			"Waiting for you to merge pull request #12.",
		);
	});

	it("tells how long ago the last release was when stale", () => {
		expect(
			describeState(
				at("stale", "GitHub Actions has not published commit 3f9c2a1."),
				{
					...context,
					lastReleaseSha: "8d41b07aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					lastReleaseAt: new Date("2026-11-01T12:00:00Z"),
				},
			),
		).toBe(
			"GitHub Actions has not published commit 3f9c2a1. Last release 8d41b07, 2 days ago.",
		);
		expect(
			describeState(
				at("stale", "queued for 40 minutes, is a runner online?"),
				context,
			),
		).toBe("queued for 40 minutes, is a runner online?");
	});
});
