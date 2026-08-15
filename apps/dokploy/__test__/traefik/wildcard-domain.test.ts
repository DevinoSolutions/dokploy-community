import type { Domain } from "@dokploy/server";
import { createDomainLabels, domain as domainSchema } from "@dokploy/server";
import { apiCreateDomain } from "@dokploy/server/db/schema";
import { createRouterConfig } from "@dokploy/server/utils/traefik/domain";
import { describe, expect, it } from "vitest";

/**
 * Wildcard domains regression suite.
 *
 * 1) Validation: "*.example.com"-style hosts must pass the shared zod schemas
 *    (the UI form AND apiCreateDomain), while malformed wildcards keep being
 *    rejected. Regression for the base hostname refine (VALID_HOSTNAME_REGEX,
 *    upstream #4729 port) firing before the wildcard rules and 400-ing every
 *    wildcard host.
 *
 * 2) Rule generation: wildcard hosts must emit a Traefik v3 HostRegexp with a
 *    plain anchored Go regexp. The old "{subdomain:[a-zA-Z0-9-]+}" named-group
 *    syntax is Traefik v2 only — on v3 (what Dokploy ships) it is an invalid
 *    rule that never matches.
 */

const baseDomain: Domain = {
	host: "app.example.com",
	port: 8080,
	https: true,
	customEntrypoint: null,
	uniqueConfigKey: 1,
	customCertResolver: null,
	certificateType: "letsencrypt",
	applicationId: "app-1",
	composeId: "",
	domainType: "application",
	serviceName: "web",
	domainId: "dom-1",
	path: "/",
	createdAt: "",
	previewDeploymentId: "",
	internalPath: "/",
	stripPath: false,
	middlewares: null,
	forwardAuthEnabled: false,
	publishToCloudflare: false,
	cloudflareTunnelMode: null,
	cloudflareId: null,
	cloudflareZoneId: null,
	cloudflareTunnelId: null,
	cloudflareDnsRecordId: null,
	cloudflareIngressApplied: false,
	enableCloudflareAccess: false,
	cloudflareAccessApplicationId: null,
	enabled: true,
};

const fakeApp = {
	appName: "test-app",
	redirects: [],
	security: [],
} as never;

const parseHost = (host: string) =>
	domainSchema.safeParse({ host, customCertResolver: "" });

const hostError = (host: string) => {
	const result = parseHost(host);
	if (result.success) return null;
	return (
		result.error.issues.find((issue) => issue.path[0] === "host")?.message ??
		null
	);
};

describe("domain schema host validation (UI form + apiCreateDomain path)", () => {
	it.each([
		"example.com",
		"foo.wild.devino.ca",
		"*.wild.devino.ca",
		"*.sub.example.com",
	])("accepts %s", (host) => {
		expect(parseHost(host).success).toBe(true);
	});

	it.each(["bad*.x.com", "*", "*.", "a.*.b.com", "*.*.com", "under_score.com"])(
		"rejects %s",
		(host) => {
			expect(parseHost(host).success).toBe(false);
		},
	);

	it("surfaces the wildcard-specific message for misplaced wildcards", () => {
		expect(hostError("bad*.x.com")).toContain("must start with '*.'");
		expect(hostError("*.*.com")).toContain("Only one wildcard");
	});

	it("apiCreateDomain accepts a wildcard host and rejects a malformed one", () => {
		const valid = apiCreateDomain.safeParse({
			host: "*.wild.devino.ca",
			customCertResolver: "",
			applicationId: "app-1",
		});
		expect(valid.success).toBe(true);

		const invalid = apiCreateDomain.safeParse({
			host: "ba*d.wild.devino.ca",
			customCertResolver: "",
			applicationId: "app-1",
		});
		expect(invalid.success).toBe(false);
	});
});

describe("application file config rule (traefik/domain.ts)", () => {
	it("emits a Traefik v3 anchored Go regexp for wildcard hosts", async () => {
		const config = await createRouterConfig(
			fakeApp,
			{ ...baseDomain, host: "*.wild.devino.ca" },
			"websecure",
		);
		expect(config.rule).toBe(
			"HostRegexp(`^[a-zA-Z0-9-]+\\.wild\\.devino\\.ca\\z`)",
		);
		expect(config.rule).not.toContain("{subdomain:");
	});

	it("keeps plain hosts on Host()", async () => {
		const config = await createRouterConfig(fakeApp, baseDomain, "websecure");
		expect(config.rule).toBe("Host(`app.example.com`)");
	});
});

describe("compose Docker labels rule (docker/domain.ts)", () => {
	it("emits a Traefik v3 anchored Go regexp for wildcard hosts", () => {
		const labels = createDomainLabels(
			"test-app",
			{ ...baseDomain, host: "*.wild.devino.ca" },
			"websecure",
		);
		expect(labels[0]).toBe(
			"traefik.http.routers.test-app-1-websecure.rule=HostRegexp(`^[a-zA-Z0-9-]+\\.wild\\.devino\\.ca\\z`)",
		);
		expect(labels.join("\n")).not.toContain("{subdomain:");
		// A bare `$` would trip docker-compose variable interpolation — the Go
		// regexp must anchor with \z instead.
		expect(labels.join("\n")).not.toContain("$");
	});

	it("keeps plain hosts on Host()", () => {
		const labels = createDomainLabels("test-app", baseDomain, "websecure");
		expect(labels[0]).toBe(
			"traefik.http.routers.test-app-1-websecure.rule=Host(`app.example.com`)",
		);
	});
});
