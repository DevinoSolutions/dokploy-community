import type {
	ConnectPlan,
	ConnectReads,
	ServiceFacts,
} from "@dokploy/server/services/gha-connect/connect";
import {
	type ConnectServiceDeps,
	type ConnectServiceInput,
	connectGhaService,
	registryHostOf,
} from "@dokploy/server/services/gha-connect/connect-service";
import { describe, expect, it, vi } from "vitest";

const SHA = "d".repeat(40);

const input: ConnectServiceInput = {
	serviceType: "application",
	serviceId: "app-1",
	githubConnectionId: "gc-1",
	owner: "acme",
	repo: "shop",
	workflowPath: ".github/workflows/dokploy.yml",
	trackedBranch: "main",
	environment: "production",
	serviceKey: "shop",
	registryPrefix: null,
	registryId: null,
	protectionMode: "environment",
	gateMode: "image",
};

const docker: ServiceFacts = {
	kind: "application",
	sourceType: "docker",
	owner: null,
	repository: null,
	fields: {},
};

const goodReads: ConnectReads = {
	repository: async () => ({
		kind: "ok",
		etag: null,
		value: {
			id: 7,
			owner: "acme",
			name: "shop",
			fullName: "acme/shop",
			defaultBranch: "main",
			isPrivate: false,
		},
	}),
	branchHead: async () => ({ kind: "ok", etag: null, value: { sha: SHA } }),
	environmentPolicy: async () => ({
		kind: "ok",
		etag: null,
		value: {
			customBranchPolicies: true,
			protectedBranches: false,
			policies: [{ name: "main", type: "branch" }],
		},
	}),
};

const deps = (
	over: Partial<ConnectServiceDeps<string>> = {},
): ConnectServiceDeps<string> => ({
	githubConnection: async () => ({
		scopes: ["repo_deployment", "public_repo"],
		status: "active",
	}),
	token: async () => "tok",
	service: async () => docker,
	existing: async () => ({ connection: false, plainWatch: false }),
	reads: () => goodReads,
	registry: async () => ({ registryUrl: "https://Registry.Devino.CA/" }),
	persist: async () => "saved-row",
	isUniqueViolation: (error) => (error as { code?: string }).code === "23505",
	...over,
});

describe("connectGhaService", () => {
	it("connects a service that passes every check", async () => {
		const persist = vi.fn(
			async (
				_plan: ConnectPlan,
				_input: ConnectServiceInput,
				_registry: { registryProbeHost: string | null },
			) => "saved-row",
		);
		const result = await connectGhaService(input, deps({ persist }));
		expect(result).toMatchObject({ ok: true, saved: "saved-row" });
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist.mock.calls[0]?.[0]).toMatchObject({
			repoId: 7,
			expectedSha: SHA,
		});
	});

	it("takes the digest-check host from the chosen Dokploy registry, not from the prefix", async () => {
		const persist = vi.fn(
			async (
				_plan: ConnectPlan,
				_input: ConnectServiceInput,
				_registry: { registryProbeHost: string | null },
			) => "saved-row",
		);
		const mirrored = {
			...input,
			registryPrefix: "localhost:5000/registry.devino.ca",
			registryId: "reg-1",
		};
		const result = await connectGhaService(mirrored, deps({ persist }));
		expect(result).toMatchObject({ ok: true });
		expect(persist.mock.calls[0]?.[2]).toEqual({
			registryProbeHost: "registry.devino.ca",
		});
	});

	it("needs a Dokploy registry record whenever a registry prefix is given", async () => {
		const mirrored = {
			...input,
			registryPrefix: "localhost:5000/registry.devino.ca",
			registryId: null,
		};
		const noId = await connectGhaService(mirrored, deps());
		expect(noId).toMatchObject({ ok: false, code: "registry" });
		const gone = await connectGhaService(
			{ ...mirrored, registryId: "reg-9" },
			deps({ registry: async () => null }),
		);
		expect(gone).toMatchObject({ ok: false, code: "registry" });
		const blank = await connectGhaService(
			{ ...mirrored, registryId: "reg-1" },
			deps({ registry: async () => ({ registryUrl: "  /  " }) }),
		);
		expect(blank).toMatchObject({ ok: false, code: "registry" });
	});

	it("refuses a registry without an image prefix", async () => {
		const result = await connectGhaService(
			{ ...input, registryId: "reg-1" },
			deps(),
		);
		expect(result).toMatchObject({ ok: false, code: "registry" });
	});

	it("looks up no registry for public GHCR images", async () => {
		const registry = vi.fn(async () => null);
		const result = await connectGhaService(input, deps({ registry }));
		expect(result).toMatchObject({ ok: true });
		expect(registry).not.toHaveBeenCalled();
	});

	it("answers not found for a service of another organization", async () => {
		const result = await connectGhaService(
			input,
			deps({ service: async () => null }),
		);
		expect(result).toMatchObject({ ok: false, code: "not-found" });
	});

	it("refuses a revoked GitHub connection and a missing one", async () => {
		const revoked = await connectGhaService(
			input,
			deps({
				githubConnection: async () => ({ scopes: [], status: "revoked" }),
			}),
		);
		expect(revoked).toMatchObject({ ok: false, code: "connection" });
		const missing = await connectGhaService(
			input,
			deps({ githubConnection: async () => null }),
		);
		expect(missing).toMatchObject({ ok: false, code: "connection" });
	});

	it("refuses a service that is already connected or already has a plain watch", async () => {
		const connected = await connectGhaService(
			input,
			deps({ existing: async () => ({ connection: true, plainWatch: false }) }),
		);
		expect(connected).toMatchObject({ ok: false, code: "conflict" });
		const plain = await connectGhaService(
			input,
			deps({ existing: async () => ({ connection: false, plainWatch: true }) }),
		);
		expect(plain).toMatchObject({ ok: false, code: "conflict" });
		if (plain.ok) throw new Error("unreachable");
		expect(plain.message).toMatch(/Deploy from GitHub Deployments/);
	});

	it("passes the account scopes to the checks", async () => {
		const result = await connectGhaService(
			input,
			deps({
				githubConnection: async () => ({
					scopes: ["repo_deployment", "read:packages"],
					status: "active",
				}),
			}),
		);
		expect(result).toMatchObject({ ok: false, code: "scope" });
	});

	it("does not persist when a check fails", async () => {
		const persist = vi.fn(
			async (_plan: ConnectPlan, _input: ConnectServiceInput) => "x",
		);
		const wide = {
			customBranchPolicies: false,
			protectedBranches: false,
			policies: [],
		};
		await connectGhaService(
			input,
			deps({
				persist,
				reads: () => ({
					...goodReads,
					environmentPolicy: async () => ({
						kind: "ok",
						etag: null,
						value: wide,
					}),
				}),
			}),
		);
		expect(persist).not.toHaveBeenCalled();
	});

	it("turns a unique violation into a conflict that names the key", async () => {
		const result = await connectGhaService(
			input,
			deps({
				persist: async () => {
					throw Object.assign(new Error("duplicate"), { code: "23505" });
				},
			}),
		);
		expect(result).toMatchObject({ ok: false, code: "conflict" });
		if (result.ok) throw new Error("unreachable");
		expect(result.message).toMatch(/key shop/);
	});

	it("lets any other persist error through", async () => {
		await expect(
			connectGhaService(
				input,
				deps({
					persist: async () => {
						throw new Error("disk full");
					},
				}),
			),
		).rejects.toThrow("disk full");
	});
});

describe("registryHostOf: the host digests are checked at, taken from the URL", () => {
	it.each([
		["https://Registry.Devino.CA/", "registry.devino.ca"],
		["registry.devino.ca", "registry.devino.ca"],
		["http://registry.devino.ca:5000/some/path?x=1#frag", "registry.devino.ca:5000"],
		["  https://registry.devino.ca/v2/  ", "registry.devino.ca"],
	])("%s -> %s", (url, host) => {
		expect(registryHostOf(url)).toBe(host);
	});

	it.each([
		"",
		"  /  ",
		"https://user:pw@registry.devino.ca",
		"ftp://registry.devino.ca",
		"https://",
	])("refuses %j", (url) => {
		expect(registryHostOf(url)).toBeNull();
	});
});
