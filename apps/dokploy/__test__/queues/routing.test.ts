import { describe, expect, it } from "vitest";
import {
	CANCEL_CHANNEL,
	getInflightKey,
	getQueueName,
	getTargetKey,
	LOCAL_TARGET,
} from "../../server/queues/queue-routing";

describe("queue routing", () => {
	it("routes jobs without a serverId to LOCAL_TARGET", () => {
		expect(getTargetKey({ serverId: undefined })).toBe(LOCAL_TARGET);
		expect(getTargetKey({} as { serverId?: string })).toBe(LOCAL_TARGET);
	});

	it("routes jobs with a serverId to that server's key", () => {
		expect(getTargetKey({ serverId: "srv-abc" })).toBe("srv-abc");
	});

	it("routes application jobs by buildServerId when present", () => {
		expect(
			getTargetKey({ serverId: "deploy-srv", buildServerId: "build-srv" }),
		).toBe("build-srv");
	});

	it("preserves canary's 'deployments' queue name for LOCAL_TARGET (upgrade-safe)", () => {
		expect(getQueueName(LOCAL_TARGET)).toBe("deployments");
	});

	it("namespaces remote queues per server (uses __ since BullMQ rejects :)", () => {
		expect(getQueueName("srv-abc")).toBe("deployments__srv-abc");
		expect(getQueueName("srv-xyz")).toBe("deployments__srv-xyz");
	});

	it("never produces a queue name containing : (BullMQ requirement)", () => {
		expect(getQueueName(LOCAL_TARGET)).not.toContain(":");
		expect(getQueueName("srv-with-colons-disallowed")).not.toContain(":");
	});

	it("uses a stable cross-process cancel channel name", () => {
		expect(CANCEL_CHANNEL).toBe("dokploy:deployments:cancel");
	});

	it("namespaces in-flight cancel keys by target queue", () => {
		expect(getInflightKey(LOCAL_TARGET, "1")).toBe("deployments:1");
		expect(getInflightKey("srv-abc", "1")).toBe("deployments__srv-abc:1");
		expect(getInflightKey("srv-xyz", "1")).toBe("deployments__srv-xyz:1");
		expect(getInflightKey("srv-abc", "1")).not.toBe(
			getInflightKey(LOCAL_TARGET, "1"),
		);
	});

	it("treats null/undefined serverId identically (no NaN keys)", () => {
		expect(getTargetKey({ serverId: undefined })).toBe(LOCAL_TARGET);
		expect(getTargetKey({ serverId: null as unknown as undefined })).toBe(
			LOCAL_TARGET,
		);
	});
});
