import { evaluateEnvironmentPolicy } from "@dokploy/server/services/gha-connect/environment-policy";
import {
	allowedNamespaces,
	canonicalRepository,
	checkImageRepository,
	splitRepository,
} from "@dokploy/server/services/gha-connect/namespace";
import {
	type CompareStatus,
	decideOrdering,
	type ReleaseStamp,
} from "@dokploy/server/services/gha-connect/ordering";
import { describe, expect, it } from "vitest";

describe("image namespace", () => {
	const namespaces = allowedNamespaces({
		owner: "DevinoSolutions",
		repo: "VoiceLabs",
		registryPrefix: "registry.devino.ca",
	});

	it("allows the owner's public GHCR path and the instance registry path, lower-cased", () => {
		expect(namespaces).toEqual([
			"ghcr.io/devinosolutions/voicelabs/",
			"registry.devino.ca/voicelabs/",
		]);
	});

	it("has no registry namespace when the connection names no registry host", () => {
		expect(
			allowedNamespaces({ owner: "acme", repo: "shop", registryPrefix: null }),
		).toEqual(["ghcr.io/acme/shop/"]);
	});

	it("accepts an image inside the namespace before the service runs anything", () => {
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicelabs/web",
				namespaces,
				currentRepositories: [],
			}),
		).toEqual({ ok: true });
	});

	it("refuses another registry, another repository path and a look-alike prefix", () => {
		for (const repository of [
			"evil.example.com/voicelabs/web",
			"registry.devino.ca/other/web",
			"registry.devino.ca/voicelabs-extra/web",
			"ghcr.io/devinosolutions/voicelabs-other/web",
		]) {
			expect(
				checkImageRepository({
					repository,
					namespaces,
					currentRepositories: [],
				}),
			).toMatchObject({ ok: false, code: "image-namespace" });
		}
	});

	it("refuses the preview namespace, even for the first release", () => {
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicelabs/preview/pr-4/web",
				namespaces,
				currentRepositories: [],
			}),
		).toMatchObject({ ok: false, code: "image-namespace" });
	});

	it("once the service runs an image, only that repository may move", () => {
		const current = ["registry.devino.ca/voicelabs/web"];
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicelabs/web",
				namespaces,
				currentRepositories: current,
			}),
		).toEqual({ ok: true });
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicelabs/worker",
				namespaces,
				currentRepositories: current,
			}),
		).toMatchObject({ ok: false, code: "image-repository" });
	});

	it("compares case-insensitively", () => {
		expect(
			checkImageRepository({
				repository: "Registry.Devino.CA/VoiceLabs/Web",
				namespaces,
				currentRepositories: ["registry.devino.ca/voicelabs/web"],
			}),
		).toEqual({ ok: true });
	});

	it("splits host and name", () => {
		expect(splitRepository("ghcr.io/acme/shop/web")).toEqual({
			host: "ghcr.io",
			name: "acme/shop/web",
		});
		expect(splitRepository("localhost:5000/x/y")).toEqual({
			host: "localhost:5000",
			name: "x/y",
		});
		expect(splitRepository("library/nginx")).toBeNull();
		expect(splitRepository("nginx")).toBeNull();
	});
});

describe("the tunnel mirror prefix (localhost:5000/registry.devino.ca)", () => {
	const registryPrefix = "localhost:5000/registry.devino.ca";
	const namespaces = allowedNamespaces({
		owner: "DevinoSolutions",
		repo: "voicelabs",
		registryPrefix,
	});

	it("builds the namespace from the prefix, with or without a trailing slash", () => {
		expect(namespaces).toEqual([
			"ghcr.io/devinosolutions/voicelabs/",
			"localhost:5000/registry.devino.ca/voicelabs/",
		]);
		expect(
			allowedNamespaces({
				owner: "DevinoSolutions",
				repo: "voicelabs",
				registryPrefix: `${registryPrefix}/`,
			}),
		).toEqual(namespaces);
	});

	it("accepts what the wrapper's mirror step writes and still refuses preview and foreign paths", () => {
		const check = (repository: string) =>
			checkImageRepository({ repository, namespaces, currentRepositories: [] });
		expect(check("localhost:5000/registry.devino.ca/voicelabs/web")).toEqual({
			ok: true,
		});
		expect(
			check("localhost:5000/registry.devino.ca/voicelabs/preview/pr-7"),
		).toMatchObject({ ok: false, code: "image-namespace" });
		expect(check("localhost:5000/registry.devino.ca/other/web")).toMatchObject({
			ok: false,
			code: "image-namespace",
		});
		expect(check("registry.devino.ca/voicelabs/web")).toMatchObject({
			ok: false,
			code: "image-namespace",
		});
	});

	it("splits the image so the registry name keeps the mirrored host segment", () => {
		expect(
			splitRepository("localhost:5000/registry.devino.ca/voicelabs/web"),
		).toEqual({
			host: "localhost:5000",
			name: "registry.devino.ca/voicelabs/web",
		});
	});

	it("maps a mirrored image back to the GHCR image it was copied from", () => {
		expect(
			canonicalRepository({
				repository: "localhost:5000/registry.devino.ca/voicelabs/web",
				owner: "DevinoSolutions",
				registryPrefix,
			}),
		).toBe("ghcr.io/devinosolutions/voicelabs/web");
		expect(
			canonicalRepository({
				repository: "ghcr.io/devinosolutions/voicelabs/web",
				owner: "DevinoSolutions",
				registryPrefix,
			}),
		).toBeNull();
		expect(
			canonicalRepository({
				repository: "localhost:5000/registry.devino.ca/voicelabs/web",
				owner: "x",
				registryPrefix: null,
			}),
		).toBeNull();
	});
});

describe("decideOrdering", () => {
	const D1 = ["sha256:" + "1".repeat(64)];
	const D2 = ["sha256:" + "2".repeat(64)];
	const stamp = (overrides: Partial<ReleaseStamp> = {}): ReleaseStamp => ({
		sha: "a".repeat(40),
		runId: 100,
		attempt: 1,
		digests: D1,
		...overrides,
	});
	const decide = (
		overrides: Partial<Parameters<typeof decideOrdering>[0]> = {},
	) =>
		decideOrdering({
			deployed: stamp(),
			candidate: stamp({ sha: "b".repeat(40), runId: 101, digests: D2 }),
			deployedToCandidate: "ahead",
			reachableFromBranch: true,
			allowBehind: false,
			...overrides,
		});

	it("accepts a newer commit", () => {
		expect(decide()).toEqual({ accept: true, noop: false });
	});

	it("accepts the first release", () => {
		expect(decide({ deployed: null, deployedToCandidate: null })).toEqual({
			accept: true,
			noop: false,
		});
	});

	it("refuses a commit that is not on the tracked branch", () => {
		expect(decide({ reachableFromBranch: false })).toMatchObject({
			accept: false,
			code: "not-on-branch",
		});
	});

	it("refuses an ancestor of the deployed commit unless it is a rollback", () => {
		expect(decide({ deployedToCandidate: "behind" })).toMatchObject({
			accept: false,
			code: "ordering-behind",
		});
		expect(
			decide({ deployedToCandidate: "behind", allowBehind: true }),
		).toEqual({
			accept: true,
			noop: false,
		});
	});

	it("recovers from a force push (diverged)", () => {
		expect(decide({ deployedToCandidate: "diverged" })).toEqual({
			accept: true,
			noop: false,
		});
	});

	describe("two releases of one commit", () => {
		const same = (
			candidate: Partial<ReleaseStamp>,
			deployed: Partial<ReleaseStamp> = {},
		) =>
			decide({
				deployed: stamp(deployed),
				candidate: stamp(candidate),
				deployedToCandidate: null,
			});

		it("a higher attempt of the same run wins", () => {
			expect(same({ attempt: 2, digests: D2 })).toEqual({
				accept: true,
				noop: false,
			});
		});
		it("a higher attempt with identical digests is a no-op", () => {
			expect(same({ attempt: 2 })).toEqual({ accept: true, noop: true });
		});
		it("a lower attempt is refused", () => {
			expect(same({ attempt: 1 }, { attempt: 3 })).toMatchObject({
				accept: false,
				code: "ordering-lower-attempt",
			});
		});
		it("the same attempt again is a no-op only with identical digests", () => {
			expect(same({})).toEqual({ accept: true, noop: true });
			expect(same({ digests: D2 })).toMatchObject({
				accept: false,
				code: "ordering-lower-attempt",
			});
		});
		it("the later run of the commit wins, the older is refused", () => {
			expect(same({ runId: 101, digests: D2 })).toEqual({
				accept: true,
				noop: false,
			});
			expect(same({ runId: 99, digests: D2 })).toMatchObject({
				accept: false,
				code: "ordering-older-run",
			});
		});
	});

	it("needs a compare status for two different commits", () => {
		const status = null as CompareStatus | null;
		expect(() => decide({ deployedToCandidate: status })).toThrow();
	});
});

describe("evaluateEnvironmentPolicy", () => {
	const policy = (overrides = {}) => ({
		customBranchPolicies: true,
		protectedBranches: false,
		policies: [{ name: "main", type: "branch" }],
		...overrides,
	});

	it("passes when exactly the tracked branch is allowed", () => {
		expect(evaluateEnvironmentPolicy(policy(), "main")).toEqual({ ok: true });
	});

	it.each([
		[
			"no custom policy (any branch)",
			policy({ customBranchPolicies: false, policies: [] }),
		],
		[
			"protected branches only",
			policy({
				customBranchPolicies: false,
				protectedBranches: true,
				policies: [],
			}),
		],
		[
			"a second branch",
			policy({
				policies: [
					{ name: "main", type: "branch" },
					{ name: "dev", type: "branch" },
				],
			}),
		],
		["a wildcard", policy({ policies: [{ name: "*", type: "branch" }] })],
		["a pattern", policy({ policies: [{ name: "ma*", type: "branch" }] })],
		["a tag policy", policy({ policies: [{ name: "main", type: "tag" }] })],
		["another branch", policy({ policies: [{ name: "dev", type: "branch" }] })],
		["no policy at all", policy({ policies: [] })],
	])("refuses %s", (_name, value) => {
		expect(evaluateEnvironmentPolicy(value, "main").ok).toBe(false);
	});
});
