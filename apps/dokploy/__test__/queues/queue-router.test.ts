import { describe, expect, test } from "vitest";
import {
	isJobForApplication,
	isJobForCompose,
	LOCAL_TARGET,
	resolveServiceKey,
	resolveTargetKey,
} from "../../server/queues/queue-router";
import type { DeploymentJob } from "../../server/queues/queue-types";

const baseApplication = {
	applicationId: "app-1",
	titleLog: "t",
	descriptionLog: "d",
	type: "deploy" as const,
	applicationType: "application" as const,
};

const basePreview = {
	applicationId: "app-2",
	titleLog: "t",
	descriptionLog: "d",
	type: "deploy" as const,
	applicationType: "application-preview" as const,
	previewDeploymentId: "prev-1",
};

const baseCompose = {
	composeId: "comp-1",
	titleLog: "t",
	descriptionLog: "d",
	type: "deploy" as const,
	applicationType: "compose" as const,
};

describe("resolveTargetKey", () => {
	test("application: buildServerId wins over serverId", () => {
		const job: DeploymentJob = {
			...baseApplication,
			serverId: "srv-deploy",
			buildServerId: "srv-build",
		};
		expect(resolveTargetKey(job)).toBe("srv-build");
	});

	test("application: falls back to serverId when no buildServerId", () => {
		const job: DeploymentJob = { ...baseApplication, serverId: "srv-deploy" };
		expect(resolveTargetKey(job)).toBe("srv-deploy");
	});

	test("application: falls back to local when neither id is set", () => {
		expect(resolveTargetKey(baseApplication)).toBe(LOCAL_TARGET);
	});

	test("application-preview: buildServerId wins (regression for upstream #3744)", () => {
		const job: DeploymentJob = {
			...basePreview,
			serverId: "srv-deploy",
			buildServerId: "srv-build",
		};
		expect(resolveTargetKey(job)).toBe("srv-build");
	});

	test("application-preview: falls back to serverId", () => {
		const job: DeploymentJob = { ...basePreview, serverId: "srv-deploy" };
		expect(resolveTargetKey(job)).toBe("srv-deploy");
	});

	test("application-preview: falls back to local", () => {
		expect(resolveTargetKey(basePreview)).toBe(LOCAL_TARGET);
	});

	test("compose: uses serverId", () => {
		const job: DeploymentJob = { ...baseCompose, serverId: "srv-deploy" };
		expect(resolveTargetKey(job)).toBe("srv-deploy");
	});

	test("compose: falls back to local", () => {
		expect(resolveTargetKey(baseCompose)).toBe(LOCAL_TARGET);
	});
});

describe("resolveServiceKey", () => {
	test("application keyed by applicationId", () => {
		expect(resolveServiceKey(baseApplication)).toBe("application:app-1");
	});

	test("application-preview keyed by previewDeploymentId (distinct from parent app)", () => {
		expect(resolveServiceKey(basePreview)).toBe("preview:prev-1");
	});

	test("compose keyed by composeId", () => {
		expect(resolveServiceKey(baseCompose)).toBe("compose:comp-1");
	});

	test("same application with different type is same service key (prevents race)", () => {
		expect(resolveServiceKey(baseApplication)).toBe(
			resolveServiceKey({ ...baseApplication, type: "redeploy" }),
		);
	});
});

describe("isJobForApplication", () => {
	test("matches plain application", () => {
		expect(isJobForApplication(baseApplication, "app-1")).toBe(true);
	});

	test("matches preview of same parent app (regression for upstream #3744 queue summary)", () => {
		expect(isJobForApplication(basePreview, "app-2")).toBe(true);
	});

	test("rejects different applicationId", () => {
		expect(isJobForApplication(baseApplication, "app-other")).toBe(false);
	});

	test("rejects compose", () => {
		expect(isJobForApplication(baseCompose, "app-1")).toBe(false);
	});
});

describe("isJobForCompose", () => {
	test("matches compose by composeId", () => {
		expect(isJobForCompose(baseCompose, "comp-1")).toBe(true);
	});

	test("rejects application", () => {
		expect(isJobForCompose(baseApplication, "comp-1")).toBe(false);
	});
});
