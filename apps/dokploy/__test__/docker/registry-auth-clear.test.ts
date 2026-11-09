import {
	anonymousRegistryAuth,
	registryHostOfImage,
	registryUrlMatchesImage,
} from "@dokploy/server/utils/docker/registry-auth-clear";
import { describe, expect, it } from "vitest";

// T-15783: swarm keeps the registry auth stored on a service when an update
// carries no X-Registry-Auth header. The helper builds the explicit anonymous
// auth that replaces it, keyed on the registry host of the image.
describe("registryHostOfImage", () => {
	it.each([
		["ghcr.io/devinosolutions/app@sha256:" + "a".repeat(64), "ghcr.io"],
		["localhost:5000/x:tag", "localhost:5000"],
		["localhost/x", "localhost"],
		["nginx:1.27", "docker.io"],
		["nginx", "docker.io"],
		["docker.io/library/nginx", "docker.io"],
		["library/nginx", "docker.io"],
		["Foo/bar:tag", "docker.io"],
		["registry.example.com:8443/team/app", "registry.example.com:8443"],
		["10.43.144.195:5000/img:1", "10.43.144.195:5000"],
	])("%s -> %s", (image, host) => {
		expect(registryHostOfImage(image)).toBe(host);
	});
});

describe("anonymousRegistryAuth", () => {
	it("holds only the server address, so dockerode still sends a header", () => {
		const auth = anonymousRegistryAuth("ghcr.io/a/b@sha256:" + "b".repeat(64));
		expect(auth).toEqual({ serveraddress: "ghcr.io" });
		expect(Object.keys(auth)).toEqual(["serveraddress"]);
	});
});

describe("registryUrlMatchesImage", () => {
	it.each([
		["localhost:5000", "localhost:5000/x:tag", true],
		["https://localhost:5000/", "localhost:5000/x:tag", true],
		["http://LocalHost:5000/v2/", "localhost:5000/x:tag", true],
		["localhost:5000", "ghcr.io/x/y@sha256:abc", false],
		["localhost", "localhost:5000/x", false],
		["ghcr.io", "ghcr.io/x/y", true],
		["docker.io", "nginx:1.27", true],
		["index.docker.io", "nginx:1.27", true],
		["https://registry-1.docker.io", "library/nginx", true],
		["docker.io", "index.docker.io/library/nginx", true],
		["docker.io", "ghcr.io/x/y", false],
		["", "ghcr.io/x/y", false],
		["ghcr.io", "", false],
		[null, "ghcr.io/x/y", false],
	])("%s vs %s -> %s", (registryUrl, image, expected) => {
		expect(registryUrlMatchesImage(registryUrl, image)).toBe(expected);
	});
});
