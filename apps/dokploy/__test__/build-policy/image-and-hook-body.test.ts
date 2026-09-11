import { BuildPolicyError } from "@dokploy/server/services/build-policy/errors";
import { parseDeployHookImage } from "@dokploy/server/services/build-policy/hook-body";
import {
	buildDigestRef,
	DIGEST_MARKER,
	imageTagForSha,
	parseImageDigestFromLog,
	parseImageTagFromLog,
	registryHostOf,
	SHA_PLACEHOLDER,
} from "@dokploy/server/services/build-policy/image";
import { describe, expect, it } from "vitest";

describe("imageTagForSha", () => {
	it("tags <app>:<sha>", () => {
		expect(imageTagForSha("sendly-web", "abc123")).toBe("sendly-web:abc123");
	});

	it("uses the placeholder when the sha is resolved in the build shell", () => {
		expect(imageTagForSha("sendly-web")).toBe(`sendly-web:${SHA_PLACEHOLDER}`);
	});
});

describe("buildDigestRef", () => {
	it("drops the tag and pins the digest", () => {
		expect(
			buildDigestRef(
				"ghcr.io/devino/sendly-web:abc123",
				`sha256:${"a".repeat(64)}`,
			),
		).toBe(`ghcr.io/devino/sendly-web@sha256:${"a".repeat(64)}`);
	});

	it("handles a reference with a port in the host", () => {
		expect(
			buildDigestRef(
				"registry.devino.ca:5000/devino/sendly-web:abc123",
				`sha256:${"b".repeat(64)}`,
			),
		).toBe(
			`registry.devino.ca:5000/devino/sendly-web@sha256:${"b".repeat(64)}`,
		);
	});

	it("handles a reference with no tag", () => {
		expect(
			buildDigestRef("ghcr.io/devino/sendly-web", `sha256:${"c".repeat(64)}`),
		).toBe(`ghcr.io/devino/sendly-web@sha256:${"c".repeat(64)}`);
	});

	it("rejects a malformed digest", () => {
		expect(() => buildDigestRef("ghcr.io/a/b:1", "sha256:nope")).toThrow(
			BuildPolicyError,
		);
	});
});

describe("registryHostOf", () => {
	it("reads the host from a reference", () => {
		expect(registryHostOf("ghcr.io/devino/sendly-web:abc")).toBe("ghcr.io");
	});

	it("reads a host with a port", () => {
		expect(registryHostOf("registry.devino.ca:5000/devino/x:abc")).toBe(
			"registry.devino.ca:5000",
		);
	});

	it("returns null for a docker hub short name, which has no host segment", () => {
		expect(registryHostOf("devino/sendly-web:abc")).toBeNull();
		expect(registryHostOf("nginx:alpine")).toBeNull();
	});
});

describe("parseImageDigestFromLog", () => {
	const digest = `sha256:${"d".repeat(64)}`;

	it("reads the digest the build script echoes", () => {
		const log = [
			"Step 1/5 : FROM node:24",
			"✅ Image Pushed",
			`${DIGEST_MARKER} ghcr.io/devino/sendly-web:abc123 ${digest}`,
			"done",
		].join("\n");
		expect(parseImageDigestFromLog(log)).toBe(digest);
		expect(parseImageTagFromLog(log)).toBe("ghcr.io/devino/sendly-web:abc123");
	});

	it("takes the last marker when a log carries several", () => {
		const other = `sha256:${"e".repeat(64)}`;
		const log = [
			`${DIGEST_MARKER} ghcr.io/a/b:1 ${other}`,
			`${DIGEST_MARKER} ghcr.io/a/b:2 ${digest}`,
		].join("\n");
		expect(parseImageDigestFromLog(log)).toBe(digest);
		expect(parseImageTagFromLog(log)).toBe("ghcr.io/a/b:2");
	});

	it("tolerates carriage returns and trailing whitespace", () => {
		const log = `noise\r\n${DIGEST_MARKER} ghcr.io/a/b:1 ${digest}  \r\n`;
		expect(parseImageDigestFromLog(log)).toBe(digest);
	});

	it("returns null when the marker never appeared", () => {
		expect(parseImageDigestFromLog("no marker here")).toBeNull();
		expect(parseImageTagFromLog("no marker here")).toBeNull();
	});

	it("ignores a marker line with a malformed digest", () => {
		expect(
			parseImageDigestFromLog(`${DIGEST_MARKER} ghcr.io/a/b:1 sha256:short`),
		).toBeNull();
	});

	it("handles an empty log", () => {
		expect(parseImageDigestFromLog("")).toBeNull();
		expect(parseImageDigestFromLog(null)).toBeNull();
	});
});

describe("parseDeployHookImage", () => {
	const digest = `sha256:${"f".repeat(64)}`;
	// The unit's OWN repositories, not merely hosts the organization owns.
	// Finding 4 of the PR #209 review: a host allowlist would let any deploy-hook
	// token run any image that happens to sit on ghcr.io.
	const allowed = [
		"ghcr.io/devino/sendly-web",
		"registry.devino.ca/devino/sendly-web",
	];

	it("returns none for an empty body", () => {
		expect(parseDeployHookImage(undefined, allowed)).toEqual({ kind: "none" });
		expect(parseDeployHookImage({}, allowed)).toEqual({ kind: "none" });
		expect(parseDeployHookImage("", allowed)).toEqual({ kind: "none" });
	});

	it("accepts an image that is the unit's own repository and pins the digest", () => {
		expect(
			parseDeployHookImage(
				{ image: "ghcr.io/devino/sendly-web", tag: "abc123", digest },
				allowed,
			),
		).toEqual({
			kind: "image",
			image: "ghcr.io/devino/sendly-web",
			tag: "abc123",
			digest,
			ref: `ghcr.io/devino/sendly-web@${digest}`,
		});
	});

	it("accepts an image whose tag is already embedded", () => {
		expect(
			parseDeployHookImage(
				{ image: "ghcr.io/devino/sendly-web:abc123", digest },
				allowed,
			),
		).toEqual({
			kind: "image",
			image: "ghcr.io/devino/sendly-web:abc123",
			tag: "abc123",
			digest,
			ref: `ghcr.io/devino/sendly-web@${digest}`,
		});
	});

	it("rejects an image on a registry the org did not configure", () => {
		expect(() =>
			parseDeployHookImage(
				{ image: "docker.io/evil/thing", tag: "1", digest },
				allowed,
			),
		).toThrow(/registry/i);
	});

	it("rejects an image with no registry host at all", () => {
		expect(() =>
			parseDeployHookImage({ image: "evil/thing", tag: "1", digest }, allowed),
		).toThrow(/registry/i);
	});

	it("rejects a foreign repository on the unit's own registry host", () => {
		// Same host as the unit's own repository, different repository path.
		// A host-only allowlist accepted this; the unit-repository check must not.
		expect(() =>
			parseDeployHookImage(
				{ image: "ghcr.io/someone-else/backdoor", tag: "1", digest },
				allowed,
			),
		).toThrow(/repository/i);
	});

	it("rejects a repository that merely starts with the unit's own name", () => {
		expect(() =>
			parseDeployHookImage(
				{ image: "ghcr.io/devino/sendly-web-evil", tag: "1", digest },
				allowed,
			),
		).toThrow(/repository/i);
	});

	it("rejects a body with an image but no digest, because deploys are by digest", () => {
		expect(() =>
			parseDeployHookImage(
				{ image: "ghcr.io/devino/sendly-web", tag: "abc" },
				allowed,
			),
		).toThrow(/digest/i);
	});

	it("rejects a malformed digest", () => {
		expect(() =>
			parseDeployHookImage(
				{ image: "ghcr.io/devino/sendly-web", tag: "abc", digest: "abc" },
				allowed,
			),
		).toThrow(/digest/i);
	});

	it("rejects an image that is not a string", () => {
		expect(() => parseDeployHookImage({ image: 42, digest }, allowed)).toThrow(
			BuildPolicyError,
		);
	});

	it("rejects shell metacharacters in the image reference", () => {
		expect(() =>
			parseDeployHookImage(
				{ image: "ghcr.io/devino/x;rm -rf /", tag: "a", digest },
				allowed,
			),
		).toThrow(BuildPolicyError);
	});

	it("rejects every image when the unit has no repository to compare against", () => {
		expect(() =>
			parseDeployHookImage(
				{ image: "ghcr.io/devino/sendly-web", tag: "a", digest },
				[],
			),
		).toThrow(/repository/i);
	});
});
