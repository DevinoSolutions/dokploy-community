import {
	clampDescription,
	createDeploymentStatus,
	fetchTokenOwner,
	listDeployments,
	rateLimitRetryAt,
} from "@dokploy/server/services/github-deployments/github-api";
import { describe, expect, it } from "vitest";
import { scriptedFetch } from "./helpers";

const NOW = 1_700_000_000_000;
const args = {
	token: "gho_secret",
	owner: "DevinoSolutions",
	repo: "sendly",
	environment: "production",
};

describe("listDeployments", () => {
	it("asks for a page of deployments of the environment and sends If-None-Match", async () => {
		const { fetch, calls } = scriptedFetch([{ status: 304 }]);
		const result = await listDeployments(
			{ fetch, now: () => NOW },
			{ ...args, etag: 'W/"abc"' },
		);
		expect(result).toEqual({ kind: "not-modified" });
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/DevinoSolutions/sendly/deployments?environment=production&per_page=30&page=1",
		);
		expect(calls[0]?.headers["If-None-Match"]).toBe('W/"abc"');
		expect(calls[0]?.headers.Authorization).toBe("Bearer gho_secret");
	});

	it("sends no If-None-Match on the first call and returns the new ETag", async () => {
		const { fetch, calls } = scriptedFetch([
			{
				json: [{ id: 7, payload: {} }, { id: 9 }],
				headers: { ETag: 'W/"new"' },
			},
		]);
		const result = await listDeployments({ fetch, now: () => NOW }, args);
		expect(calls[0]?.headers["If-None-Match"]).toBeUndefined();
		expect(result).toMatchObject({ kind: "ok", etag: 'W/"new"' });
		if (result.kind === "ok")
			expect(result.deployments.map((d) => d.id)).toEqual([7, 9]);
	});

	it("walks older pages until it reaches a deployment already handled", async () => {
		const page = (from: number) =>
			Array.from({ length: 30 }, (_, i) => ({ id: from - i }));
		const { fetch, calls } = scriptedFetch([
			{ json: page(100), headers: { etag: 'W/"p1"' } },
			{ json: page(70) },
			{ json: [{ id: 40 }, { id: 39 }, { id: 38 }] },
		]);
		const result = await listDeployments(
			{ fetch, now: () => NOW },
			{ ...args, etag: 'W/"old"', lastSeen: 39 },
		);
		expect(calls.map((c) => c.url.split("&").slice(-1)[0])).toEqual([
			"page=1",
			"page=2",
			"page=3",
		]);
		// The ETag guards page 1 only.
		expect(calls[0]?.headers["If-None-Match"]).toBe('W/"old"');
		expect(calls[1]?.headers["If-None-Match"]).toBeUndefined();
		expect(result).toMatchObject({ kind: "ok", etag: 'W/"p1"' });
		if (result.kind === "ok") expect(result.deployments).toHaveLength(63);
	});

	it("stops at the page cap, and reads one page when there is no cursor yet", async () => {
		const full = Array.from({ length: 30 }, (_, i) => ({ id: 1000 - i }));
		const capped = scriptedFetch([{ json: full }]);
		await listDeployments(
			{ fetch: capped.fetch, now: () => NOW },
			{ ...args, lastSeen: 1, maxPages: 2 },
		);
		expect(capped.calls).toHaveLength(2);

		const baseline = scriptedFetch([{ json: full }]);
		await listDeployments(
			{ fetch: baseline.fetch, now: () => NOW },
			{ ...args, lastSeen: null },
		);
		expect(baseline.calls).toHaveLength(1);
	});

	it("returns the error of a later page instead of a partial list", async () => {
		const full = Array.from({ length: 30 }, (_, i) => ({ id: 100 - i }));
		const { fetch } = scriptedFetch([{ json: full }, { status: 502 }]);
		expect(
			await listDeployments(
				{ fetch, now: () => NOW },
				{ ...args, lastSeen: 1 },
			),
		).toEqual({ kind: "error", status: 502 });
	});

	it("url-encodes the environment name", async () => {
		const { fetch, calls } = scriptedFetch([{ json: [] }]);
		await listDeployments(
			{ fetch, now: () => NOW },
			{ ...args, environment: "prod & co/1" },
		);
		expect(calls[0]?.url).toContain("environment=prod%20%26%20co%2F1");
	});

	it("maps 401, 404 and server errors", async () => {
		const run = async (status: number) =>
			listDeployments(
				{ fetch: scriptedFetch([{ status }]).fetch, now: () => NOW },
				args,
			);
		expect((await run(401)).kind).toBe("unauthorized");
		expect((await run(404)).kind).toBe("not-found");
		expect(await run(500)).toEqual({ kind: "error", status: 500 });
	});

	it("backs off on 403 with the rate limit headers", async () => {
		const reset = Math.floor(NOW / 1000) + 120;
		const { fetch } = scriptedFetch([
			{
				status: 403,
				text: "API rate limit exceeded",
				headers: {
					"x-ratelimit-remaining": "0",
					"x-ratelimit-reset": String(reset),
				},
			},
		]);
		const result = await listDeployments({ fetch, now: () => NOW }, args);
		expect(result).toEqual({
			kind: "rate-limited",
			retryAt: reset * 1000 + 1000,
		});
	});

	it("backs off on 429 for Retry-After seconds", async () => {
		const { fetch } = scriptedFetch([
			{ status: 429, headers: { "retry-after": "45" } },
		]);
		const result = await listDeployments({ fetch, now: () => NOW }, args);
		expect(result).toEqual({ kind: "rate-limited", retryAt: NOW + 45_000 });
	});

	it("treats a 403 that is not a rate limit as a permission error", async () => {
		const { fetch } = scriptedFetch([
			{ status: 403, text: "Resource not accessible" },
		]);
		const result = await listDeployments({ fetch, now: () => NOW }, args);
		expect(result.kind).toBe("forbidden");
	});

	it("survives a network error", async () => {
		const { fetch } = scriptedFetch([new Error("socket")]);
		expect(await listDeployments({ fetch, now: () => NOW }, args)).toEqual({
			kind: "error",
			status: 0,
		});
	});
});

describe("rateLimitRetryAt", () => {
	const h = (map: Record<string, string>) => ({
		get: (name: string) => map[name.toLowerCase()] ?? null,
	});
	it("uses a secondary-limit body with no headers: wait a minute", () => {
		expect(
			rateLimitRetryAt(
				403,
				h({}),
				"You have exceeded a secondary rate limit",
				NOW,
			),
		).toBe(NOW + 60_000);
	});
	it("never sleeps longer than an hour", () => {
		expect(rateLimitRetryAt(429, h({ "retry-after": "999999" }), "", NOW)).toBe(
			NOW + 3_600_000,
		);
	});
	it("ignores other statuses", () => {
		expect(
			rateLimitRetryAt(500, h({ "retry-after": "5" }), "", NOW),
		).toBeNull();
	});
});

describe("createDeploymentStatus", () => {
	it("posts the state, description and log_url to the deployment's statuses", async () => {
		const { fetch, calls } = scriptedFetch([{ status: 201, json: {} }]);
		const result = await createDeploymentStatus(
			{ fetch, now: () => NOW },
			{
				...args,
				deploymentId: 4242,
				state: "in_progress",
				description: "Dokploy accepted the deployment",
				logUrl: "https://dokploy.example/dashboard/x",
			},
		);
		expect(result).toEqual({ ok: true });
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/DevinoSolutions/sendly/deployments/4242/statuses",
		);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			state: "in_progress",
			description: "Dokploy accepted the deployment",
			log_url: "https://dokploy.example/dashboard/x",
		});
	});

	it("never sends the token in the body or the URL", async () => {
		const { fetch, calls } = scriptedFetch([{ status: 201, json: {} }]);
		await createDeploymentStatus(
			{ fetch, now: () => NOW },
			{ ...args, deploymentId: 1, state: "success", description: "ok" },
		);
		expect(calls[0]?.url).not.toContain("gho_secret");
		expect(calls[0]?.body).not.toContain("gho_secret");
	});

	it("clamps the description to GitHub's 140 characters", async () => {
		expect(clampDescription("x".repeat(500))).toHaveLength(140);
		const { fetch, calls } = scriptedFetch([{ status: 201, json: {} }]);
		await createDeploymentStatus(
			{ fetch, now: () => NOW },
			{
				...args,
				deploymentId: 1,
				state: "failure",
				description: "y".repeat(400),
			},
		);
		expect(JSON.parse(calls[0]?.body ?? "{}").description).toHaveLength(140);
	});

	it("reports a rate limit with the time to wait", async () => {
		const { fetch } = scriptedFetch([
			{ status: 429, headers: { "retry-after": "10" } },
		]);
		const result = await createDeploymentStatus(
			{ fetch, now: () => NOW },
			{ ...args, deploymentId: 1, state: "success", description: "ok" },
		);
		expect(result).toEqual({
			ok: false,
			status: 429,
			rateLimitedUntil: NOW + 10_000,
		});
	});
});

describe("fetchTokenOwner", () => {
	it("returns the login, id and granted scopes, and nothing else", async () => {
		const { fetch } = scriptedFetch([
			{
				json: { login: "amin", id: 123, email: "private@example.com" },
				headers: { "x-oauth-scopes": "read:packages, repo_deployment" },
			},
		]);
		const result = await fetchTokenOwner({ fetch }, "gho_secret");
		expect(result).toEqual({
			ok: true,
			login: "amin",
			userId: "123",
			scopes: "read:packages,repo_deployment",
		});
	});
});
