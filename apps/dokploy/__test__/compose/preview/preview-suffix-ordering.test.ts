import { addDomainToCompose } from "@dokploy/server/utils/docker/domain";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	buildComposePreviewSuffix,
	mapPreviewDomainsToSuffixedServices,
} from "@dokploy/server/services/preview-deployment";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const composeFile = `
services:
  web:
    image: nginx:latest
    depends_on:
      - api
  api:
    image: node:20
    volumes:
      - api-data:/data
volumes:
  api-data:
networks:
  default:
`;

const previewDomain = (serviceName: string, host: string) =>
	({
		host,
		port: 80,
		path: "/",
		https: false,
		customEntrypoint: null,
		certificateType: "none",
		customCertResolver: null,
		domainType: "preview",
		serviceName,
		internalPath: null,
		stripPath: false,
	}) as any;

const previewEntity = (suffix: string, domains: unknown[]) =>
	({
		appName: "preview-myapp-abc123",
		composeFile,
		composePath: "./docker-compose.yml",
		composeType: "docker-compose",
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		randomize: true,
		suffix,
		serverId: null,
		sourceType: "raw",
		domains,
	}) as unknown as Parameters<typeof addDomainToCompose>[0];

describe("compose preview suffix ordering", () => {
	it("derives a deterministic, per-PR suffix from immutable row fields", () => {
		const suffix = buildComposePreviewSuffix({
			pullRequestNumber: "42",
			previewDeploymentId: "abcdef1234567890",
		});
		expect(suffix).toBe("pr42-abcdef12");
		// Stable across calls (create → deploy → teardown).
		expect(
			buildComposePreviewSuffix({
				pullRequestNumber: "42",
				previewDeploymentId: "abcdef1234567890",
			}),
		).toBe(suffix);
	});

	it("re-points preview domains at the suffixed service keys", () => {
		const mapped = mapPreviewDomainsToSuffixedServices(
			[{ serviceName: "web" }, { serviceName: "api" }],
			"",
			"pr42-abcdef12",
		);
		expect(mapped.map((domain) => domain.serviceName)).toEqual([
			"web-pr42-abcdef12",
			"api-pr42-abcdef12",
		]);
	});

	it("strips the base compose suffix before appending the preview suffix", () => {
		// The base compose randomizes with its own suffix, so its stored domain
		// serviceNames carry it; the preview re-randomizes the original spec.
		const mapped = mapPreviewDomainsToSuffixedServices(
			[{ serviceName: "web-base1" }],
			"base1",
			"pr42-abcdef12",
		);
		expect(mapped[0]?.serviceName).toBe("web-pr42-abcdef12");
	});

	it("writes Traefik labels onto the randomized services without throwing", async () => {
		const previewSuffix = buildComposePreviewSuffix({
			pullRequestNumber: "42",
			previewDeploymentId: "abcdef1234567890",
		});
		const domains = mapPreviewDomainsToSuffixedServices(
			[
				previewDomain("web", "myapp-web-pr42.example.com"),
				previewDomain("api", "myapp-api-pr42.example.com"),
			],
			"",
			previewSuffix,
		);

		const converted = await addDomainToCompose(
			previewEntity(previewSuffix, domains),
			domains as any,
		);

		expect(converted).not.toBeNull();
		// The randomize pass renamed the service keys ...
		expect(converted?.services?.[`web-${previewSuffix}`]).toBeDefined();
		expect(converted?.services?.[`api-${previewSuffix}`]).toBeDefined();
		expect(converted?.services?.web).toBeUndefined();
		// ... and the preview domains resolved onto the renamed services.
		const webLabels = converted?.services?.[`web-${previewSuffix}`]
			?.labels as string[];
		expect(
			webLabels.some((label) =>
				label.includes("Host(`myapp-web-pr42.example.com`)"),
			),
		).toBe(true);
		const apiLabels = converted?.services?.[`api-${previewSuffix}`]
			?.labels as string[];
		expect(
			apiLabels.some((label) =>
				label.includes("Host(`myapp-api-pr42.example.com`)"),
			),
		).toBe(true);
	});

	it("throws when a preview domain still points at the pre-randomize service name", async () => {
		// Guard for the highest-risk regression: writing domains AFTER randomize
		// with un-suffixed service names must fail loudly, not silently drop labels.
		const domains = [previewDomain("web", "myapp-web-pr42.example.com")];

		await expect(
			addDomainToCompose(previewEntity("pr42-abcdef12", domains), domains),
		).rejects.toThrow(/does not exist in the compose/);
	});

	it("isolates two PRs of the same compose: disjoint service, volume and network names", () => {
		// Parse fresh per PR — the preview build path re-clones the spec per deploy.
		const prOne = randomizeSpecificationFile(parse(composeFile), "pr1-aaaaaaaa");
		const prTwo = randomizeSpecificationFile(parse(composeFile), "pr2-bbbbbbbb");

		const serviceOverlap = Object.keys(prOne.services ?? {}).filter((name) =>
			Object.keys(prTwo.services ?? {}).includes(name),
		);
		expect(serviceOverlap).toEqual([]);

		const volumeOverlap = Object.keys(prOne.volumes ?? {}).filter((name) =>
			Object.keys(prTwo.volumes ?? {}).includes(name),
		);
		expect(volumeOverlap).toEqual([]);

		const networkOverlap = Object.keys(prOne.networks ?? {}).filter((name) =>
			Object.keys(prTwo.networks ?? {}).includes(name),
		);
		expect(networkOverlap).toEqual([]);

		// Volumes of the preview are never those of the base stack either.
		expect(Object.keys(prOne.volumes ?? {})).not.toContain("api-data");

		// depends_on references follow the renamed services.
		expect(
			(prOne.services?.["web-pr1-aaaaaaaa"]?.depends_on as string[])?.[0],
		).toBe("api-pr1-aaaaaaaa");
	});
});
