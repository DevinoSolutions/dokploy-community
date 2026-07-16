import {
	assembleProjectExport,
	PROJECT_EXPORT_VERSION,
	type ProjectExportPayload,
	redactProjectSecrets,
} from "@dokploy/server";
import { describe, expect, it } from "vitest";

type Dict = Record<string, unknown>;

const buildPayload = (): ProjectExportPayload => ({
	project: {
		name: "My Project",
		description: "desc",
		env: "PROJECT_SECRET=abc",
	},
	environments: [
		{
			name: "production",
			description: null,
			env: "ENV_SECRET=xyz",
			services: {
				applications: [
					{
						name: "api",
						dockerImage: "nginx:latest",
						env: "API_KEY=super-secret",
						password: "registry-pass",
						username: "registry-user",
						refreshToken: "rt_123",
						registry: { registryUrl: "ghcr.io", password: "reg-pass" },
					},
				],
				compose: [],
				postgres: [
					{
						name: "db",
						databasePassword: "pg-pass",
						databaseUser: "postgres",
					},
				],
				mysql: [],
				mariadb: [],
				mongo: [],
				redis: [],
				libsql: [],
			},
		},
	],
});

const firstApp = (payload: ProjectExportPayload): Dict =>
	payload.environments[0]?.services.applications[0] as Dict;

const firstPostgres = (payload: ProjectExportPayload): Dict =>
	payload.environments[0]?.services.postgres[0] as Dict;

describe("redactProjectSecrets (#1733)", () => {
	it("nulls secret-bearing keys when includeSecrets is false", () => {
		const redacted = redactProjectSecrets(buildPayload(), false);
		const app = firstApp(redacted);

		expect(app.env).toBeNull();
		expect(app.password).toBeNull();
		expect(app.refreshToken).toBeNull();
		// nested secret is redacted too
		expect((app.registry as Dict).password).toBeNull();
		// project + environment env blobs are redacted
		expect(redacted.project.env).toBeNull();
		expect(redacted.environments[0]?.env).toBeNull();
		expect(firstPostgres(redacted).databasePassword).toBeNull();
	});

	it("keeps non-secret configuration when redacting", () => {
		const redacted = redactProjectSecrets(buildPayload(), false);
		const app = firstApp(redacted);

		expect(app.name).toBe("api");
		expect(app.dockerImage).toBe("nginx:latest");
		// username is not a secret and is preserved
		expect(app.username).toBe("registry-user");
		expect((app.registry as Dict).registryUrl).toBe("ghcr.io");
		expect(firstPostgres(redacted).databaseUser).toBe("postgres");
	});

	it("returns data untouched when includeSecrets is true", () => {
		const result = redactProjectSecrets(buildPayload(), true);
		const app = firstApp(result);

		expect(app.env).toBe("API_KEY=super-secret");
		expect(app.password).toBe("registry-pass");
		expect(result.project.env).toBe("PROJECT_SECRET=abc");
	});
});

describe("assembleProjectExport (#1733)", () => {
	it("wraps the payload in a versioned envelope and redacts by default", () => {
		const result = assembleProjectExport(buildPayload(), false);

		expect(result.version).toBe(PROJECT_EXPORT_VERSION);
		expect(result.includeSecrets).toBe(false);
		expect(typeof result.exportedAt).toBe("string");
		// envelope metadata is never stripped even though "includeSecrets"
		// contains the word "secret"
		expect(result).toHaveProperty("includeSecrets", false);
		const app = result.environments[0]?.services.applications[0] as Dict;
		expect(app.password).toBeNull();
	});

	it("preserves secrets when includeSecrets is true", () => {
		const result = assembleProjectExport(buildPayload(), true);

		expect(result.includeSecrets).toBe(true);
		const app = result.environments[0]?.services.applications[0] as Dict;
		expect(app.password).toBe("registry-pass");
	});
});
