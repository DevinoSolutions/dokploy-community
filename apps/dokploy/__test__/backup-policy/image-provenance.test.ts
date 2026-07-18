import { describe, expect, it } from "vitest";
import {
	classifyApplicationProvenance,
	classifyComposeChildImage,
	DEFAULT_REGISTRY_HOST,
	parseRegistryHost,
} from "@/lib/image-provenance";

describe("parseRegistryHost", () => {
	it("defaults bare and namespaced Docker Hub images to docker.io", () => {
		expect(parseRegistryHost("nginx")).toBe("docker.io");
		expect(parseRegistryHost("nginx:1.25")).toBe("docker.io");
		expect(parseRegistryHost("bitnami/nginx")).toBe("docker.io");
		expect(parseRegistryHost("bitnami/nginx:1.25")).toBe("docker.io");
		expect(parseRegistryHost("library/postgres@sha256:deadbeef")).toBe(
			"docker.io",
		);
	});

	it("extracts explicit registry hosts", () => {
		expect(parseRegistryHost("ghcr.io/acme/app")).toBe("ghcr.io");
		expect(parseRegistryHost("ghcr.io/acme/app:1.2.3")).toBe("ghcr.io");
		expect(parseRegistryHost("registry.example.com/team/app")).toBe(
			"registry.example.com",
		);
		expect(parseRegistryHost("registry.example.com/team/app@sha256:abc")).toBe(
			"registry.example.com",
		);
	});

	it("handles host:port and localhost", () => {
		expect(parseRegistryHost("localhost:5000/app")).toBe("localhost:5000");
		expect(parseRegistryHost("registry.local:5000/team/app:tag")).toBe(
			"registry.local:5000",
		);
		// localhost without a slash is an image name, not a host.
		expect(parseRegistryHost("localhost")).toBe("docker.io");
	});

	it("returns null for empty input", () => {
		expect(parseRegistryHost("")).toBeNull();
		expect(parseRegistryHost("   ")).toBeNull();
		expect(parseRegistryHost(null)).toBeNull();
		expect(parseRegistryHost(undefined)).toBeNull();
	});

	it("exposes the default host constant", () => {
		expect(DEFAULT_REGISTRY_HOST).toBe("docker.io");
	});
});

describe("classifyApplicationProvenance", () => {
	it("marks docker-source apps re-pullable with their registry host", () => {
		expect(
			classifyApplicationProvenance({
				sourceType: "docker",
				dockerImage: "ghcr.io/acme/api:1.2",
				registryId: null,
			}),
		).toEqual({
			restorability: "re-pullable",
			image: "ghcr.io/acme/api:1.2",
			registryHost: "ghcr.io",
		});
	});

	it("marks source-built apps with a registry as in-registry", () => {
		expect(
			classifyApplicationProvenance({
				sourceType: "github",
				dockerImage: null,
				registryId: "reg_1",
			}),
		).toEqual({
			restorability: "in-registry",
			image: null,
			registryHost: null,
		});
	});

	it("marks source-built apps without a registry as rebuild-only", () => {
		for (const sourceType of [
			"git",
			"github",
			"gitlab",
			"bitbucket",
			"gitea",
			"drop",
		] as const) {
			expect(
				classifyApplicationProvenance({
					sourceType,
					dockerImage: null,
					registryId: null,
				}).restorability,
			).toBe("rebuild-only");
		}
	});
});

describe("classifyComposeChildImage", () => {
	it("is re-pullable when the child declares an image", () => {
		expect(classifyComposeChildImage({ image: "redis:7" })).toEqual({
			restorability: "re-pullable",
			registryHost: "docker.io",
		});
		expect(classifyComposeChildImage({ image: "ghcr.io/acme/web:1" })).toEqual({
			restorability: "re-pullable",
			registryHost: "ghcr.io",
		});
	});

	it("is rebuild-only when the child has no image (build context)", () => {
		expect(classifyComposeChildImage({ image: null })).toEqual({
			restorability: "rebuild-only",
			registryHost: null,
		});
	});
});
