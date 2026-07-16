import {
	getPredefinedEnvVariables,
	mergePredefinedEnvVariables,
	prepareEnvironmentVariables,
} from "@dokploy/server/index";
import { describe, expect, it } from "vitest";

const baseApplication = {
	applicationId: "app-123",
	appName: "my-app-abc123",
	name: "My App",
	branch: "main",
	sourceType: "github",
	dockerImage: null as string | null,
	environment: {
		name: "production",
		project: {
			name: "My Project",
		},
	},
};

describe("getPredefinedEnvVariables", () => {
	it("provides identity vars even without a domain", () => {
		const vars = getPredefinedEnvVariables(baseApplication, null);

		expect(vars).toMatchObject({
			DOKPLOY_APPLICATION_ID: "app-123",
			DOKPLOY_CONTAINER_NAME: "my-app-abc123",
			DOKPLOY_APP_NAME: "My App",
			DOKPLOY_PROJECT_NAME: "My Project",
			DOKPLOY_ENVIRONMENT_NAME: "production",
			DOKPLOY_BRANCH: "main",
		});
		expect(vars.DOKPLOY_FQDN).toBeUndefined();
		expect(vars.DOKPLOY_URL).toBeUndefined();
		expect(vars.DOKPLOY_PORT).toBeUndefined();
	});

	it("derives FQDN, URL and PORT from an https domain", () => {
		const vars = getPredefinedEnvVariables(baseApplication, {
			host: "example.com",
			https: true,
			port: 443,
		});

		expect(vars.DOKPLOY_FQDN).toBe("example.com");
		expect(vars.DOKPLOY_URL).toBe("https://example.com");
		expect(vars.DOKPLOY_PORT).toBe("443");
	});

	it("uses the http scheme when the domain is not https", () => {
		const vars = getPredefinedEnvVariables(baseApplication, {
			host: "app.local",
			https: false,
			port: 80,
		});

		expect(vars.DOKPLOY_URL).toBe("http://app.local");
	});

	it("omits DOKPLOY_PORT when the domain has no port", () => {
		const vars = getPredefinedEnvVariables(baseApplication, {
			host: "example.com",
			https: true,
			port: null,
		});

		expect(vars.DOKPLOY_FQDN).toBe("example.com");
		expect(vars.DOKPLOY_PORT).toBeUndefined();
	});

	it("omits DOKPLOY_BRANCH for docker-source apps and adds the image tag", () => {
		const vars = getPredefinedEnvVariables(
			{
				...baseApplication,
				sourceType: "docker",
				branch: null,
				dockerImage: "nginx:1.25",
			},
			null,
		);

		expect(vars.DOKPLOY_BRANCH).toBeUndefined();
		expect(vars.DOKPLOY_IMAGE_TAG).toBe("1.25");
	});

	it("defaults the image tag to latest and strips any registry host[:port]", () => {
		expect(
			getPredefinedEnvVariables(
				{ ...baseApplication, sourceType: "docker", dockerImage: "nginx" },
				null,
			).DOKPLOY_IMAGE_TAG,
		).toBe("latest");

		expect(
			getPredefinedEnvVariables(
				{
					...baseApplication,
					sourceType: "docker",
					dockerImage: "registry.example.com:5000/team/app:v2",
				},
				null,
			).DOKPLOY_IMAGE_TAG,
		).toBe("v2");

		expect(
			getPredefinedEnvVariables(
				{
					...baseApplication,
					sourceType: "docker",
					dockerImage: "nginx@sha256:0000000000000000000000000000000000000000",
				},
				null,
			).DOKPLOY_IMAGE_TAG,
		).toBe("latest");
	});
});

describe("mergePredefinedEnvVariables + prepareEnvironmentVariables", () => {
	const predefined = {
		DOKPLOY_FQDN: "example.com",
		DOKPLOY_URL: "https://example.com",
	};

	it("exposes predefined vars in the resolved container env", () => {
		const resolved = prepareEnvironmentVariables(
			mergePredefinedEnvVariables(predefined, "NODE_ENV=production"),
			"",
			"",
		);

		expect(resolved).toContain("DOKPLOY_FQDN=example.com");
		expect(resolved).toContain("DOKPLOY_URL=https://example.com");
		expect(resolved).toContain("NODE_ENV=production");
	});

	it("resolves ${{DOKPLOY_URL}} references coming from user env", () => {
		const resolved = prepareEnvironmentVariables(
			mergePredefinedEnvVariables(predefined, "NEXTAUTH_URL=${{DOKPLOY_URL}}"),
			"",
			"",
		);

		expect(resolved).toContain("NEXTAUTH_URL=https://example.com");
	});

	it("lets an explicit user value override a predefined var (no duplicates)", () => {
		const resolved = prepareEnvironmentVariables(
			mergePredefinedEnvVariables(
				predefined,
				"DOKPLOY_URL=https://custom.example",
			),
			"",
			"",
		);

		expect(resolved).toContain("DOKPLOY_URL=https://custom.example");
		expect(
			resolved.filter((line) => line.startsWith("DOKPLOY_URL=")),
		).toHaveLength(1);
	});

	it("no-ops cleanly when the user env is empty", () => {
		const resolved = prepareEnvironmentVariables(
			mergePredefinedEnvVariables(predefined, ""),
			"",
			"",
		);

		expect(resolved).toContain("DOKPLOY_FQDN=example.com");
		expect(resolved).toContain("DOKPLOY_URL=https://example.com");
	});
});
