import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The build success/failure senders call the Uptimely hooks without awaiting
 * them: a slow or broken Uptimely must never delay or fail a deploy.
 */

const mocks = vi.hoisted(() => ({
	reportSuccess: vi.fn(),
	reportFailure: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { notifications: { findMany: vi.fn(async () => []) } } },
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@dokploy/server/services/uptimely-deploy", () => ({
	reportDeploySuccessToUptimely: mocks.reportSuccess,
	reportDeployFailureToUptimely: mocks.reportFailure,
}));

const { sendBuildSuccessNotifications } = await import(
	"@dokploy/server/utils/notifications/build-success"
);
const { sendBuildErrorNotifications } = await import(
	"@dokploy/server/utils/notifications/build-error"
);

const successProps = {
	projectName: "Devino",
	applicationName: "web",
	applicationType: "application",
	buildLink: "https://dokploy.test/d",
	organizationId: "org-1",
	domains: [],
	environmentName: "production",
	serviceId: "app-1",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Uptimely deploy hooks in the notification senders", () => {
	it("reports a success without waiting for Uptimely", async () => {
		// Never settles: the sender must still return.
		mocks.reportSuccess.mockReturnValue(new Promise(() => {}));

		await expect(
			sendBuildSuccessNotifications(successProps),
		).resolves.toBeUndefined();

		expect(mocks.reportSuccess).toHaveBeenCalledWith({
			organizationId: "org-1",
			serviceType: "application",
			serviceId: "app-1",
			projectName: "Devino",
			serviceName: "web",
		});
	});

	it("reports a failure with the error and build link, without waiting", async () => {
		mocks.reportFailure.mockReturnValue(new Promise(() => {}));

		await expect(
			sendBuildErrorNotifications({
				projectName: "Devino",
				applicationName: "web",
				applicationType: "compose",
				errorMessage: "boom",
				buildLink: "https://dokploy.test/d",
				organizationId: "org-1",
				serviceId: "cmp-1",
			}),
		).resolves.toBeUndefined();

		expect(mocks.reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				serviceType: "compose",
				serviceId: "cmp-1",
			}),
			{ errorMessage: "boom", buildLink: "https://dokploy.test/d" },
		);
	});

	it("skips the hooks when the caller passes no service id", async () => {
		await sendBuildSuccessNotifications({
			...successProps,
			serviceId: undefined,
		});

		expect(mocks.reportSuccess).not.toHaveBeenCalled();
	});
});
