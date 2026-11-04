import { checkImageRepository } from "@dokploy/server/services/gha-connect/namespace";
import {
	deriveReleaseImage,
	expectedImageRepository,
	isInsideNamespaces,
} from "@dokploy/server/services/gha-connect/release-image";
import { describe, expect, it } from "vitest";

const D = `sha256:${"a".repeat(64)}`;
const base = {
	owner: "org",
	repo: "shop",
	serviceKey: "web",
	registryPrefix: null,
};
const MIRROR = "localhost:5000/registry.devino.ca";

describe("deriveReleaseImage, an application", () => {
	it("(a) is the repository it already runs when that is inside ghcr.io/<owner>/<repo>/", () => {
		expect(
			deriveReleaseImage({
				...base,
				kind: "application",
				dockerImage: `ghcr.io/org/shop/storefront@${D}`,
			}),
		).toEqual({
			ok: true,
			repositories: ["ghcr.io/org/shop/storefront"],
			source: "running",
		});
	});

	it("(a) is the mirror repository when it runs inside the registry prefix", () => {
		expect(
			deriveReleaseImage({
				...base,
				registryPrefix: `${MIRROR}/`,
				kind: "application",
				dockerImage: `${MIRROR}/shop/web:tag`,
			}),
		).toEqual({
			ok: true,
			repositories: [`${MIRROR}/shop/web`],
			source: "running",
		});
	});

	it("(b) refuses an image outside the namespaces, naming them", () => {
		for (const dockerImage of [
			`ghcr.io/org/app@${D}`, // the review's failing input: another repository of the owner
			"nginx:latest",
			`${MIRROR}/shop/web:tag`, // mirror image, but no registry prefix chosen
			`ghcr.io/org/shop/preview/pr-1@${D}`,
		]) {
			const image = deriveReleaseImage({
				...base,
				kind: "application",
				dockerImage,
			});
			expect(image.ok, dockerImage).toBe(false);
			if (image.ok) continue;
			expect(image.message).toContain("ghcr.io/org/shop/");
			expect(image.message).toContain("outside");
			expect(image.message).toContain("registry prefix");
		}
	});

	it("(c) expects <namespace>/<key> when nothing runs yet, under the prefix when mirrored", () => {
		expect(deriveReleaseImage({ ...base, kind: "application" })).toEqual({
			ok: true,
			repositories: ["ghcr.io/org/shop/web"],
			source: "expected",
		});
		expect(
			deriveReleaseImage({
				...base,
				registryPrefix: MIRROR,
				kind: "application",
				dockerImage: null,
			}),
		).toEqual({
			ok: true,
			repositories: [`${MIRROR}/shop/web`],
			source: "expected",
		});
	});

	it("agrees with acceptance: what it derives is what a release may replace", () => {
		const namespaces = ["ghcr.io/org/shop/"];
		const image = deriveReleaseImage({
			...base,
			kind: "application",
			dockerImage: `ghcr.io/org/shop/storefront@${D}`,
		});
		if (!image.ok) throw new Error("unreachable");
		expect(
			checkImageRepository({
				repository: image.repositories[0] as string,
				namespaces,
				currentRepositories: ["ghcr.io/org/shop/storefront"],
			}).ok,
		).toBe(true);
		// And what it refuses is exactly what acceptance would refuse later.
		expect(
			checkImageRepository({
				repository: "ghcr.io/org/shop/web",
				namespaces,
				currentRepositories: ["ghcr.io/org/app"],
			}),
		).toMatchObject({ ok: false, code: "image-repository" });
		expect(
			checkImageRepository({
				repository: "ghcr.io/org/shop/web",
				namespaces,
				currentRepositories: ["nginx"],
			}),
		).toMatchObject({ ok: false, code: "image-repository" });
	});
});

describe("deriveReleaseImage, a compose stack", () => {
	const file = (lines: string[]) => `services:\n${lines.join("\n")}\n`;

	it("keeps the pinned images inside the mirror namespace and ignores the rest", () => {
		const image = deriveReleaseImage({
			...base,
			registryPrefix: MIRROR,
			kind: "compose",
			composeFile: file([
				"  web:",
				`    image: ${MIRROR}/shop/web@${D}`,
				"  worker:",
				`    image: ${MIRROR}/shop/worker@${D}`,
				"  db:",
				`    image: postgres@${D}`,
			]),
		});
		expect(image).toEqual({
			ok: true,
			repositories: [`${MIRROR}/shop/web`, `${MIRROR}/shop/worker`],
			source: "running",
		});
	});

	it("never refuses: nothing pinned, or nothing pinned inside, expects <namespace>/<key>", () => {
		for (const composeFile of [
			"",
			file(["  db:", "    image: postgres:16"]),
			file(["  db:", `    image: postgres@${D}`]),
		]) {
			expect(
				deriveReleaseImage({ ...base, kind: "compose", composeFile }),
			).toEqual({
				ok: true,
				repositories: ["ghcr.io/org/shop/web"],
				source: "expected",
			});
		}
	});
});

describe("the namespace helpers", () => {
	it("expects a lower case name under the owner and repository", () => {
		expect(
			expectedImageRepository({
				owner: "Org",
				repo: "Shop",
				serviceKey: "Web",
				registryPrefix: null,
			}),
		).toBe("ghcr.io/org/shop/web");
	});

	it("holds the namespace itself and preview images outside", () => {
		const ns = ["ghcr.io/org/shop/"];
		expect(isInsideNamespaces("ghcr.io/org/shop/web", ns)).toBe(true);
		expect(isInsideNamespaces("GHCR.io/Org/Shop/Web", ns)).toBe(true);
		expect(isInsideNamespaces("ghcr.io/org/shop/", ns)).toBe(false);
		expect(isInsideNamespaces("ghcr.io/org/shop/preview/x", ns)).toBe(false);
		expect(isInsideNamespaces("ghcr.io/org/shopper/web", ns)).toBe(false);
	});
});
