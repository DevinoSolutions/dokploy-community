import {
	GITHUB_DEVICE_DEFAULT_CLIENT_ID,
	GITHUB_DEVICE_SCOPE,
} from "@dokploy/server/db/schema/github-deployment";
import {
	ACCESS_TOKEN_URL,
	DEVICE_CODE_URL,
	DEVICE_GRANT_TYPE,
	getDeviceClientId,
	startDeviceFlow,
	stepDeviceFlow,
} from "@dokploy/server/services/github-deployments/device-flow";
import { describe, expect, it } from "vitest";
import { scriptedFetch } from "./helpers";

const T0 = 1_000_000;

const started = {
	device_code: "dc-secret",
	user_code: "ABCD-1234",
	verification_uri: "https://github.com/login/device",
	expires_in: 900,
	interval: 5,
};

describe("client id", () => {
	it("defaults to the public Dokploy Community OAuth App", () => {
		expect(GITHUB_DEVICE_DEFAULT_CLIENT_ID).toBe("Ov23liBkg97sIGx9nKb6");
		expect(getDeviceClientId({})).toBe("Ov23liBkg97sIGx9nKb6");
	});

	it("is overridable with DOKPLOY_GITHUB_DEVICE_CLIENT_ID", () => {
		expect(
			getDeviceClientId({
				DOKPLOY_GITHUB_DEVICE_CLIENT_ID: "Iv1.abcdef123456",
			}),
		).toBe("Iv1.abcdef123456");
	});

	it("ignores an override that is not a plausible client id", () => {
		expect(
			getDeviceClientId({ DOKPLOY_GITHUB_DEVICE_CLIENT_ID: "a b&c=d" }),
		).toBe("Ov23liBkg97sIGx9nKb6");
	});
});

describe("startDeviceFlow", () => {
	it("asks for the narrow scopes with the client id and keeps the device code", async () => {
		const { fetch, calls } = scriptedFetch([{ json: started }]);
		const result = await startDeviceFlow({ fetch, now: () => T0 });
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(DEVICE_CODE_URL);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers.Accept).toBe("application/json");
		const body = new URLSearchParams(calls[0]?.body);
		expect(body.get("client_id")).toBe(GITHUB_DEVICE_DEFAULT_CLIENT_ID);
		expect(body.get("scope")).toBe("repo_deployment read:packages");
		expect(body.get("scope")).toBe(GITHUB_DEVICE_SCOPE);
		expect(body.has("client_secret")).toBe(false);
		if (result.ok) {
			expect(result.state.userCode).toBe("ABCD-1234");
			expect(result.state.verificationUri).toBe(
				"https://github.com/login/device",
			);
			expect(result.state.intervalSeconds).toBe(5);
			expect(result.state.expiresAt).toBe(T0 + 900_000);
			expect(result.state.nextPollAt).toBe(T0 + 5_000);
		}
	});

	it("reports a network failure and an unexpected body without throwing", async () => {
		const down = scriptedFetch([new Error("ENOTFOUND")]);
		expect(await startDeviceFlow({ fetch: down.fetch, now: () => T0 })).toEqual(
			{
				ok: false,
				message: "Could not reach github.com",
			},
		);
		const odd = scriptedFetch([{ json: { hello: "world" } }]);
		const result = await startDeviceFlow({ fetch: odd.fetch, now: () => T0 });
		expect(result.ok).toBe(false);
	});

	it("says so when the OAuth App has the device flow disabled", async () => {
		const { fetch } = scriptedFetch([
			{ status: 400, json: { error: "device_flow_disabled" } },
		]);
		const result = await startDeviceFlow({ fetch, now: () => T0 });
		expect(result).toEqual({
			ok: false,
			message: "Device flow is not enabled for the GitHub OAuth App",
		});
	});
});

describe("stepDeviceFlow", () => {
	const state = {
		deviceCode: "dc-secret",
		userCode: "ABCD-1234",
		verificationUri: "https://github.com/login/device",
		intervalSeconds: 5,
		nextPollAt: T0,
		expiresAt: T0 + 900_000,
	};

	it("polls the token endpoint with the device grant type", async () => {
		const { fetch, calls } = scriptedFetch([
			{ json: { error: "authorization_pending" } },
		]);
		await stepDeviceFlow(state, { fetch, now: () => T0 });
		expect(calls[0]?.url).toBe(ACCESS_TOKEN_URL);
		const body = new URLSearchParams(calls[0]?.body);
		expect(body.get("grant_type")).toBe(DEVICE_GRANT_TYPE);
		expect(body.get("device_code")).toBe("dc-secret");
		expect(body.get("client_id")).toBe(GITHUB_DEVICE_DEFAULT_CLIENT_ID);
	});

	it("authorization_pending waits one more interval", async () => {
		const { fetch } = scriptedFetch([
			{ json: { error: "authorization_pending" } },
		]);
		const step = await stepDeviceFlow(state, { fetch, now: () => T0 });
		expect(step.status).toBe("pending");
		if (step.status === "pending") {
			expect(step.retryAfterSeconds).toBe(5);
			expect(step.state.nextPollAt).toBe(T0 + 5_000);
		}
	});

	it("does not touch the network before the interval has passed", async () => {
		const { fetch, calls } = scriptedFetch([
			{ json: { error: "authorization_pending" } },
		]);
		const early = { ...state, nextPollAt: T0 + 4_000 };
		const step = await stepDeviceFlow(early, { fetch, now: () => T0 + 1_000 });
		expect(calls).toHaveLength(0);
		expect(step).toMatchObject({ status: "pending", retryAfterSeconds: 3 });
	});

	it("slow_down raises the interval by 5 seconds, or to the one GitHub names", async () => {
		const plain = scriptedFetch([{ json: { error: "slow_down" } }]);
		const a = await stepDeviceFlow(state, {
			fetch: plain.fetch,
			now: () => T0,
		});
		expect(a).toMatchObject({ status: "pending", retryAfterSeconds: 10 });

		const named = scriptedFetch([
			{ json: { error: "slow_down", interval: 30 } },
		]);
		const b = await stepDeviceFlow(state, {
			fetch: named.fetch,
			now: () => T0,
		});
		expect(b).toMatchObject({ status: "pending", retryAfterSeconds: 30 });
		if (b.status === "pending") expect(b.state.nextPollAt).toBe(T0 + 30_000);
	});

	it("returns the token and the scopes when authorized", async () => {
		const { fetch } = scriptedFetch([
			{
				json: {
					access_token: "gho_secret",
					token_type: "bearer",
					scope: "repo_deployment,read:packages",
				},
			},
		]);
		const step = await stepDeviceFlow(state, { fetch, now: () => T0 });
		expect(step).toEqual({
			status: "authorized",
			accessToken: "gho_secret",
			scope: "repo_deployment,read:packages",
		});
	});

	it("maps expired_token and access_denied", async () => {
		const expired = scriptedFetch([{ json: { error: "expired_token" } }]);
		expect(
			await stepDeviceFlow(state, { fetch: expired.fetch, now: () => T0 }),
		).toEqual({ status: "expired" });
		const denied = scriptedFetch([{ json: { error: "access_denied" } }]);
		expect(
			await stepDeviceFlow(state, { fetch: denied.fetch, now: () => T0 }),
		).toEqual({ status: "denied" });
	});

	it("expires locally once the code is past its lifetime, without a request", async () => {
		const { fetch, calls } = scriptedFetch([{ json: {} }]);
		const step = await stepDeviceFlow(state, {
			fetch,
			now: () => T0 + 900_000,
		});
		expect(step).toEqual({ status: "expired" });
		expect(calls).toHaveLength(0);
	});

	it("keeps waiting through a network error or a 5xx, fails on a hard error", async () => {
		const blip = scriptedFetch([new Error("socket hang up")]);
		expect(
			(await stepDeviceFlow(state, { fetch: blip.fetch, now: () => T0 }))
				.status,
		).toBe("pending");
		const server = scriptedFetch([{ status: 502, json: {} }]);
		expect(
			(await stepDeviceFlow(state, { fetch: server.fetch, now: () => T0 }))
				.status,
		).toBe("pending");
		const bad = scriptedFetch([
			{ status: 400, json: { error: "incorrect_client_credentials" } },
		]);
		expect(
			(await stepDeviceFlow(state, { fetch: bad.fetch, now: () => T0 })).status,
		).toBe("failed");
	});
});
