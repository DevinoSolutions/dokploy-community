import type {
	GhaConnectionRow,
	GhaReleaseRow,
} from "@dokploy/server/services/gha-connect";
import {
	buildConnectionRecord,
	toPendingRelease,
} from "@dokploy/server/services/gha-connect/connection-record";
import { describe, expect, it } from "vitest";

const row = {
	ghaConnectionId: "c1",
	organizationId: "org1",
	serviceType: "compose",
	serviceId: "svc1",
	githubConnectionId: "gh1",
	repoId: 42,
	repoFullName: "acme/shop",
	workflowPath: ".github/workflows/dokploy.yml",
	trackedBranch: "main",
	environment: "production",
	serviceKey: "shop",
	protectionMode: "environment",
	registryPrefix: "registry.devino.ca",
	registryId: "reg1",
	registryProbeHost: "registry.devino.ca",
	gateMode: "checks",
	gateWorkflows: ["CI"],
	gateTimeoutMinutes: 45,
	gateStartedAt: new Date("2026-11-03T10:00:00Z"),
	gateVersion: 9,
	gateBlocked: true,
	state: "blocked",
	stateDetail: "Check test failed",
	deployedSha: "b".repeat(40),
	deployedRunId: 77,
	deployedRunAttempt: 2,
	deployedDigests: [`sha256:${"2".repeat(64)}`, `sha256:${"1".repeat(64)}`],
	processed: [{ runId: 1, attempt: 1, outcome: "accepted", at: "x" }],
} as unknown as GhaConnectionRow;

describe("the poller's read of a connection", () => {
	it("carries every input the deploy gate needs, gateVersion first among them", () => {
		const record = buildConnectionRecord(row, { owner: "acme", repo: "shop" }, [
			"registry.devino.ca/shop/web",
		]);
		expect(record.gate).toEqual({
			ghaConnectionId: "c1",
			state: "blocked",
			gateBlocked: true,
			repoFullName: "acme/shop",
			repoId: 42,
			gateVersion: 9,
			trackedBranch: "main",
			workflowPath: ".github/workflows/dokploy.yml",
			gateMode: "checks",
			gateWorkflows: ["CI"],
			gateTimeoutMinutes: 45,
			gateStartedAt: new Date("2026-11-03T10:00:00Z"),
			deployedSha: "b".repeat(40),
		});
	});

	it("hands acceptance what runs now, with the digests sorted", () => {
		const record = buildConnectionRecord(row, { owner: "acme", repo: "shop" }, [
			"registry.devino.ca/shop/web",
		]);
		expect(record.facts).toMatchObject({
			repoId: 42,
			owner: "acme",
			repo: "shop",
			serviceKey: "shop",
			registryProbeHost: "registry.devino.ca",
			currentRepositories: ["registry.devino.ca/shop/web"],
			deployed: {
				sha: "b".repeat(40),
				runId: 77,
				attempt: 2,
				digests: [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`],
			},
		});
		expect(record.processed).toHaveLength(1);
	});

	it("has nothing deployed before the first release", () => {
		const record = buildConnectionRecord(
			{
				...row,
				deployedSha: null,
				deployedRunId: null,
				deployedRunAttempt: null,
			} as GhaConnectionRow,
			{ owner: "acme", repo: "shop" },
			[],
		);
		expect(record.facts.deployed).toBeNull();
		expect(record.gate.deployedSha).toBeNull();
	});

	it("uses the watch's owner and repo (the name the repository answers to now)", () => {
		const record = buildConnectionRecord(
			row,
			{ owner: "acme", repo: "shop-v2" },
			[],
		);
		expect(record.facts.repo).toBe("shop-v2");
		expect(record.gate.repoFullName).toBe("acme/shop");
	});
});

describe("an accepted release as the gate reads it", () => {
	it("keeps gateCheckedAt exactly as read: the gate's write compares against it", () => {
		const checked = new Date("2026-11-03T11:00:00.123Z");
		const pending = toPendingRelease({
			releaseId: "rel-1",
			manifestReleaseId: "gh-1.1",
			sha: "a".repeat(40),
			runId: 1,
			runAttempt: 1,
			delivery: "pull",
			githubDeploymentId: 11,
			images: [],
			createdAt: new Date("2026-11-03T09:00:00Z"),
			gateState: "waiting",
			gateExpected: { source: "fallback", names: [] },
			gateCheckedAt: checked,
		} as unknown as GhaReleaseRow);
		expect(pending.gateCheckedAt).toBe(checked);
		expect(pending).toMatchObject({
			releaseId: "rel-1",
			gateState: "waiting",
			githubDeploymentId: 11,
		});
	});
});
