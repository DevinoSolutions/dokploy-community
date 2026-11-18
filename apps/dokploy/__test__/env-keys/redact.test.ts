import {
	redactRegistryAwsKeys,
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
		expect(redacted.gitlab.webhookSecret).toBe("");
		expect(redacted.bitbucket.appPassword).toBe("");
		expect(redacted.bitbucket.apiToken).toBe("");
		expect(redacted.gitea.clientSecret).toBe("");
		expect(redacted.registry.password).toBe("");
		expect(redacted.registry.awsSecretAccessKey).toBe("");
		expect(redacted.registry.awsAccessKeyId).toBe("");
		expect(redacted.buildRegistry.awsSecretAccessKey).toBe("");
		expect(redacted.rollbackRegistry.awsSecretAccessKey).toBe("");
		// What identifies the registry stays readable.
		expect(redacted.registry.awsRegion).toBe("us-east-1");
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
		// Raw rclone flags can carry a header or a token: emptied, still a list.
		expect(backup?.destination.additionalFlags).toEqual([]);
		expect(JSON.stringify(redacted)).not.toContain("FLAGVALUE");
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

describe("redactRegistryAwsKeys", () => {
	it("blanks the secret key and, unless kept, the access key id of all three registries", () => {
		const row = secretApplicationRow();
		const withoutId = redactRegistryAwsKeys(row, { keepAccessKeyId: false });
		const withId = redactRegistryAwsKeys(row, { keepAccessKeyId: true });
		for (const relation of [
			"registry",
			"buildRegistry",
			"rollbackRegistry",
		] as const) {
			expect(withoutId[relation].awsSecretAccessKey, relation).toBe("");
			expect(withoutId[relation].awsAccessKeyId, relation).toBe("");
			expect(withId[relation].awsSecretAccessKey, relation).toBe("");
			expect(withId[relation].awsAccessKeyId, relation).toBe(
				row[relation].awsAccessKeyId,
			);
		}
	});

	it("leaves the rest of the registry and of the row alone and does not mutate it", () => {
		const row = secretApplicationRow();
		const result = redactRegistryAwsKeys(row, { keepAccessKeyId: false });
		expect(result.registry.registryId).toBe("reg-1");
		expect(result.registry.awsRegion).toBe("us-east-1");
		expect(result.env).toBe(row.env);
		expect(result.github).toBe(row.github);
		expect(row.registry.awsSecretAccessKey).toBe("SECRET-aws-secret");
	});

	it("tolerates a missing, null or key-less registry", () => {
		const bare = { applicationId: "a" };
		expect(redactRegistryAwsKeys(bare, { keepAccessKeyId: false })).toBe(bare);
		const nulls = redactRegistryAwsKeys(
			{
				registry: null,
				buildRegistry: { registryId: "r", awsSecretAccessKey: null },
			},
			{ keepAccessKeyId: false },
		);
		expect(nulls.registry).toBeNull();
		expect(nulls.buildRegistry.awsSecretAccessKey).toBeNull();
	});
});
