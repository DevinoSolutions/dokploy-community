import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `recordRegistryAccessFailure` keeps the reason a GitHub Actions release deploy failed on the deployment row
// when the registry refused the image (T-15783), so the connection poll can retry the release instead of
// failing it. Everything else about a failed deploy stays as it was.
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

const { recordRegistryAccessFailure } = await import(
	"@dokploy/server/services/deployment-error-message"
);
const { runInJobContext, markDeploymentReleased } = await import(
	"@dokploy/server/utils/process/job-context"
);

const DENIED = new Error(
	'Container did not stay running after deployment: Task rejected: Get "https://ghcr.io/v2/o/r/landing/manifests/sha256:a": denied: denied',
);

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordRegistryAccessFailure", () => {
	it("stores the message of a registry refusal", async () => {
		await recordRegistryAccessFailure("dep-1", DENIED);
		expect(mocks.set).toHaveBeenCalledWith({ errorMessage: DENIED.message });
	});

	it("only touches the rows of a GitHub Actions release (title GHA ...)", async () => {
		await recordRegistryAccessFailure("dep-1", DENIED);
		const { sql, params } = new PgDialect().sqlToQuery(
			mocks.where.mock.calls[0]?.[0],
		);
		expect(sql).toContain('"title" like');
		expect(params).toContain("GHA %");
		expect(params).toContain("dep-1");
	});

	it("does nothing for any other failure", async () => {
		await recordRegistryAccessFailure(
			"dep-1",
			new Error(
				"Container did not stay running after deployment: Task failed: exec: node: not found",
			),
		);
		await recordRegistryAccessFailure(
			"dep-1",
			"Error building, check the logs.",
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does nothing for a deployment the watchdog released", async () => {
		markDeploymentReleased("dep-released");
		await recordRegistryAccessFailure("dep-released", DENIED);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("does nothing for a job the watchdog released", async () => {
		await runInJobContext({ isReleased: () => true }, () =>
			recordRegistryAccessFailure("dep-1", DENIED),
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("never throws when the write fails", async () => {
		mocks.where.mockImplementationOnce(() => {
			throw new Error("db down");
		});
		await expect(
			recordRegistryAccessFailure("dep-1", DENIED),
		).resolves.toBeUndefined();
	});
});
