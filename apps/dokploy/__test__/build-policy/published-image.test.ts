import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding 6 of the PR #209 review: the digest read-back greps the deployment
 * log, and that same file carries the repository's own `docker build` output.
 * A Dockerfile can print a line that looks exactly like the marker. The read
 * must therefore accept only a marker naming the repository this deploy is
 * actually publishing, and only one that is a safe image reference.
 */

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	recordBuildPolicyAudit: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/services/build-policy/audit", () => ({
	recordBuildPolicyAudit: mocks.recordBuildPolicyAudit,
	findPendingBreakGlass: vi.fn(),
	consumeBreakGlass: vi.fn(),
	grantBreakGlass: vi.fn(),
	listBuildPolicyAudit: vi.fn(),
}));

import {
	readPublishedImage,
	requirePublishedImage,
} from "@dokploy/server/services/build-policy/apply";
import { BuildPolicyError } from "@dokploy/server/services/build-policy/errors";
import { DIGEST_MARKER } from "@dokploy/server/services/build-policy/image";

const REPOSITORY = "ghcr.io/devinosolutions/sendly-web";
const DIGEST = `sha256:${"a".repeat(64)}`;
const marker = (tag: string, digest = DIGEST) =>
	`${DIGEST_MARKER} ${tag} ${digest}`;

const logLine = (line: string) => {
	mocks.execAsyncRemote.mockResolvedValue({ stdout: `${line}\n`, stderr: "" });
	mocks.execAsync.mockResolvedValue({ stdout: `${line}\n`, stderr: "" });
};

const read = () =>
	readPublishedImage({
		logPath: "/etc/dokploy/logs/app/deploy.log",
		serverId: "build-server-1",
		expectedRepository: REPOSITORY,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.recordBuildPolicyAudit.mockResolvedValue(null);
});

describe("readPublishedImage", () => {
	it("accepts the marker the push step printed for this repository", async () => {
		logLine(marker(`${REPOSITORY}:abc1234`));
		await expect(read()).resolves.toEqual({
			tag: `${REPOSITORY}:abc1234`,
			digest: DIGEST,
			ref: `${REPOSITORY}@${DIGEST}`,
		});
	});

	it("rejects a forged marker naming a different repository", async () => {
		logLine(marker("evil.example.com/x:latest"));
		await expect(read()).resolves.toBeNull();
	});

	it("rejects a forged marker on the same host but a different repository", async () => {
		logLine(marker("ghcr.io/devinosolutions/other-app:abc1234"));
		await expect(read()).resolves.toBeNull();
	});

	it("rejects a repository that merely prefixes the expected one", async () => {
		logLine(marker(`${REPOSITORY}-evil:abc1234`));
		await expect(read()).resolves.toBeNull();
	});

	it("rejects a marker carrying shell metacharacters", async () => {
		logLine(marker(`${REPOSITORY}:a;rm -rf /`));
		await expect(read()).resolves.toBeNull();
	});

	it("returns null when the build printed no marker at all", async () => {
		logLine("Successfully built 0123456789ab");
		await expect(read()).resolves.toBeNull();
	});

	it("returns null when grep itself failed", async () => {
		mocks.execAsyncRemote.mockRejectedValue(new Error("exit 1"));
		await expect(read()).resolves.toBeNull();
	});
});

describe("requirePublishedImage", () => {
	const plan = {
		enforced: true,
		reason: "remote" as const,
		buildServerId: "build-server-1",
		registryId: "registry-1",
		repository: REPOSITORY,
		tag: "abc1234",
		settings: null,
	};

	it("fails the deploy with DIGEST_NOT_PUBLISHED on a forged marker", async () => {
		logLine(marker("evil.example.com/x:latest"));
		await expect(
			requirePublishedImage({
				plan: plan as never,
				logPath: "/log",
				serverId: "build-server-1",
				organizationId: "org-1",
				applicationId: "app-1",
				unitName: "sendly-web",
			}),
		).rejects.toMatchObject({ code: "DIGEST_NOT_PUBLISHED" });
		expect(mocks.recordBuildPolicyAudit).not.toHaveBeenCalled();
	});

	it("audits the pin when the marker is genuine", async () => {
		logLine(marker(`${REPOSITORY}:abc1234`));
		const published = await requirePublishedImage({
			plan: plan as never,
			logPath: "/log",
			serverId: "build-server-1",
			organizationId: "org-1",
			applicationId: "app-1",
			unitName: "sendly-web",
		});
		expect(published.ref).toBe(`${REPOSITORY}@${DIGEST}`);
		expect(mocks.recordBuildPolicyAudit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "deploy_by_digest" }),
		);
	});

	it("throws a BuildPolicyError, so the deployment records a build error", async () => {
		logLine("nothing here");
		await expect(
			requirePublishedImage({
				plan: plan as never,
				logPath: "/log",
				serverId: "build-server-1",
				organizationId: "org-1",
				applicationId: "app-1",
				unitName: "sendly-web",
			}),
		).rejects.toBeInstanceOf(BuildPolicyError);
	});
});
