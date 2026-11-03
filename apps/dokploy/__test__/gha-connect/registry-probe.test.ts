import {
	createRegistryProbe,
	parseBearerChallenge,
} from "@dokploy/server/services/gha-connect/registry-probe";
import { describe, expect, it } from "vitest";
import { type Reply, routedFetch } from "./gha-helpers";

const DIGEST = `sha256:${"e".repeat(64)}`;
const INPUT = { host: "ghcr.io", name: "acme/shop/web", digest: DIGEST };

describe("parseBearerChallenge", () => {
	it("reads realm, service and scope", () => {
		expect(
			parseBearerChallenge(
				'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/shop/web:pull"',
			),
		).toEqual({
			realm: "https://ghcr.io/token",
			service: "ghcr.io",
			scope: "repository:acme/shop/web:pull",
		});
	});
	it("ignores other schemes and a challenge without a realm", () => {
		expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
		expect(parseBearerChallenge('Bearer service="x"')).toBeNull();
		expect(parseBearerChallenge(null)).toBeNull();
	});
});

describe("registry probe", () => {
	it("returns the digest a registry serves, using HEAD with manifest types", async () => {
		const { fetch, calls } = routedFetch([
			["/v2/", { headers: { "Docker-Content-Digest": DIGEST } }],
		]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		expect(await probe.headDigest(INPUT)).toEqual({
			kind: "ok",
			digest: DIGEST,
		});
		expect(calls[0]).toMatchObject({
			method: "HEAD",
			url: `https://ghcr.io/v2/acme/shop/web/manifests/${DIGEST}`,
		});
		expect(calls[0]?.headers.Accept).toContain(
			"application/vnd.oci.image.index.v1+json",
		);
	});

	it("follows the bearer challenge once, with the anonymous token of a public image", async () => {
		let heads = 0;
		const { fetch, calls } = routedFetch([
			["/token", { json: { token: "anon-token" } }],
			[
				"/v2/",
				(call): Reply => {
					heads += 1;
					return call.headers.Authorization === "Bearer anon-token"
						? { headers: { "Docker-Content-Digest": DIGEST } }
						: {
								status: 401,
								headers: {
									"WWW-Authenticate":
										'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
								},
							};
				},
			],
		]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		expect(await probe.headDigest(INPUT)).toEqual({
			kind: "ok",
			digest: DIGEST,
		});
		expect(heads).toBe(2);
		const tokenCall = calls.find((c) => c.url.includes("/token"));
		expect(tokenCall?.url).toContain(
			"scope=repository%3Aacme%2Fshop%2Fweb%3Apull",
		);
		expect(tokenCall?.headers.Authorization).toBeUndefined();
	});

	it("uses the credentials this Dokploy holds for a private registry", async () => {
		const { fetch, calls } = routedFetch([
			["/v2/", { headers: { "Docker-Content-Digest": DIGEST } }],
		]);
		const probe = createRegistryProbe({
			fetch,
			loadAccess: async (host) =>
				host === "registry.devino.ca"
					? {
							baseUrl: "https://registry.devino.ca/",
							username: "dokploy",
							password: "pw",
						}
					: null,
		});
		await probe.headDigest({
			...INPUT,
			host: "registry.devino.ca",
			name: "voicelabs/web",
		});
		expect(calls[0]?.url).toBe(
			`https://registry.devino.ca/v2/voicelabs/web/manifests/${DIGEST}`,
		);
		expect(calls[0]?.headers.Authorization).toBe(
			`Basic ${Buffer.from("dokploy:pw").toString("base64")}`,
		);
	});

	it("does not send the registry password to a token endpoint on plain http", async () => {
		const { fetch, calls } = routedFetch([
			[
				"/v2/",
				{
					status: 401,
					headers: {
						"WWW-Authenticate": 'Bearer realm="http://evil.example/token"',
					},
				},
			],
		]);
		const probe = createRegistryProbe({
			fetch,
			loadAccess: async () => ({
				baseUrl: "https://registry.devino.ca",
				username: "u",
				password: "p",
			}),
		});
		expect(
			await probe.headDigest({ ...INPUT, host: "registry.devino.ca" }),
		).toEqual({
			kind: "unreachable",
			status: 401,
		});
		expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
	});

	it("maps 404, other statuses and a network failure", async () => {
		const missing = routedFetch([["/v2/", { status: 404 }]]);
		expect(
			await createRegistryProbe({
				fetch: missing.fetch,
				loadAccess: async () => null,
			}).headDigest(INPUT),
		).toEqual({ kind: "not-found" });
		const broken = routedFetch([["/v2/", { status: 503 }]]);
		expect(
			await createRegistryProbe({
				fetch: broken.fetch,
				loadAccess: async () => null,
			}).headDigest(INPUT),
		).toEqual({ kind: "unreachable", status: 503 });
		const down = createRegistryProbe({
			fetch: async () => {
				throw new Error("offline");
			},
			loadAccess: async () => null,
		});
		expect(await down.headDigest(INPUT)).toEqual({
			kind: "unreachable",
			status: 0,
		});
	});

	it("reports a missing Docker-Content-Digest header as null (the caller refuses it)", async () => {
		const { fetch } = routedFetch([["/v2/", {}]]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		expect(await probe.headDigest(INPUT)).toEqual({ kind: "ok", digest: null });
	});

	it("refuses a malformed host, name or digest without any request", async () => {
		const { fetch, calls } = routedFetch([["/", {}]]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		for (const bad of [
			{ ...INPUT, host: "evil.com/x" },
			{ ...INPUT, name: "../etc" },
			{ ...INPUT, name: "A/B" },
			{ ...INPUT, digest: "sha256:short" },
		]) {
			expect(await probe.headDigest(bad)).toEqual({ kind: "not-found" });
		}
		expect(calls).toHaveLength(0);
	});
});
