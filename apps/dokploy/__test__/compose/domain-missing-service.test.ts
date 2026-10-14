import { addDomainToCompose } from "@dokploy/server/utils/docker/domain";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

const compose = {
	appName: "demo-abc123",
	composeFile: `
services:
  web:
    image: nginx:latest
`,
	composePath: "./docker-compose.yml",
	composeType: "docker-compose",
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	randomize: false,
	suffix: "",
	serverId: null,
	sourceType: "raw",
	domains: [],
} as unknown as Parameters<typeof addDomainToCompose>[0];

const domain = (serviceName: string | null) =>
	({
		host: "example.com",
		port: 80,
		path: "/",
		https: false,
		customEntrypoint: null,
		certificateType: "none",
		customCertResolver: null,
		domainType: "compose",
		serviceName,
		uniqueConfigKey: 1,
		internalPath: null,
		stripPath: false,
		enabled: true,
	}) as any;

// Sentry DOKPLOY-COMMUNITY-4X / -4M: the compose page loads
// compose.getConvertedCompose, which threw a plain Error for a domain whose
// service had been removed from the compose file. tRPC reports plain errors as
// INTERNAL_SERVER_ERROR and the API handler sends those to Sentry.
describe("addDomainToCompose domain validation errors", () => {
	it("rejects a domain attached to a missing service as BAD_REQUEST", async () => {
		const error = await addDomainToCompose(compose, [domain("client")]).catch(
			(e) => e,
		);

		expect(error).toBeInstanceOf(TRPCError);
		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(
			'Domain "example.com" is attached to service "client" which does not exist in the compose',
		);
	});

	it("rejects a domain without a service name as BAD_REQUEST", async () => {
		const error = await addDomainToCompose(compose, [domain(null)]).catch(
			(e) => e,
		);

		expect(error).toBeInstanceOf(TRPCError);
		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toBe(
			'Domain "example.com" is missing a service name',
		);
	});

	it("still labels a domain attached to an existing service", async () => {
		const result = await addDomainToCompose(compose, [domain("web")]);

		expect(result?.services?.web?.labels).toBeDefined();
	});
});
