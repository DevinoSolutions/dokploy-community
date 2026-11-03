import {
	parseDeploymentPayload,
	parsePinnedImage,
	watchedRunUrl,
} from "@dokploy/server/services/github-deployments/payload";
import { describe, expect, it } from "vitest";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/devinosolutions/sendly-web@${DIGEST}`;
const payload = (dokploy: unknown) => ({ dokploy });
/** The repository the watch in these tests follows. */
const WATCHED = { owner: "DevinoSolutions", repo: "sendly" };

describe("parsePinnedImage", () => {
	it("accepts repository@sha256:<64 hex>", () => {
		expect(parsePinnedImage(IMAGE)).toEqual({
			image: IMAGE,
			repository: "ghcr.io/devinosolutions/sendly-web",
			digest: DIGEST,
		});
	});

	it("accepts a registry with a port and Docker Hub style names", () => {
		expect(
			parsePinnedImage(`registry.local:5000/app/api@${DIGEST}`)?.repository,
		).toBe("registry.local:5000/app/api");
		expect(parsePinnedImage(`library/nginx@${DIGEST}`)?.repository).toBe(
			"library/nginx",
		);
	});

	it("drops a tag next to the digest: the digest is what is deployed", () => {
		expect(parsePinnedImage(`ghcr.io/o/r:1.2.3@${DIGEST}`)).toMatchObject({
			image: `ghcr.io/o/r@${DIGEST}`,
		});
	});

	it.each([
		["a tag only", "ghcr.io/o/r:latest"],
		["no digest", "ghcr.io/o/r"],
		["a short digest", "ghcr.io/o/r@sha256:abc"],
		["an upper-case digest", `ghcr.io/o/r@sha256:${"A".repeat(64)}`],
		["another algorithm", `ghcr.io/o/r@sha512:${"a".repeat(64)}`],
		["a space", `ghcr.io/o/r @${DIGEST}`],
		["a shell character", `ghcr.io/o/r;rm -rf /@${DIGEST}`],
		["a second digest", `ghcr.io/o/r@${DIGEST}@${DIGEST}`],
		["an empty repository", `@${DIGEST}`],
		["an upper-case repository", `ghcr.io/O/R@${DIGEST}`],
		["a newline", `ghcr.io/o/r\n@${DIGEST}`],
	])("rejects %s", (_label, value) => {
		expect(parsePinnedImage(value)).toBeNull();
	});

	it("rejects things that are not strings", () => {
		for (const value of [undefined, null, 5, {}, [IMAGE]]) {
			expect(parsePinnedImage(value)).toBeNull();
		}
	});
});

describe("watchedRunUrl", () => {
	const RUN =
		"https://github.com/DevinoSolutions/sendly/actions/runs/123456789";
	it("accepts an Actions run link of the watched repository and drops query, fragment and slash", () => {
		expect(watchedRunUrl(RUN, WATCHED)).toBe(RUN);
		expect(watchedRunUrl(`${RUN}/attempts/2`, WATCHED)).toBe(
			`${RUN}/attempts/2`,
		);
		expect(watchedRunUrl(`${RUN}/?x=1#y`, WATCHED)).toBe(RUN);
	});
	it("compares owner and repo case-insensitively, as GitHub does", () => {
		expect(
			watchedRunUrl(RUN, { owner: "devinosolutions", repo: "SENDLY" }),
		).toBe(RUN);
	});
	it("drops a link to another repository, even a well-formed one", () => {
		expect(
			watchedRunUrl("https://github.com/o/r/actions/runs/1", WATCHED),
		).toBeUndefined();
		expect(
			watchedRunUrl(
				"https://github.com/DevinoSolutions/other/actions/runs/1",
				WATCHED,
			),
		).toBeUndefined();
	});
	it("refuses anything else", () => {
		for (const value of [
			"http://github.com/DevinoSolutions/sendly/actions/runs/1",
			"https://evil.example/DevinoSolutions/sendly/actions/runs/1",
			"https://github.com/DevinoSolutions/sendly/pull/1",
			"javascript:alert(1)",
			42,
			undefined,
		]) {
			expect(watchedRunUrl(value, WATCHED)).toBeUndefined();
		}
	});
});

describe("parseDeploymentPayload", () => {
	it("deploys when it names this service and carries a pinned image", () => {
		const result = parseDeploymentPayload(
			payload({ serviceId: "svc1", image: IMAGE }),
			"svc1",
			WATCHED,
		);
		expect(result).toEqual({
			kind: "deploy",
			image: IMAGE,
			repository: "ghcr.io/devinosolutions/sendly-web",
			digest: DIGEST,
		});
	});

	it("carries the Actions run link when it is valid", () => {
		const runUrl = "https://github.com/DevinoSolutions/sendly/actions/runs/9";
		const result = parseDeploymentPayload(
			payload({ serviceId: "svc1", image: IMAGE, runUrl }),
			"svc1",
			WATCHED,
		);
		expect(result).toMatchObject({ kind: "deploy", buildRunUrl: runUrl });
		const bad = parseDeploymentPayload(
			payload({
				serviceId: "svc1",
				image: IMAGE,
				runUrl: "https://evil.test/x",
			}),
			"svc1",
			WATCHED,
		);
		expect(bad).not.toHaveProperty("buildRunUrl");
		// Well formed, but another repository's run: not the build of this image.
		const foreign = parseDeploymentPayload(
			payload({
				serviceId: "svc1",
				image: IMAGE,
				runUrl: "https://github.com/o/r/actions/runs/9",
			}),
			"svc1",
			WATCHED,
		);
		expect(foreign.kind).toBe("deploy");
		expect(foreign).not.toHaveProperty("buildRunUrl");
	});

	it("reads a payload GitHub returns as a JSON string", () => {
		const result = parseDeploymentPayload(
			JSON.stringify(payload({ serviceId: "svc1", image: IMAGE })),
			"svc1",
			WATCHED,
		);
		expect(result.kind).toBe("deploy");
	});

	it("ignores a deployment for another service, or without a dokploy payload", () => {
		expect(
			parseDeploymentPayload(
				payload({ serviceId: "other", image: IMAGE }),
				"svc1",
				WATCHED,
			).kind,
		).toBe("ignore");
		for (const raw of [
			{},
			null,
			"not json",
			"[]",
			7,
			{ dokploy: "x" },
			{ dokploy: [] },
		]) {
			expect(parseDeploymentPayload(raw, "svc1", WATCHED).kind).toBe("ignore");
		}
	});

	it("never deploys a service id that merely resembles ours", () => {
		for (const serviceId of ["svc1 ", "SVC1", "svc10", 1, null]) {
			expect(
				parseDeploymentPayload(
					payload({ serviceId, image: IMAGE }),
					"svc1",
					WATCHED,
				).kind,
			).toBe("ignore");
		}
	});

	it("rejects (as invalid) an image that is not pinned by digest", () => {
		for (const image of ["ghcr.io/o/r:latest", "ghcr.io/o/r", undefined, 5]) {
			const result = parseDeploymentPayload(
				payload({ serviceId: "svc1", image }),
				"svc1",
				WATCHED,
			);
			expect(result.kind).toBe("invalid");
		}
	});
});
