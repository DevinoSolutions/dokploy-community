import { pickEnvironmentUrl } from "@dokploy/server/services/gha-connect/environment-url";
import {
	ACTIVE_INTERVAL_MS,
	IDLE_AFTER_MS,
	IDLE_INTERVAL_MS,
	intervalFor,
	isDue,
} from "@dokploy/server/services/gha-connect/poll-cadence";
import {
	evaluateStale,
	STALE_MIN_TOLERANCE_MS,
	STALE_QUEUE_LIMIT_MS,
	type StaleInput,
	type StaleRun,
} from "@dokploy/server/services/gha-connect/stale";
import { createDeploymentStatus } from "@dokploy/server/services/github-deployments/github-api";
import {
	listPinnedComposeRepositories,
	pinComposeImages,
} from "@dokploy/server/services/github-deployments/service-image";
import { describe, expect, it } from "vitest";
import { routedFetch } from "./gha-helpers";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("pinComposeImages", () => {
	const compose = [
		"services:",
		"  web:",
		`    image: registry.devino.ca/shorty/web@${D("1")}`,
		"  docs:",
		`    image: "registry.devino.ca/shorty/docs@${D("2")}"`,
		"  db:",
		"    image: postgres:16",
		"",
	].join("\n");

	it("moves every named image to its new digest and touches nothing else", () => {
		const result = pinComposeImages(compose, [
			{ repository: "registry.devino.ca/shorty/web", digest: D("a") },
			{ repository: "registry.devino.ca/shorty/docs", digest: D("b") },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBe(true);
		expect(result.composeFile).toBe(
			compose.replace(D("1"), D("a")).replace(D("2"), D("b")),
		);
	});

	it("reports no change when the digests are already pinned", () => {
		const result = pinComposeImages(compose, [
			{ repository: "registry.devino.ca/shorty/web", digest: D("1") },
		]);
		expect(result).toMatchObject({ ok: true, changed: false });
	});

	it("refuses a repository the file does not pin, and a repository named twice", () => {
		expect(
			pinComposeImages(compose, [
				{ repository: "registry.devino.ca/shorty/other", digest: D("a") },
			]),
		).toMatchObject({ ok: false });
		expect(
			pinComposeImages(compose, [
				{ repository: "registry.devino.ca/shorty/web", digest: D("a") },
				{ repository: "Registry.Devino.CA/shorty/web", digest: D("b") },
			]),
		).toMatchObject({ ok: false, reason: expect.stringContaining("twice") });
	});
});

describe("listPinnedComposeRepositories", () => {
	it("lists each digest-pinned repository once and skips tags", () => {
		const compose = [
			"services:",
			"  web:",
			`    image: registry.devino.ca/shorty/web@${D("1")}`,
			"  worker:",
			`    image: "registry.devino.ca/shorty/web@${D("2")}"`,
			"  docs:",
			`  - image: registry.devino.ca/shorty/docs:v2@${D("3")}`,
			"  db:",
			"    image: postgres:16",
			"",
		].join("\n");
		expect(listPinnedComposeRepositories(compose)).toEqual([
			"registry.devino.ca/shorty/web",
			"registry.devino.ca/shorty/docs",
		]);
	});

	it("is empty for a file that pins nothing", () => {
		expect(
			listPinnedComposeRepositories("services:\n  a:\n    image: nginx\n"),
		).toEqual([]);
	});
});

describe("pickEnvironmentUrl", () => {
	it("prefers an https domain and keeps a non-root path", () => {
		expect(
			pickEnvironmentUrl([
				{ host: "internal.example.com", https: false, path: "/" },
				{ host: "App.Example.com", https: true, path: "/dashboard" },
			]),
		).toBe("https://app.example.com/dashboard");
	});
	it("falls back to the first usable domain", () => {
		expect(
			pickEnvironmentUrl([{ host: "a.example.com", https: false, path: null }]),
		).toBe("http://a.example.com");
	});
	it("returns nothing for no domain, a disabled one or a host that is not a name", () => {
		expect(pickEnvironmentUrl([])).toBeUndefined();
		expect(
			pickEnvironmentUrl([
				{ host: "a.example.com", https: true, path: "/", enabled: false },
			]),
		).toBeUndefined();
		expect(
			pickEnvironmentUrl([{ host: "localhost", https: true, path: "/" }]),
		).toBeUndefined();
		expect(
			pickEnvironmentUrl([
				{ host: "a.example.com/../x", https: true, path: "/" },
			]),
		).toBeUndefined();
	});
	it("drops a path that could carry anything else", () => {
		expect(
			pickEnvironmentUrl([
				{ host: "a.example.com", https: true, path: "/a?b=c" },
			]),
		).toBe("https://a.example.com");
	});
});

describe("deployment status extras", () => {
	const send = async (extra: object) => {
		const { fetch, calls } = routedFetch([["/statuses", { status: 201 }]]);
		await createDeploymentStatus(
			{ fetch, now: () => 1 },
			{
				token: "t",
				owner: "acme",
				repo: "shop",
				deploymentId: 9,
				state: "success",
				description: "ok",
				...extra,
			},
		);
		return JSON.parse(calls[0]?.body ?? "{}");
	};
	it("adds environment_url and auto_inactive false only when asked", async () => {
		expect(await send({})).toEqual({ state: "success", description: "ok" });
		expect(
			await send({
				environmentUrl: "https://app.example.com",
				autoInactive: false,
			}),
		).toEqual({
			state: "success",
			description: "ok",
			environment_url: "https://app.example.com",
			auto_inactive: false,
		});
	});
});

describe("evaluateStale", () => {
	const NOW = 1_700_000_000_000;
	const HEAD = "b".repeat(40);
	const run = (overrides: Partial<StaleRun> = {}): StaleRun => ({
		status: "completed",
		conclusion: "success",
		createdAt: NOW - 3_600_000,
		startedAt: NOW - 3_500_000,
		endedAt: NOW - 3_400_000,
		...overrides,
	});
	const input = (overrides: Partial<StaleInput> = {}): StaleInput => ({
		now: NOW,
		trackedBranch: "main",
		branchExists: true,
		branchHead: HEAD,
		lastReleaseSha: "a".repeat(40),
		deployedOnBranch: true,
		workflowPresent: true,
		workflowFile: ".github/workflows/dokploy.yml",
		runsForHead: [],
		recentFinishedRuns: [],
		...overrides,
	});

	it("is not stale when the push triggered no run", () => {
		expect(evaluateStale(input())).toEqual({ stale: false });
	});
	it("is not stale when the branch head is the last release", () => {
		expect(
			evaluateStale(input({ lastReleaseSha: HEAD, runsForHead: [run()] })),
		).toEqual({ stale: false });
	});
	it("is stale when a successful run ended and no release followed within the tolerance", () => {
		expect(evaluateStale(input({ runsForHead: [run()] }))).toEqual({
			stale: true,
			reason: "GitHub Actions has not published commit bbbbbbb.",
		});
	});
	it("waits out the tolerance after the run ended", () => {
		expect(
			evaluateStale(
				input({
					runsForHead: [
						run({ endedAt: NOW - STALE_MIN_TOLERANCE_MS + 60_000 }),
					],
				}),
			),
		).toEqual({ stale: false });
	});
	it("scales the tolerance with twice the median of the last runs", () => {
		const slow = (minutes: number): StaleRun =>
			run({
				startedAt: NOW - minutes * 60_000 * 2,
				endedAt: NOW - minutes * 60_000,
			});
		const recent = [slow(40), slow(40), slow(40), slow(40), slow(40)];
		// Median duration 40 minutes -> tolerance 80 minutes; the run ended 60 minutes ago.
		expect(
			evaluateStale(
				input({
					runsForHead: [run({ endedAt: NOW - 60 * 60_000 })],
					recentFinishedRuns: recent,
				}),
			),
		).toEqual({ stale: false });
	});
	it("does not call a failed run a missing release", () => {
		expect(
			evaluateStale(input({ runsForHead: [run({ conclusion: "failure" })] })),
		).toEqual({ stale: false });
	});
	it("says when a run waited too long for a runner, and not before", () => {
		const queued = (waitedMs: number): StaleRun =>
			run({
				status: "queued",
				conclusion: null,
				startedAt: null,
				endedAt: null,
				createdAt: NOW - waitedMs,
			});
		expect(
			evaluateStale(
				input({ runsForHead: [queued(STALE_QUEUE_LIMIT_MS + 600_000)] }),
			),
		).toEqual({
			stale: true,
			reason: "Queued for 40 minutes, is a runner online?",
		});
		expect(evaluateStale(input({ runsForHead: [queued(60_000)] }))).toEqual({
			stale: false,
		});
	});
	it("names a deleted branch, a force push and a removed workflow", () => {
		expect(evaluateStale(input({ branchExists: false })).stale).toBe(true);
		expect(evaluateStale(input({ deployedOnBranch: false }))).toEqual({
			stale: true,
			reason: "The deployed commit is no longer on the branch.",
		});
		expect(evaluateStale(input({ workflowPresent: false }))).toEqual({
			stale: true,
			reason: "dokploy.yml was removed from main.",
		});
	});
});

describe("poll cadence", () => {
	const NOW = 1_700_000_000_000;
	it("polls every 20 seconds while anything happens and every 120 after a quiet day", () => {
		expect(
			intervalFor({ now: NOW, lastActivityAt: NOW - 1000, createdAt: 0 }),
		).toBe(ACTIVE_INTERVAL_MS);
		expect(
			intervalFor({
				now: NOW,
				lastActivityAt: NOW - IDLE_AFTER_MS - 1,
				createdAt: 0,
			}),
		).toBe(IDLE_INTERVAL_MS);
	});
	it("counts a connection that never saw activity from its creation", () => {
		expect(
			intervalFor({ now: NOW, lastActivityAt: null, createdAt: NOW - 1000 }),
		).toBe(ACTIVE_INTERVAL_MS);
		expect(
			intervalFor({
				now: NOW,
				lastActivityAt: null,
				createdAt: NOW - IDLE_AFTER_MS - 1,
			}),
		).toBe(IDLE_INTERVAL_MS);
	});
	it("is due when never polled or when the interval has passed", () => {
		const base = { now: NOW, lastActivityAt: NOW, createdAt: NOW };
		expect(isDue({ ...base, lastPolledAt: null })).toBe(true);
		expect(isDue({ ...base, lastPolledAt: NOW - 5_000 })).toBe(false);
		expect(isDue({ ...base, lastPolledAt: NOW - 19_500 })).toBe(true);
	});
});
