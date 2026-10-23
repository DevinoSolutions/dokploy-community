import {
	redactServiceSecrets,
	shapeServiceRead,
} from "@dokploy/server/services/service-secrets";
import { describe, expect, it } from "vitest";
import {
	SECRET_MARK,
	secretApplicationRow,
	secretComposeRow,
	secretPostgresRow,
} from "./fixtures";

const leaks = (value: unknown) => JSON.stringify(value).includes(SECRET_MARK);

describe("redactServiceSecrets", () => {
	it("strips every secret from an application row and its relations", () => {
		const row = secretApplicationRow();
		expect(leaks(row)).toBe(true);
		const redacted = redactServiceSecrets(row);
		expect(leaks(redacted)).toBe(false);
		expect(redacted.secretsRedacted).toBe(true);
	});

	it("blanks the row's own value-bearing fields", () => {
		const redacted = redactServiceSecrets(secretApplicationRow());
		for (const field of [
			"env",
			"buildArgs",
			"buildSecrets",
			"previewEnv",
			"previewBuildArgs",
			"previewBuildSecrets",
			"password",
			"refreshToken",
		] as const) {
			expect(redacted[field], field).toBe("");
		}
	});

	it("blanks nested provider, registry, SSH key, server and basic-auth secrets", () => {
		const redacted = redactServiceSecrets(secretApplicationRow());
		expect(redacted.github.githubClientSecret).toBe("");
		expect(redacted.github.githubPrivateKey).toBe("");
		expect(redacted.github.githubWebhookSecret).toBe("");
		expect(redacted.gitlab.secret).toBe("");
		expect(redacted.gitlab.accessToken).toBe("");
		expect(redacted.gitlab.refreshToken).toBe("");
		expect(redacted.bitbucket.appPassword).toBe("");
		expect(redacted.bitbucket.apiToken).toBe("");
		expect(redacted.gitea.clientSecret).toBe("");
		expect(redacted.registry.password).toBe("");
		expect(redacted.buildRegistry.password).toBe("");
		expect(redacted.rollbackRegistry.password).toBe("");
		expect(redacted.customGitSSHKey.privateKey).toBe("");
		expect(redacted.security[0]?.password).toBe("");
		expect(redacted.server.metricsConfig.server.token).toBe("");
		expect(redacted.environment.env).toBe("");
		expect(redacted.environment.project.env).toBe("");
	});

	it("keeps everything that is not a secret", () => {
		const row = secretApplicationRow();
		const redacted = redactServiceSecrets(row);
		expect(redacted.applicationId).toBe("app-1");
		expect(redacted.username).toBe("deploy-user");
		expect(redacted.customGitUrl).toBe("https://git.example.com/org/repo.git");
		expect(redacted.customGitSSHKey.publicKey).toBe(
			row.customGitSSHKey.publicKey,
		);
		expect(redacted.server.metricsConfig.server.port).toBe(4500);
		expect(redacted.github.githubAppName).toBe("my-app");
		expect(redacted.security[0]?.username).toBe("admin");
		expect(redacted.domains).toEqual(row.domains);
		expect(redacted.ports).toEqual(row.ports);
	});

	it("strips a compose row, its backup destinations and backup metadata", () => {
		const redacted = redactServiceSecrets(secretComposeRow());
		expect(leaks(redacted)).toBe(false);
		const backup = redacted.backups[0];
		expect(backup?.destination.encryptionKey).toBe("");
		expect(backup?.destination.encryptionPassword2).toBe("");
		expect(backup?.destination.bucket).toBe("backups");
		expect(backup?.metadata.mariadb.databaseUser).toBe("u");
		expect(backup?.metadata.mariadb.databasePassword).toBe("");
		expect(backup?.metadata.mysql.databaseRootPassword).toBe("");
		expect(redacted.composeFile).toContain("image: nginx");
	});

	it("strips a database row", () => {
		const redacted = redactServiceSecrets(secretPostgresRow());
		expect(leaks(redacted)).toBe(false);
		expect(redacted.databasePassword).toBe("");
		expect(redacted.databaseUser).toBe("app");
	});

	it("does not mutate the row it was given", () => {
		const row = secretApplicationRow();
		redactServiceSecrets(row);
		expect(row.env).toContain(SECRET_MARK);
		expect(row.environment.project.env).toContain(SECRET_MARK);
		expect(row.github.githubClientSecret).toContain(SECRET_MARK);
	});

	it("tolerates missing relations and null columns", () => {
		const redacted = redactServiceSecrets({
			applicationId: "a",
			env: null,
			github: null,
			server: null,
			security: [],
			environment: { env: "", project: null },
		});
		expect(redacted.secretsRedacted).toBe(true);
		expect(redacted.env).toBeNull();
	});
});

describe("shapeServiceRead", () => {
	it("returns the same row for the dashboard default (undefined) and true", () => {
		const row = secretApplicationRow();
		expect(shapeServiceRead(row, undefined)).toBe(row);
		expect(shapeServiceRead(row, true)).toBe(row);
		expect(leaks(shapeServiceRead(row, undefined))).toBe(true);
	});

	it("redacts only when includeEnv is false", () => {
		expect(leaks(shapeServiceRead(secretApplicationRow(), false))).toBe(false);
	});
});
