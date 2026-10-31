import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `recordVaultFailureReason` puts a vault resolution failure on the deployment
// row (T-11775). These cases cover what the deploy-path tests do not: what is
// stored (redacted), when it is written (only while the row is `error`), and
// the paths where it must do nothing or must not throw.
const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		update: (...args: unknown[]) => {
			mocks.update(...args);
			return {
				set: (values: unknown) => {
					mocks.set(values);
					return {
						where: (condition: unknown) => {
							mocks.where(condition);
							return Promise.resolve([]);
						},
					};
				},
			};
		},
	},
}));

const { recordVaultFailureReason } = await import(
	"@dokploy/server/services/deployment-error-message"
);
const { VaultResolutionError } = await import(
	"@dokploy/server/utils/vault/errors"
);
const { runInJobContext, markDeploymentReleased } = await import(
	"@dokploy/server/utils/process/job-context"
);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordVaultFailureReason", () => {
	it("stores the vault message", async () => {
		await recordVaultFailureReason(
			"dep-1",
			new VaultResolutionError('Vault provider "prov" not found'),
		);

		expect(mocks.set).toHaveBeenCalledWith({
			errorMessage: 'Vault provider "prov" not found',
		});
	});

	it("stores the message of a vault error wrapped on the way up", async () => {
		await recordVaultFailureReason(
			"dep-1",
			new Error("deploy failed", {
				cause: new VaultResolutionError("HashiCorp Vault: boom"),
			}),
		);

		expect(mocks.set).toHaveBeenCalledWith({
			errorMessage: "HashiCorp Vault: boom",
		});
	});

	it("masks credentials in a URL carried by the provider's own error", async () => {
		await recordVaultFailureReason(
			"dep-1",
			new VaultResolutionError(
				"Request cannot be constructed from a URL that includes credentials: https://svc:hunter2@vault.example.com/v1/secret/data/app",
			),
		);

		const stored = mocks.set.mock.calls[0]?.[0].errorMessage as string;
		expect(stored).not.toContain("hunter2");
		expect(stored).toContain("https://svc:[REDACTED]@vault.example.com");
	});

	it("only writes while the row is still `error`", async () => {
		await recordVaultFailureReason(
			"dep-1",
			new VaultResolutionError("HashiCorp Vault: boom"),
		);

		const { sql, params } = new PgDialect().sqlToQuery(
			mocks.where.mock.calls[0]?.[0],
		);
		expect(sql).toMatch(/"deploymentId" = \$1/);
		expect(sql).toMatch(/"status" = \$2/);
		expect(params).toEqual(["dep-1", "error"]);
	});

	it("does nothing for an error that is not a vault failure", async () => {
		await recordVaultFailureReason("dep-1", new Error("boom"));
		await recordVaultFailureReason("dep-1", "not even an error");

		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does nothing for a job the watchdog released", async () => {
		await runInJobContext({ isReleased: () => true }, () =>
			recordVaultFailureReason(
				"dep-1",
				new VaultResolutionError("HashiCorp Vault: boom"),
			),
		);

		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does nothing for a deployment the watchdog released", async () => {
		markDeploymentReleased("dep-released");

		await recordVaultFailureReason(
			"dep-released",
			new VaultResolutionError("HashiCorp Vault: boom"),
		);

		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("swallows a database error instead of masking the deploy error", async () => {
		mocks.where.mockImplementationOnce(() => {
			throw new Error("connection lost");
		});

		await expect(
			recordVaultFailureReason(
				"dep-1",
				new VaultResolutionError("HashiCorp Vault: boom"),
			),
		).resolves.toBeUndefined();
		expect(console.error).toHaveBeenCalled();
	});
});
